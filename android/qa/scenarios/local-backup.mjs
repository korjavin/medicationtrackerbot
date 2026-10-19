// Auto Backup proof for the shipped rules (bd med-nt9p.32.5, docs/android.md → Local mode
// backup): a cloud-mode session AND a local-origin session write marker data, then bmgr backupnow
// → pm clear → bmgr restore, once per rule section (cloud backup, device transfer). PASS = the
// local marker is back AND nothing of the account origin, Local Storage or any prefs file but
// wg_trial.xml is in the backup set or the restored data dir.
// Local data comes from the bundled local app (bd med-nt9p.32.2, the debug-only wgLocalApp launch
// extra) until the shell's local-mode switch (bd med-nt9p.32.4) lands. Not in `all`: it ends with pm clear.

const MARK = `qa-backup-${Date.now()}`;
const LOCAL_DIR = 'https_appassets.androidplatform.net_0.indexeddb.leveldb';
// What may exist after pm clear + restore: an allowlist, so any stray store fails (fail closed).
// The standard dirs Android recreates count only as empty dirs: anything inside them fails.
const ALLOWED = [
  /^\.$/,
  /^\.\/(app_webview|app_webview\/Default|app_webview\/Default\/IndexedDB|shared_prefs|cache|code_cache|databases|files|no_backup)$/,
  /^\.\/app_webview\/Default\/IndexedDB\/https_appassets\.androidplatform\.net_0\.indexeddb\.(leveldb|blob)(\/.*)?$/,
  /^\.\/shared_prefs\/wg_trial\.xml$/,
];
const CANARIES = ['shared_prefs/diag.xml', 'shared_prefs/reminders.xml', 'shared_prefs/health.xml', 'files/qa-canary', 'databases/qa-canary'];
// Android picks <cloud-backup> or <device-transfer> by the transport's flags. is_encrypted:
// cloud-backup says disableIfNoEncryptionCapabilities.
const MODES = [['cloud', 'is_encrypted=true'], ['d2d', 'is_device_transfer=true']];

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
  /** The app's data dir (run-as starts there), one path per line. */
  const ls = () => shell(`run-as ${pkg} find . -maxdepth 7 2>&1 | sort`);
  const local = async () => {
    await shell(`am force-stop ${pkg}`);
    await ctx.sleep(2000); // the dead process's devtools socket must go before attaching
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez wgLocalApp true`);
    const page = await ctx.attachPage();
    if (!page || !page.url().startsWith('https://appassets.androidplatform.net/')) throw new Error(`not on the local origin: ${page?.url()}`);
    // The bundled app has opened its own IndexedDB (localdb) by then: same leveldb dir as the marker.
    await page.waitForFunction(() => window.MedTrackerCloudReady, null, { timeout: 60_000 });
    await page.evaluate(() => window.MedTrackerCloudReady);
    return page;
  };

  for (const [mode, params] of MODES) {
    const m = (r[mode] = {});
    const step = (name, fn) => ctx.step(`${mode}: ${name}`, fn);

    // 1. Cloud mode: the account origin gets an IndexedDB db + Local Storage key, the shell its prefs.
    const cloudHost = await step('cloud session writes account-origin data', async () => {
      const page = await ctx.openClaim();
      await putMarker(page, `cloud-${MARK}`);
      return new URL(page.url()).host;
    });
    m.cloudHost = cloudHost;
    // 2. Local origin: the data that must survive.
    await step('local session writes local-origin data', async () => putMarker(await local(), `local-${MARK}-${mode}`));
    // Canaries for the stores this session does not fill (reminders need an unlocked vault):
    // every excluded prefs file and the standard dirs, so an accidental include has something to copy.
    for (const f of CANARIES) {
      await shell(`run-as ${pkg} sh -c 'mkdir -p shared_prefs files databases; [ -e ${f} ] || echo "<map />" > ${f}'`);
    }
    const before = await ls();
    await step('stores to leak exist before backup', async () => {
      const missing = [`https_${cloudHost}_0.indexeddb.leveldb`, 'Local Storage', 'shared_prefs/shell.xml', LOCAL_DIR, ...CANARIES]
        .filter((want) => !before.includes(want));
      if (missing.length) throw new Error(`missing before backup (the leak check would prove nothing): ${missing.join(', ')}\n${before}`);
    });

    // 3. Backup on the local transport. The app stays running: bmgr refuses a stopped package.
    await step('bmgr backupnow', async () => {
      await shell('bmgr enable true');
      await shell('bmgr transport com.android.localtransport/.LocalTransport');
      await shell(`settings put secure backup_local_transport_parameters '${params}'`);
      m.backupnow = await shell(`bmgr backupnow ${pkg}`);
      m.bytes = Number((/progress: \d+\/(\d+)/.exec(m.backupnow) || [])[1] || 0);
      if (!/Success/i.test(m.backupnow)) throw new Error(`backupnow: ${m.backupnow}`);
    });

    // 4. The backup set itself (adb root, run.sh): the transport's full-backup tar stream. Fail
    //    closed: the local dir name must be greppable in it, or the absence checks prove nothing.
    await step('backup set holds only the include list', async () => {
      // The transport's own files, not the app's no_backup/ dir.
      const files = (await shell(`find /data /cache -path '*${pkg}*' -type f 2>/dev/null | grep -i -e localtransport -e /backup/`)).split('\n').filter(Boolean);
      m.setFiles = files;
      if (!files.length) throw new Error(`no backup file for the package; candidates: ${await shell(`find /data /cache -path '*${pkg}*' -type f 2>/dev/null | grep -v '/data/\\(data\\|user\\|user_de\\)/0/${pkg}/' | head -40`)}`);
      let seen = 0;
      for (const f of files) {
        seen += Number(await shell(`grep -c '${LOCAL_DIR}' '${f}' || true`)) || 0;
        const hits = await shell(`grep -c '${cloudHost.replace(/\./g, '\\.')}\\|Local Storage\\|Cookies\\|shell\\.xml\\|diag\\.xml\\|reminders\\.xml\\|health\\.xml\\|qa-canary' '${f}' || true`);
        if (hits !== '0') throw new Error(`${f}: ${hits} hit(s) of the account host / Local Storage / Cookies / prefs`);
        m.entries = [...(m.entries || []), ...(await shell(`tar -tf '${f}' 2>&1`)).split('\n').filter(Boolean)];
      }
      if (!seen) throw new Error(`the local dir name is not in the backup set (not inspectable?): ${files.join(', ')}`);
      // Every tar entry (apps/<pkg>/r/<path>, sp/ for prefs) must be on the include list.
      const extra = m.entries.filter((e) => !/^apps\/[^/]+\/(_manifest|_meta|r\/app_webview\/Default\/IndexedDB\/https_appassets\.androidplatform\.net_0\.indexeddb\.(leveldb|blob)(\/.*)?|sp\/wg_trial\.xml)$/.test(e));
      if (!m.entries.length || extra.length) throw new Error(`backup set entries outside the include list: ${extra.join(', ') || '(tar listing empty)'}`);
    });

    // 5. Wipe, restore, and allowlist what came back.
    await step('pm clear → bmgr restore → only included paths', async () => {
      await shell(`pm clear ${pkg}`);
      m.restore = await shell(`bmgr restore 1 ${pkg}`);
      m.afterRestore = await ls();
      log(`${mode} restored:\n${m.afterRestore}`);
      const stray = m.afterRestore.split('\n').filter((l) => l && !ALLOWED.some((re) => re.test(l)));
      if (stray.length) throw new Error(`restored outside the include list: ${stray.join(', ')}`);
      if (!m.afterRestore.includes(LOCAL_DIR)) throw new Error('local-origin IndexedDB not restored');
    });

    // 6. The local marker is back in the WebView.
    await step('local data back after restore', async () => {
      const page = await local();
      m.localMarker = await getMarker(page);
      await ctx.shot(`${mode}-restored`);
      if (m.localMarker !== `local-${MARK}-${mode}`) throw new Error(`local marker after restore: ${m.localMarker}`);
    });
    m.verdict = `PASS (${m.bytes} B): local origin restored; account origin, Local Storage and other prefs absent from the set and the restored dir`;
    await shell(`pm clear ${pkg}`);
  }
  log('localBackup', JSON.stringify(r, null, 2));
}
