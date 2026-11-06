// The real cmd/cloud on *.localhost, shared by run.mjs (cloud mode) and
// flows.mjs. Chromium resolves <sub>.localhost to loopback and treats it as a
// secure context, so WebAuthn and Secure cookies work over plain http — the
// local dev loop of docs/cloud-mode.md. No external services: no food DB, no
// Telegram, no trial keys.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// One server identity (port, DB, session secret) that may be stopped and
// started again, with the same or another binary, keeping its accounts.
export function cloudServer({ out, port = process.env.CLOUD_PORT || '18080' }) {
  // Placeholder store ids so the invite landing renders its "Get the app" buttons.
  const env = { ...process.env, CLOUD_BASE_DOMAIN: 'localhost', PORT: port, CLOUD_DB_PATH: join(tmpdir(), `visual-cloud-${process.pid}.db`),
    SESSION_SECRET: randomBytes(32).toString('base64'), IOS_APP_STORE_ID: '1234567890', ANDROID_PACKAGE: 'com.example.medtracker' };
  let proc = null;
  let bin = process.env.CLOUD_BIN;
  const up = () => fetch(`http://localhost:${port}/`).then(() => true, () => false);
  return {
    port,
    env,
    get running() { return Boolean(proc); },
    async start(nextBin = bin) {
      bin = nextBin;
      if (!bin) throw new Error('CLOUD_BIN is required in cloud mode');
      const log = createWriteStream(join(out, 'cloud-server.log'), { flags: 'a' });
      proc = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.pipe(log); proc.stderr.pipe(log);
      for (let i = 0; i < 120; i++) {
        if (proc.exitCode !== null) throw new Error(`cmd/cloud exited ${proc.exitCode} (see cloud-server.log)`);
        if (await up()) return proc;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('cmd/cloud did not start listening');
    },
    // SIGKILL, as a crash or a dead host: no graceful drain. Resolves once the
    // port refuses connections.
    async stop() {
      if (!proc) return;
      const p = proc;
      proc = null;
      if (p.exitCode === null) {
        const exited = new Promise((r) => p.once('exit', r));
        p.kill('SIGKILL');
        await exited;
      }
      for (let i = 0; i < 50 && await up(); i++) await new Promise((r) => setTimeout(r, 100));
    },
    // `cloud admin invite` against the same DB; its claim URL is the landing form
    // https://localhost/i/<sub>#<t> (bd med-ta2n.16).
    mintInvite() {
      const text = execFileSync(bin, ['admin', 'invite'], { env, encoding: 'utf8' });
      const m = /https:\/\/localhost\/i\/([a-z0-9-]+)#([a-f0-9]+)/.exec(text);
      if (!m) throw new Error(`no claim URL in: ${text.slice(0, 200)}`);
      return { sub: m[1], origin: `http://${m[1]}.localhost:${port}`, token: m[2] };
    },
  };
}

// The signup wizard as a person runs it (e2e/vault-roundtrip.mjs's flow): claim
// (with &kit=1, as from Settings) → sign in (PRF passkey) → Emergency Kit offer
// → vault open. The authenticator is per page (CDP), so a run keeps one page
// per account. shot(name) captures the two ceremony screens (bd med-ta2n.8).
export async function cloudSignup(context, page, server, shot = async () => {}) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { origin, token } = server.mintInvite();
  await page.goto(`${origin}/#claim=${token}&kit=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/unlock/, { timeout: 30000 });
  await page.locator('#create-passkey').waitFor({ timeout: 30000 });
  await shot('signup-signin');
  await page.click('#create-passkey', { timeout: 30000 });
  // The W5 kit offer: Save kit, then Done (an offer, no acknowledgement).
  await page.locator('#kit-done').waitFor({ timeout: 30000 });
  await shot('signup-kit-offer');
  const download = page.waitForEvent('download').catch(() => null);
  await page.click('#kit-download');
  await download;
  await page.click('#kit-done');
  const skip = page.locator('#install-skip');
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady) || document.querySelector('#install-skip'), null, { timeout: 60000 });
  if (await skip.count()) await skip.click();
  await page.waitForFunction(() => Boolean(window.MedTrackerCloudReady), null, { timeout: 60000 });
  await page.evaluate(() => window.MedTrackerCloudReady);
  if (!(await page.evaluate(() => Boolean(window.MedTrackerCloud && window.MedTrackerCloud.ctx)))) throw new Error('signup did not open the vault');
  return origin;
}

// The QA driver, its scene list and the golden vault, injected rather than
// served: the cloud never carries /qa/*. __wgQACloud lets the driver seed a
// non-local vault (a fresh, empty test account only — the driver still refuses
// to import over content). The driver acts only on a `?qa=<scene>` load.
export async function driverInit(repo) {
  return [
    'window.__wgQACloud = true;',
    `window.__wgQAFiles = ${JSON.stringify({
      '/qa/scenes.json': JSON.parse(await readFile(join(repo, 'tests/visual/scenes.json'), 'utf8')),
      '/qa/vault-v1.json': JSON.parse(await readFile(join(repo, 'tests/fixtures/vault-v1.json'), 'utf8')),
    })};`,
    await readFile(join(repo, 'tests/visual/driver.js'), 'utf8'),
  ].join('\n');
}
