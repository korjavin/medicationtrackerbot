// First launch = local mode (bd med-ta2n.12, contract med-ta2n.7 §9): a fresh install opens the bundled
// app's W1 with no native screen → W1's "Have an invite?" → F1 → an account address (tlsfront's 503
// down.qa.test) → "Your invite is here" → Sign in → N4 → Switch account → local mode with F1 open
// again → an invite link (medtracker://) → "Your invite is here" → Sign in → the claim page (/unlock).
// Opens the run's invite but never claims it: in `all`, retryable.
const expect = (cond, what) => { if (!cond) throw new Error(what); };

export default async function firstrun(ctx) {
  const { shell, pkg, sleep, device } = ctx;
  const r = (ctx.results.firstrun = {});
  const prefs = async () => {
    await sleep(1500); // SharedPreferences.apply() writes asynchronously
    return shell(`run-as ${pkg} cat shared_prefs/shell.xml`);
  };

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
