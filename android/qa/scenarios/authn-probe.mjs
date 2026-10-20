// The decision for harness part 3 (bd med-nt9p.25): does a CDP virtual authenticator reach the
// Android WebView's passkey path? PASS = the signup's create() finishes (the Emergency Kit page shows).
// The verdict is a finding, not a failure: it lands in results.authnProbe either way.
export default async function authnProbe(ctx) {
  const verdict = { verdict: 'FAIL', error: 'the signup wizard never showed' };
  ctx.results.authnProbe = verdict;
  const page = await ctx.step('invite opens the signup wizard', () => ctx.openClaim());
  verdict.error = '';
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
        hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true,
      },
    });
    ctx.log('virtual authenticator', authenticatorId);
    await page.click('#create-passkey');
    const done = page.locator('#kit-saved');
    const end = Date.now() + 60_000;
    while (Date.now() < end && !(await done.isVisible().catch(() => false))) await ctx.sleep(1000);
    await ctx.shot('after-create');
    if (await done.isVisible().catch(() => false)) {
      verdict.verdict = 'PASS';
    } else {
      // The wizard's own error copy, else whatever the page shows.
      const text = await page.evaluate(() => document.body.innerText).catch((e) => `page gone: ${e.message}`);
      verdict.error = `no Emergency Kit page within 60 s; page says: ${text.replace(/\s+/g, ' ').trim().slice(0, 400)}`;
    }
  } catch (e) {
    verdict.error = String(e?.message || e).split('\n')[0];
    await ctx.shot('error');
  }
  ctx.log('authn probe', JSON.stringify(verdict));
}
