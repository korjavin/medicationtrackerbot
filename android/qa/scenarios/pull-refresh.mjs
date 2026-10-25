// Pull to refresh in the WebView (bd med-y7b4.8; the web gesture is bd med-y7b4.6,
// web/static/js/features/app-refresh.js). MainActivity sets OVER_SCROLL_NEVER and there is no
// SwipeRefreshLayout, so the page's own passive touch listeners must see the whole drag: a real
// finger (input motionevent DOWN / MOVE… / UP) at the top of the page.
// Local mode: Today has nothing to pull (no gesture, no pill); Health with the Health Connect import
// on shows "Release to check Health Connect", then "Checking Health Connect…", and the shell logs a
// health read. Account mode (the run's invite): Today shows "Release to sync" / "Syncing…" and the
// page requests /api/sync/. A touchcancel or no touchmove means the WebView swallowed the gesture.
// results.pullRefresh: per pull, the pill states seen, the touch event counts and the toasts.
import { claimAccount } from './smoke.mjs';
import { READS } from './health-connect.mjs';

export const retry = false; // the account half claims the run's one invite

export default async function pullRefresh(ctx) {
  const { shell, pkg, sleep, device } = ctx;
  const r = (ctx.results.pullRefresh = {});
  let page;

  const healthReads = async () => (await shell(`run-as ${pkg} cat shared_prefs/diag.xml`))
    .split(/&#10;|\n/).filter((l) => / health \S+ \S+ read=/.test(l)); // timestamped lines: a set diff survives the log cap
  const go = async (t) => {
    await page.evaluate((x) => { window.switchTab(x); window.scrollTo(0, 0); }, t);
    await page.waitForFunction((id) => !!document.getElementById(id)?.offsetParent, `${t}-view`, { timeout: 15_000 });
    await sleep(1500);
  };
  // Records every pill state, the touch events the page gets and the toasts it raises.
  const arm = () => page.evaluate(() => {
    const rec = (window.__qaPtr = { pill: [], touch: {}, toasts: [] });
    if (!window.__qaPtrHooked) {
      window.__qaPtrHooked = true;
      for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        document.addEventListener(t, () => { window.__qaPtr.touch[t] = (window.__qaPtr.touch[t] || 0) + 1; }, { passive: true, capture: true });
      }
      const toast = window.safeToast;
      window.safeToast = (m, type) => { window.__qaPtr.toasts.push([m, type]); return toast(m, type); };
      let last = '';
      setInterval(() => {
        const p = document.querySelector('.wg-ptr');
        const s = p ? `${p.className}|${p.textContent}` : '';
        if (s !== last) { window.__qaPtr.pill.push(s); last = s; }
      }, 25);
    }
    return !!rec;
  });
  const record = () => page.evaluate(() => ({ ...window.__qaPtr, scrollY }));
  // A finger from 30% of the WebView down by 500 device px, held for a screenshot, then lifted.
  const pull = async (label) => {
    await arm();
    const { bounds } = await device.info({ clazz: 'android.webkit.WebView' });
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height * 0.3);
    await shell(`input motionevent DOWN ${x} ${y}`);
    for (let i = 1; i <= 10; i++) await shell(`input motionevent MOVE ${x} ${y + i * 50}`);
    await ctx.shot(`${label}-pulling`);
    await shell(`input motionevent UP ${x} ${y + 500}`);
    await ctx.shot(`${label}-released`);
    const end = Date.now() + 25_000; // the import's own timeout is 20 s
    while (Date.now() < end && (await page.evaluate(() => !!document.querySelector('.wg-ptr')))) await sleep(250);
    await sleep(500);
    const got = (r[label] = await record());
    if (!got.touch.touchmove) throw new Error(`no touchmove reached the page: ${JSON.stringify(got.touch)}`);
    if (got.touch.touchcancel) throw new Error(`the WebView cancelled the touch: ${JSON.stringify(got.touch)}`);
    const bad = got.toasts.find(([, t]) => t === 'error');
    if (bad) throw new Error(`error toast: ${bad[0]}`);
    return got;
  };
  const expectPill = (got, ...want) => {
    for (const w of want) if (!got.pill.some((s) => s.includes(w))) throw new Error(`no pill "${w}": ${JSON.stringify(got.pill)}`);
  };

  await shell(`pm clear ${pkg}`);
  for (const p of READS) await shell(`pm grant ${pkg} android.permission.health.READ_${p}`);

  page = await ctx.step('launch: local mode on Today', () => ctx.launchLocal('today'));
  await sleep(2000);

  await ctx.step('local Today: a pull shows no pill (nothing to sync)', async () => {
    await go('today');
    const got = await pull('local-today');
    if (got.pill.some(Boolean)) throw new Error(`pill in local mode: ${JSON.stringify(got.pill)}`);
  });

  await ctx.step('Settings: switch the Health Connect import on', async () => {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.locator('#health-import-toggle').waitFor({ state: 'attached', timeout: 15_000 });
    await page.evaluate(() => document.getElementById('health-import-toggle').click());
    await page.waitForFunction(() => localStorage.getItem('wg.health.enabled') === 'true', null, { timeout: 15_000 });
    await sleep(10_000); // the switch-on scan settles before the pull
  });

  await ctx.step('local Health: pull → Release / Checking Health Connect → a Health Connect read', async () => {
    await go('health');
    const before = new Set(await healthReads());
    const got = await pull('local-health');
    expectPill(got, 'wg-ptr--ready|Release to check Health Connect', 'wg-ptr--busy|Checking Health Connect');
    got.healthReads = (await healthReads()).filter((l) => !before.has(l));
    if (!got.healthReads.length) throw new Error('the pull ran no Health Connect read');
  });
  await ctx.stableShot('local-health-after');

  page = await ctx.step('account: invite opens the signup wizard', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  await ctx.step('account Today: pull → Release to sync / Syncing… → a sync request', async () => {
    await go('today');
    const urls = [];
    const onReq = (q) => { if (q.url().includes('/api/sync/')) urls.push(q.url().replace(/^https?:\/\/[^/]+/, '')); };
    page.on('request', onReq);
    try {
      const got = await pull('account-today');
      expectPill(got, 'wg-ptr--ready|Release to sync', 'wg-ptr--busy|Syncing');
      got.syncRequests = urls;
      if (!urls.length) throw new Error('the pull made no /api/sync/ request');
    } finally {
      page.off('request', onReq);
    }
  });
  await ctx.stableShot('account-today-after');
  ctx.log('pullRefresh', JSON.stringify(r, null, 2));
}
