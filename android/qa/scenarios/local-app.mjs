// Local mode's bundled app on the emulator (bd med-nt9p.32.2, docs/android.md → Local mode):
// the debug-only launch extra wgLocalMode (bd med-nt9p.32.4) opens assets/web on https://appassets.androidplatform.net
// in MainActivity. Proves the shell renders with no failed asset/module load, the document carries
// the CSP header, and a miss is a 404 that never reaches the network. Findings in results.localApp.
// Not in `all`: local-smoke (bd med-nt9p.32.6) is the local scenario there.
const ORIGIN = 'https://appassets.androidplatform.net';

export default async function localApp(ctx) {
  const { shell, pkg, log } = ctx;
  const r = (ctx.results.localApp = {});
  const page = await ctx.step('launch with --ez wgLocalMode true', async () => {
    await shell(`am force-stop ${pkg}`);
    await ctx.sleep(2000); // the dead process's devtools socket must go before attaching
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez wgLocalMode true`);
    const p = await ctx.attachPage();
    if (!p) throw new Error('no WebView page (see the run log)');
    return p;
  });
  const failed = [];
  page.on('requestfailed', (q) => failed.push(`${q.url()} ${q.failure()?.errorText}`));
  page.on('response', (s) => { if (s.status() >= 400) failed.push(`${s.status()} ${s.url()}`); });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await ctx.step('the app shell boots on the asset origin', async () => {
    // Reload with the listeners attached, so every subresource of this load is seen.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    r.url = page.url();
    if (!r.url.startsWith(`${ORIGIN}/`)) throw new Error(`not on the asset origin: ${r.url}`);
    await page.waitForFunction(() => window.MedTrackerCloudReady, null, { timeout: 30_000 });
    r.ready = await page.evaluate(() => Promise.resolve(window.MedTrackerCloudReady).then(() => 'resolved', (e) => `rejected: ${e}`));
    await page.locator('#app').waitFor({ state: 'attached', timeout: 30_000 });
    r.page = await page.evaluate(() => ({
      secure: window.isSecureContext,
      localVault: document.documentElement.classList.contains('wg-local-vault'),
      build: document.querySelector('meta[name="medtracker-build-id"]')?.content,
      sw: !!navigator.serviceWorker?.controller,
    }));
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
    await ctx.sleep(3000); // the software-GPU emulator paints seconds behind the DOM
    await ctx.shot('shell');
  });

  await ctx.step('CSP header, 404 on a miss, connect-src enforced', async () => {
    r.headers = await page.evaluate(async () => {
      const doc = await fetch('/', { cache: 'no-store' });
      // Parse the body of this very response, rather than reading a newer mirror/bridge reply.
      const html = new DOMParser().parseFromString(await doc.text(), 'text/html');
      const origins = html.querySelectorAll('meta[name="medtracker-connect-origins"]');
      const js = await fetch('/js/apishim.js', { cache: 'no-store' });
      const miss = await fetch('/no/such/file.js', { cache: 'no-store' });
      let foreign;
      try { await fetch('https://example.com/'); foreign = 'reached'; } catch (e) { foreign = `blocked: ${e.name}`; }
      return {
        csp: doc.headers.get('content-security-policy'),
        originsCount: origins.length,
        origins: JSON.parse(origins[0]?.content || 'null'),
        loadedOrigins: JSON.parse(document.querySelector('meta[name="medtracker-connect-origins"]')?.content || 'null'),
        cache: doc.headers.get('cache-control'),
        docType: doc.headers.get('content-type'),
        jsType: js.headers.get('content-type'),
        miss: miss.status,
        foreign,
      };
    });
    const h = r.headers;
    if (!/connect-src 'self'[;]/.test(h.csp || '') || /(https|wss):[; ]/.test(h.csp)) throw new Error(`CSP: ${h.csp}`);
    if (h.originsCount !== 1 || JSON.stringify(h.origins) !== '[]' || JSON.stringify(h.loadedOrigins) !== '[]') throw new Error(`document origins: ${JSON.stringify(h)}`);
    if (h.cache !== 'no-store') throw new Error(`Cache-Control: ${h.cache}`);
    if (!/^text\/javascript/.test(h.jsType || '')) throw new Error(`JS MIME: ${h.jsType}`);
    if (h.miss !== 404) throw new Error(`miss answered ${h.miss}`);
    if (h.foreign === 'reached') throw new Error('connect-src let https://example.com through');
  });

  // bd med-dngs: a voice call's audio starts seconds after the tap (attested start, the
  // ElevenLabs mint, the mic prompt), past the gesture's ~5 s transient activation. The SDK
  // plays the agent through AudioContext → MediaStreamDestination → an autoplay <audio>
  // element; a WebView that requires a gesture for media refuses that play(): the call
  // connects and is silent. Same chain here, after the evaluate's own CDP gesture expired.
  await ctx.step('call audio made long after the gesture plays', async () => {
    r.audio = await page.evaluate(async () => {
      await new Promise((res) => setTimeout(res, 6000));
      const ac = new AudioContext();
      const context = ac.state;
      const osc = ac.createOscillator();
      const dest = ac.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = dest.stream;
      let play = 'ok';
      try {
        await Promise.race([el.play(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
      } catch (e) { play = `${e.name}: ${e.message}`; }
      const out = { context, contextAfter: ac.state, play, paused: el.paused };
      el.srcObject = null;
      await ac.close();
      return out;
    });
    if (r.audio.play !== 'ok' || r.audio.paused) throw new Error(`call audio blocked: ${JSON.stringify(r.audio)}`);
  });

  // The expected 404 above and the refused example.com fetch are this step's own; drop them.
  const own = failed.filter((f) => !/no\/such\/file|example\.com/.test(f));
  // ERR_ABORTED is a cancel, not a failure: the first load's requests cut by the reload, and the
  // favicons WebView never fetches (first run 39236712561: logcat clean, shell rendered).
  r.aborted = own.filter((f) => f.endsWith('net::ERR_ABORTED'));
  r.failed = own.filter((f) => !f.endsWith('net::ERR_ABORTED'));
  // The console's 404 line names no URL; any other 404 is in r.failed via the response listener.
  r.errors = errors.filter((e) => !/example\.com|no\/such\/file|Content Security Policy|status of 404/.test(e));
  log('localApp', JSON.stringify(r, null, 2));
  if (r.failed.length) throw new Error(`failed loads: ${r.failed.join(', ')}`);
  // local-boot.js catches its own boot failures, so a broken app shows only as an error here.
  if (r.errors.length) throw new Error(`page errors: ${r.errors.join(' | ')}`);
}
