// Local-mode spike on the emulator (bd med-nt9p.32.1, docs/android.md → Spike: local mode): the
// debug-only LocalSpikeActivity serves ios/LocalSpike on https://appassets.androidplatform.net.
// Every check's row lands in results.localSpike — findings, not failures; the scenario throws
// only when the page never reports. Not in `all`: it ends with `pm clear` (wipes the app).
import { existsSync } from 'node:fs';

const APK = process.env.QA_APK || 'android/app/build/outputs/apk/debug/app-debug.apk';

export default async function localSpike(ctx) {
  const { shell, pkg, log } = ctx;
  const activity = `${pkg}/com.example.medtracker.LocalSpikeActivity`;
  const r = { api: await shell('getprop ro.build.version.sdk') };
  ctx.results.localSpike = r;

  /** Cold start the spike, wait for its automatic checks, return {id: "STATUS detail"} + the report. */
  async function run(label) {
    await shell(`am force-stop ${pkg}`);
    await ctx.sleep(2000); // the dead process's devtools socket must go before attaching
    await shell(`am start -W -n ${activity}`);
    const page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page on the spike');
    const end = Date.now() + 90_000;
    let status = '';
    while (Date.now() < end) {
      // The page reloads itself once (check 13): evaluate may hit a destroyed context.
      status = await page.evaluate(() => document.getElementById('status')?.textContent || '').catch(() => '');
      if (/Automatic checks done|FAIL/.test(status)) break;
      await ctx.sleep(1000);
    }
    await ctx.sleep(1500);
    const read = () => page.evaluate(() => ({
      rows: [...document.querySelectorAll('#results tr')].map((tr) => [...tr.cells].map((c) => c.textContent)),
      report: document.getElementById('report').textContent,
    }));
    const { rows, report } = await read();
    await ctx.shot(label);
    log(`--- ${label} report ---\n${report}`);
    if (!/Automatic checks done/.test(status)) throw new Error(`spike did not finish: ${status}`);
    return { page, rows: Object.fromEntries(rows.map(([id, st, d]) => [id.slice(1), `${st} ${d}`])), report };
  }

  await shell(`pm grant ${pkg} android.permission.CAMERA`);
  const first = await ctx.step('first launch: automatic checks', () => run('first'));
  r.webview = (first.report.match(/WebView ([^·]+)/) || [])[1]?.trim();
  r.first = first.rows;
  r.dirs = first.report.split('\n').filter((l) => /IndexedDB|our origin dir/.test(l)).map((l) => l.trim());

  await ctx.step('camera (check 5)', async () => {
    await first.page.click('#camera');
    const end = Date.now() + 30_000;
    let row = '';
    while (Date.now() < end) {
      row = await first.page.evaluate(() => [...document.querySelectorAll('#results tr')]
        .find((tr) => tr.cells[0].textContent === '#5')?.cells[2].textContent || '');
      const st = await first.page.evaluate(() => [...document.querySelectorAll('#results tr')]
        .find((tr) => tr.cells[0].textContent === '#5')?.cells[1].textContent || '');
      if (st === 'PASS' || st === 'FAIL') { r.camera = `${st} ${row}`; break; }
      await ctx.sleep(1000);
    }
    r.camera ||= `timeout ${row}`;
    await ctx.shot('camera');
  });

  const relaunch = await ctx.step('force-stop → relaunch (check 2 durability)', () => run('relaunch'));
  r.relaunch = { 2: relaunch.rows['2'], '2k': relaunch.rows['2k'] };

  if (existsSync(APK)) {
    await ctx.step('install over itself (update path)', () => ctx.device.installApk(APK));
    const update = await ctx.step('relaunch after update', () => run('update'));
    r.update = { 2: update.rows['2'], '2k': update.rows['2k'] };
  } else r.update = `skipped: no ${APK}`;

  // Auto Backup round trip (check 10) on the local transport. is_encrypted=true: the rules say
  // disableIfNoEncryptionCapabilities, which the unencrypted local transport fails otherwise.
  const b = (r.backup = {});
  await ctx.step('bmgr backup → pm clear → restore (check 10)', async () => {
    b.enable = await shell('bmgr enable true');
    b.transport = await shell('bmgr transport com.android.localtransport/.LocalTransport');
    await shell("settings put secure backup_local_transport_parameters 'is_encrypted=true'");
    await shell(`am force-stop ${pkg}`);
    b.backupnow = await shell(`bmgr backupnow ${pkg}`);
    b.stored = await shell(`ls -l /data/cache/backup/1/_full/ 2>&1; du -k /data/cache/backup/1/_full/${pkg} 2>&1`);
    b.contents = await shell(`tar -tvf /data/cache/backup/1/_full/${pkg} 2>&1 | head -40`);
    b.sets = await shell('bmgr list sets');
    await shell(`pm clear ${pkg}`);
    b.afterClear = await shell(`run-as ${pkg} ls app_webview/Default/IndexedDB 2>&1`);
    b.restore = await shell(`bmgr restore 1 ${pkg}`);
    b.afterRestore = await shell(`run-as ${pkg} ls -la app_webview/Default/IndexedDB 2>&1`);
    log('backup', JSON.stringify(b, null, 2));
  });
  const restored = await ctx.step('relaunch after restore', () => run('restored'));
  b.after = { 2: restored.rows['2'], 10: restored.rows['10'] };
  // GO evidence: the restored history still holds the launches from before pm clear.
  const earlier = (s) => Number((/(\d+) earlier launch/.exec(s || '') || [])[1] || 0);
  b.verdict = earlier(restored.rows['2']) >= earlier(r.update?.['2'] || relaunch.rows['2']) && earlier(restored.rows['2']) > 0
    ? 'PASS: launch history survived pm clear via bmgr restore' : 'FAIL: history not back after restore';
  log('localSpike', JSON.stringify(r, null, 2));
}
