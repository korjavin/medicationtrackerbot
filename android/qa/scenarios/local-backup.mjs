// Auto Backup proof for the shipped rules (bd med-nt9p.32.5, docs/android.md → Local mode
// backup): a cloud-mode session AND a local-origin session write marker data, then bmgr backupnow
// → pm clear → bmgr restore. PASS = the local marker is back AND nothing of the account origin,
// Local Storage or any prefs file but wg_trial.xml is in the backup set or the restored data dir.
// Local data comes from the debug LocalSpikeActivity (the same asset origin the shell's local mode
// uses) until the real local mode (bd med-nt9p.32.4) lands. Not in `all`: it ends with pm clear.

const LOCAL_ACTIVITY = 'com.example.medtracker.LocalSpikeActivity';
const MARK = `qa-backup-${Date.now()}`;

/** Write `value` into an IndexedDB store of the attached page's origin (and Local Storage). */
const putMarker = (page, value) => page.evaluate((v) => new Promise((res, rej) => {
  localStorage.setItem('wg-qa-backup', v);
  const open = indexedDB.open('wg-qa-backup', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('m');
  open.onerror = () => rej(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('m', 'readwrite');
    tx.objectStore('m').put(v, 'marker');
    tx.oncomplete = () => { open.result.close(); res(true); };
    tx.onerror = () => rej(tx.error);
  };
}), value);

const getMarker = (page) => page.evaluate(() => new Promise((res) => {
  const open = indexedDB.open('wg-qa-backup', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('m');
  open.onerror = () => res(`error ${open.error}`);
  open.onsuccess = () => {
    const req = open.result.transaction('m').objectStore('m').get('marker');
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => res(`error ${req.error}`);
  };
}));

export default async function localBackup(ctx) {
  const { shell, pkg, log } = ctx;
  const r = (ctx.results.localBackup = { api: await shell('getprop ro.build.version.sdk') });
  const ls = (paths) => shell(`run-as ${pkg} find ${paths} -maxdepth 4 2>&1 | sort`);
  const local = async () => {
    await shell(`am force-stop ${pkg}`);
    await ctx.sleep(2000); // the dead process's devtools socket must go before attaching
    await shell(`am start -W -n ${pkg}/${LOCAL_ACTIVITY}`);
    const page = await ctx.attachPage();
    if (!page || !page.url().startsWith('https://appassets.androidplatform.net/')) throw new Error(`not on the local origin: ${page?.url()}`);
    // The spike page reloads itself once (its check 13): wait for its report before touching it.
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const st = await page.evaluate(() => document.getElementById('status')?.textContent || '').catch(() => '');
      if (/Automatic checks done/.test(st)) return page;
      await ctx.sleep(1000);
    }
    throw new Error('local page never finished loading');
  };

  // 1. Cloud mode: the account origin gets an IndexedDB db + Local Storage key, the shell its prefs.
  const cloudHost = await ctx.step('cloud session writes account-origin data', async () => {
    const page = await ctx.openClaim();
    const host = new URL(page.url()).host;
    await putMarker(page, `cloud-${MARK}`);
    return host;
  });
  r.cloudHost = cloudHost;
  const hostDir = `https_${cloudHost}_0`;

  // 2. Local origin: the data that must survive.
  await ctx.step('local session writes local-origin data', async () => putMarker(await local(), `local-${MARK}`));

  r.before = await ls('app_webview/Default shared_prefs');
  if (!r.before.includes(hostDir)) throw new Error(`no account-origin dir before backup:\n${r.before}`);
  if (!r.before.includes('https_appassets.androidplatform.net_0.indexeddb.leveldb')) throw new Error('no local-origin dir before backup');

  // 3. Backup on the local transport. The app stays running: bmgr refuses a stopped package.
  //    is_encrypted=true: the cloud-backup rules say disableIfNoEncryptionCapabilities.
  await ctx.step('bmgr backupnow', async () => {
    await shell('bmgr enable true');
    await shell('bmgr transport com.android.localtransport/.LocalTransport');
    await shell("settings put secure backup_local_transport_parameters 'is_encrypted=true'");
    r.backupnow = await shell(`bmgr backupnow ${pkg}`);
    r.bytes = Number((/progress: \d+\/(\d+)/.exec(r.backupnow) || [])[1] || 0);
    if (!/Success/i.test(r.backupnow)) throw new Error(`backupnow: ${r.backupnow}`);
  });

  // 4. The backup set itself (adb root, run.sh): LocalTransport keeps the full-backup tar stream
  //    under /data/cache/backup. Its entry names carry the origin dir names.
  await ctx.step('backup set holds no account-origin data', async () => {
    const files = (await shell(`find /data/cache/backup -path '*${pkg}*' -type f 2>/dev/null`)).split('\n').filter(Boolean);
    r.setFiles = files;
    if (!files.length) throw new Error('no backup file for the package under /data/cache/backup');
    const entries = [];
    for (const f of files) {
      entries.push(...(await shell(`tar -tf '${f}' 2>/dev/null`)).split('\n').filter(Boolean));
      const hits = await shell(`grep -c '${cloudHost.replace(/\./g, '\\.')}\\|Local Storage\\|shell\\.xml\\|diag\\.xml' '${f}' || true`);
      if (hits !== '0') throw new Error(`${f}: ${hits} hit(s) of the account host / Local Storage / prefs`);
    }
    r.setEntries = entries;
    const bad = entries.filter((e) => !/appassets\.androidplatform\.net_0\.indexeddb|wg_trial\.xml|_manifest$|_meta$/.test(e) && !e.endsWith('/'));
    if (bad.length) throw new Error(`unexpected entries in the backup set: ${bad.join(', ')}`);
    if (entries.length && !entries.some((e) => e.includes('appassets.androidplatform.net_0.indexeddb.leveldb'))) throw new Error('local-origin IndexedDB missing from the backup set');
  });

  // 5. Wipe, restore, look at what came back.
  await ctx.step('pm clear → bmgr restore', async () => {
    await shell(`pm clear ${pkg}`);
    r.afterClear = await ls('app_webview shared_prefs');
    r.restore = await shell(`bmgr restore 1 ${pkg}`);
    r.afterRestore = await ls('app_webview shared_prefs');
    log('restored:\n' + r.afterRestore);
  });
  await ctx.step('restored data dir holds no account-origin data', async () => {
    const leaked = r.afterRestore.split('\n').filter((l) => l.includes(cloudHost) || /Local Storage|shared_prefs\/(?!wg_trial\.xml)./.test(l));
    if (leaked.length) throw new Error(`restored outside the include list: ${leaked.join(', ')}`);
    if (!r.afterRestore.includes('https_appassets.androidplatform.net_0.indexeddb.leveldb')) throw new Error('local-origin IndexedDB not restored');
  });

  // 6. The local marker is back in the WebView.
  await ctx.step('local data back after restore', async () => {
    const page = await local();
    r.localMarker = await getMarker(page);
    await ctx.shot('restored');
    if (r.localMarker !== `local-${MARK}`) throw new Error(`local marker after restore: ${r.localMarker}`);
  });
  r.verdict = `PASS: local origin restored (${r.bytes} B backed up); account origin, Local Storage and other prefs absent from the set and the restored dir`;
  log('localBackup', JSON.stringify(r, null, 2));
}
