// First launch = local mode (bd med-ta2n.12, contract med-ta2n.7 §9): a fresh install opens the bundled
// app's W1 with no native screen → W1's "Have an invite?" → F1 → an account address (tlsfront's 503
// down.qa.test) → "Your invite is here" → Sign in → N4 → Switch account → local mode with F1 open
// again → an invite link (medtracker://) → "Your invite is here" → Sign in → the claim page (/unlock).
// Opens the run's invite but never claims it: in `all`, retryable.
import { readFileSync } from 'node:fs';
const expect = (cond, what) => { if (!cond) throw new Error(what); };

export default async function firstrun(ctx) {
  const { shell, pkg, sleep, device } = ctx;
  const r = (ctx.results.firstrun = {});
  const prefs = async () => {
    await sleep(1500); // SharedPreferences.apply() writes asynchronously
    return shell(`run-as ${pkg} cat shared_prefs/shell.xml`);
  };

  // Hold the local asset document at document-start until CDP is listening; the
  // debug-only gate lets the genuine first boot and reopen run under observation.
  const radios = {
    wifi: (await shell('settings get global wifi_on')).trim(),
    data: (await shell('settings get global mobile_data')).trim(),
  };
  r.offlineFirstRun = { egress: [], localRequests: 0 };
  const rr = r.offlineFirstRun;
  if (!process.env.QA_RECEIPTS) throw new Error('QA_RECEIPTS unset');
  const receiptCount = () => readFileSync(process.env.QA_RECEIPTS, 'utf8').trim().split('\n').filter(Boolean).length;
  try {
    await shell(`pm clear ${pkg}`);
    await shell(`pm grant ${pkg} android.permission.POST_NOTIFICATIONS`);
    await shell(`appops set ${pkg} SCHEDULE_EXACT_ALARM allow`);
    await shell('svc wifi disable');
    await shell('svc data disable');
    rr.radiosOff = { wifi: (await shell('settings get global wifi_on')).trim(), data: (await shell('settings get global mobile_data')).trim() };
    expect(rr.radiosOff.wifi === '0' && rr.radiosOff.data === '0', 'guest radios are not off');
    rr.receiptsBefore = receiptCount(); // Starts before the first native navigation.
    const watch = (pg) => {
      const note = (url) => {
        const u = new URL(url);
        if (/^(https?|wss?):$/.test(u.protocol)) {
          if (u.host !== new URL(ctx.LOCAL_ORIGIN).host) rr.egress.push(url);
          else rr.localRequests++;
        }
      };
      pg.on('request', (q) => note(q.url()));
      pg.on('websocket', (w) => note(w.url()));
    };
    const gatedLaunch = async () => {
      await shell(`am force-stop ${pkg}`);
      await shell(`run-as ${pkg} rm -f files/qa-net-watch-ready files/qa-net-watch-release`);
      await shell(`am start -n ${pkg}/com.example.medtracker.MainActivity --ez wgQANetWatch true`);
      const end = Date.now() + 45_000;
      while (Date.now() < end && !(await shell(`run-as ${pkg} ls files/qa-net-watch-ready 2>/dev/null`))) await sleep(250);
      expect(!!(await shell(`run-as ${pkg} ls files/qa-net-watch-ready 2>/dev/null`)), 'document-start network gate did not become ready');
      const pg = await ctx.attachPage();
      expect(!!pg, 'no WebView while document-start gate held');
      expect((await shell(`run-as ${pkg} cat files/qa-net-watch-ready`)).trim() === 'waiting', 'network gate expired before listener attach');
      watch(pg);
      await shell(`run-as ${pkg} touch files/qa-net-watch-release`);
      await pg.waitForURL((u) => u.href.startsWith(`${ctx.LOCAL_ORIGIN}/`), { timeout: 30_000 });
      await pg.waitForLoadState('domcontentloaded', { timeout: 60_000 });
      expect((await shell(`run-as ${pkg} cat files/qa-net-watch-ready`)).trim() === 'released', 'document-start network gate did not release');
      return pg;
    };
    let p = await ctx.step('offline fresh install opens W1 with listener attached', async () => {
      const pg = await gatedLaunch();
      await pg.locator('[data-firstrun-action="skip-all"]').waitFor({ state: 'visible', timeout: 90_000 });
      expect(!(await pg.evaluate(() => navigator.onLine)), 'fresh boot reports online');
      expect(/name="wgLocalMode" value="true"/.test(await prefs()), 'fresh boot did not select local mode');
      expect(rr.localRequests > 0, 'listener saw no local app resources after release');
      await ctx.shot('offline-fresh-w1');
      return pg;
    });
    await ctx.step('complete first run without an invite', async () => {
      await p.locator('[data-firstrun-action="skip-all"]').click();
      await p.waitForFunction(() => !document.getElementById('wg-firstrun-overlay') || !!document.querySelector('[data-firstrun-action="not-now"]'), null, { timeout: 15_000 });
      if (await p.locator('[data-firstrun-action="not-now"]').isVisible()) await p.locator('[data-firstrun-action="not-now"]').click();
      await p.locator('#wg-firstrun-overlay').waitFor({ state: 'hidden' });
    });
    const go = async (tab) => {
      await p.evaluate((t) => window.switchTab(t), tab);
      await p.locator(`#${tab}-view`).waitFor({ state: 'visible' });
    };
    await ctx.step('offline UI: log BP and weight, edit BP and delete weight', async () => {
      await go('bp');
      await p.click('#add-bp-btn');
      await p.fill('#bp-systolic', '128');
      await p.fill('#bp-diastolic', '82');
      await p.click('#bp-modal-save-btn');
      await p.locator('#bp-modal').waitFor({ state: 'hidden' });
      const bp = (await p.evaluate(() => window.apiCall('/api/bp?days=60')))[0];
      expect(bp?.systolic === 128 && bp?.diastolic === 82, 'new BP missing');
      rr.bpId = bp.id;
      await p.locator(`#bp-list [data-reading-id="${bp.id}"] .wg-bp-reading-row__value`).click();
      await p.fill('#bp-systolic', '132');
      await p.click('#bp-modal-save-btn');
      await p.locator('#bp-modal').waitFor({ state: 'hidden' });
      await go('weight');
      await p.click('#add-weight-btn');
      await p.fill('#weight-value', '81.2');
      await p.click('#weight-modal-save-btn');
      await p.locator('#weight-modal').waitFor({ state: 'hidden' });
      const weight = (await p.evaluate(() => window.apiCall('/api/weight?days=60')))[0];
      expect(Number(weight?.weight) === 81.2, 'new weight missing');
      rr.weightId = weight.id;
      const row = p.locator(`#weight-list [data-weight-id="${weight.id}"]`);
      await row.locator('.wg-swipe__more').click();
      await row.getByRole('menuitem', { name: 'Delete' }).click();
      await p.waitForFunction(() => !document.querySelector('#weight-list [data-weight-id]'));
      await p.evaluate(() => window.flushPendingDelete());
      await ctx.shot('offline-edited-bp-deleted-weight');
    });
    await ctx.step('offline UI: add an as-needed medication and log a dose', async () => {
      await go('meds');
      await p.locator('.med-tab[data-tab="schedule"]').click();
      await p.getByRole('button', { name: 'Add medication', exact: true }).first().click();
      await p.fill('#med-name', 'QA Offline Dose');
      await p.fill('#med-dosage', '5mg');
      await p.click('#med-modal-save-btn');
      await p.locator('#med-modal').waitFor({ state: 'hidden' });
      const med = (await p.evaluate(() => window.apiCall('/api/medications'))).find((m) => m.name === 'QA Offline Dose');
      expect(!!med, 'medication missing'); rr.medId = med.id;
      const row = p.locator(`#med-list [data-med-id="${med.id}"]`);
      await row.getByRole('button', { name: 'Log', exact: true }).click();
      await p.locator('#med-confirm-modal').waitFor({ state: 'visible' });
      await p.click('#med-confirm-action-btn');
      await p.locator('#med-confirm-modal').waitFor({ state: 'hidden' });
      await ctx.shot('offline-dose-logged');
    });
    await ctx.step('offline force-stop and reopen retains edited BP and dose, not deleted weight', async () => {
      const before = rr.localRequests;
      p = await gatedLaunch();
      await ctx.waitLocalReady(p);
      expect(rr.localRequests > before, 'listener saw no local app resources after reopen');
      const data = await p.evaluate(async () => ({
        vault: JSON.parse(await window.CloudVault.exportAll({ includeSecrets: false })).data,
        bp: await window.apiCall('/api/bp?days=60'), weight: await window.apiCall('/api/weight?days=60'),
      }));
      // Vault export omits BP and weight ids. Query the app API for exact identity.
      rr.reopened = { bp: data.bp, weight: data.weight, intakes: data.vault.medications.intakes };
      expect(data.bp.some((x) => String(x.id) === String(rr.bpId) && x.systolic === 132 && x.diastolic === 82), `edited BP lost: ${JSON.stringify(data.bp)}`);
      expect(!data.weight.some((x) => String(x.id) === String(rr.weightId)), 'deleted weight returned');
      expect(data.vault.medications.intakes.some((x) => String(x.medication_id) === String(rr.medId) && x.status === 'TAKEN'), 'logged dose lost');
      expect(!rr.egress.length, `listener observed egress: ${rr.egress.join(', ')}`);
      rr.receiptsAfter = receiptCount();
      expect(rr.receiptsAfter === rr.receiptsBefore, `TLS front received ${rr.receiptsAfter - rr.receiptsBefore} requests during offline first run`);
      await ctx.shot('offline-reopened');
    });
  } finally {
    await shell(`svc wifi ${radios.wifi === '0' ? 'disable' : 'enable'}`);
    await shell(`svc data ${radios.data === '0' ? 'disable' : 'enable'}`);
    rr.radiosRestored = { wifi: (await shell('settings get global wifi_on')).trim(), data: (await shell('settings get global mobile_data')).trim() };
    expect(JSON.stringify(rr.radiosRestored) === JSON.stringify(radios), 'guest radio cleanup failed');
  }

  await shell(`pm clear ${pkg}`);
  let page = await ctx.step('fresh install → W1 in local mode, no native screen', async () => {
    await sleep(2000);
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
    const p = await ctx.localPage((pg) => pg.locator('[data-firstrun-action="invite"]').waitFor({ state: 'visible', timeout: 90_000 }));
    for (const gone of ['Only on this device', 'Continue', 'Paste invite link or address']) {
      expect(!(await device.wait({ text: gone }, { timeout: 1_000 }).then(() => true, () => false)), `native first run: "${gone}"`);
    }
    expect(/name="wgLocalMode" value="true"/.test(await prefs()), 'the first launch did not persist local mode');
    return p;
  });
  await ctx.shot('w1');

  await ctx.step('W1 "Have an invite?" opens F1', async () => {
    await page.click('[data-firstrun-action="invite"]');
    await page.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 10_000 });
  });
  await ctx.shot('f1');

  await ctx.step('F1 → https://down.qa.test/ (503) → Sign in → the error screen', () => ctx.openAccount('https://down.qa.test/', { shotTyped: true }));
  await ctx.shot('error');

  page = await ctx.step('Switch account → local mode, F1 open, the host forgotten', async () => {
    await device.tap({ text: 'Switch account' });
    const p = await ctx.localPage((pg) => pg.locator('[data-invite-action="paste"]').waitFor({ state: 'visible', timeout: 60_000 }));
    const xml = await prefs();
    expect(!/accountHost/.test(xml) && /name="wgLocalMode" value="true"/.test(xml), `prefs: ${xml}`);
    return p;
  });
  await ctx.shot('switch-f1');

  await ctx.step('medtracker:// invite → "Your invite is here" → Sign in → the claim page', async () => {
    if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
    const claim = new URL(ctx.claimUrl);
    const sub = claim.host.split('.')[0];
    const tok = /claim=([0-9a-f]+)/.exec(claim.hash)[1];
    await shell(`am start -W -a android.intent.action.VIEW -d 'medtracker://i/${sub}#${tok}'`);
    await sleep(2000);
    const p = await ctx.localPage((pg) => pg.locator('[data-invite-action="sign-in"]').waitFor({ state: 'visible', timeout: 60_000 }));
    await ctx.shot('invite-ready');
    await p.click('[data-invite-action="sign-in"]').catch(() => {}); // the page goes during the tap
    await sleep(2000);
    const acct = await ctx.attachPage();
    if (!acct) throw new Error('no WebView page');
    await acct.waitForURL(/\/unlock/, { timeout: 60_000 });
    await acct.locator('#create-passkey').waitFor({ timeout: 30_000 });
    r.claimPage = acct.url().replace(/#.*/, '#…');
    const xml = await prefs();
    expect(xml.includes(`>${claim.host}<`) && /name="wgLocalMode" value="false"/.test(xml), `prefs: ${xml}`);
    expect(!/wgPendingInvite"/.test(xml), 'the slot outlived the open');
    // The real flow stashed the (records-free) local vault for the account; nothing claims here.
    await shell(`run-as ${pkg} sh -c 'rm -rf no_backup/move; true'`);
  });
  await ctx.shot('claim-page');
}
