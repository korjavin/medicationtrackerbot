// Invite links at the shell (bd med-ta2n.12.1, contract med-ta2n.7 §3–§7; docs/android.md → Invite
// links). adb delivers medtracker://i/<sub>#<tok> (through the manifest filter) and the landing
// https://<base>/i/<sub>#<tok> (explicit InviteLinkActivity: qa.test has no verified App Link), cold
// and warm, and the bridge reads the slot: cold first run → the field holds the claim URL, nothing
// opens → cold local launch → invite.pending → warm local → home?invite=1 → local.leave {url}
// (invalid urls refused, the move stash kept, the slot consumed) → warm account → home?invite=1 →
// account.leave {url} (the move stash dropped) → local.reset clears the slot.
// Opens the run's invite but never claims it: in `all`, retryable. results.inviteLink has the checks.

/** A raw bridge round trip (window.wgNative, any page of the open vault, /unlock included). */
const call = (page, op, args) => page.evaluate(([o, a]) => new Promise((resolve) => {
  const b = window.wgNative;
  if (!b) return resolve({ ok: false, error: 'no bridge' });
  const id = `qa-${Math.random()}`;
  const on = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id !== id) return;
    b.removeEventListener('message', on);
    resolve(m.error != null ? { ok: false, error: m.error } : { ok: true, result: m.result });
  };
  b.addEventListener('message', on);
  b.postMessage(JSON.stringify({ op: o, args: a || {}, id }));
  setTimeout(() => resolve({ ok: false, error: 'timeout' }), 10_000);
}), [op, args]).catch((e) => ({ ok: false, error: `page gone: ${String(e?.message).split('\n')[0]}` }));

const expect = (cond, what) => { if (!cond) throw new Error(what); };

export default async function inviteLink(ctx) {
  const { shell, pkg, sleep, LOCAL_ORIGIN } = ctx;
  if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
  const r = (ctx.results.inviteLink = {});
  const claim = new URL(ctx.claimUrl);
  const sub = claim.host.split('.')[0];
  const base = claim.host.slice(sub.length + 1);
  const tok = /claim=([0-9a-f]+)/.exec(claim.hash)[1];
  const want = `https://${claim.host}/#claim=${tok}`;
  const scheme = `medtracker://i/${sub}#${tok}`;
  const landing = `https://${base}/i/${sub}#${tok}`;
  const view = (url, explicit = false) =>
    shell(`am start -W -a android.intent.action.VIEW -d '${url}'${explicit ? ` -n ${pkg}/com.example.medtracker.InviteLinkActivity` : ''}`);
  const moveFiles = () => shell(`run-as ${pkg} sh -c 'ls no_backup/move 2>/dev/null; true'`);
  const seedMove = () => shell(`run-as ${pkg} sh -c 'mkdir -p no_backup/move && echo {} > no_backup/move/vault.json'`);
  const pending = async (page) => {
    let res = await call(page, 'invite.pending');
    // An account page may still redirect (/ → /unlock) under the first call.
    for (let i = 0; i < 5 && !res.ok && /page gone|no bridge|timeout/.test(res.error); i++) {
      await sleep(2000);
      res = await call(page, 'invite.pending');
    }
    expect(res.ok, `invite.pending: ${JSON.stringify(res)}`);
    return res.result;
  };
  const expectSlot = async (page, what) => {
    const slot = await pending(page);
    expect(slot && slot.url === want && Number.isInteger(slot.receivedAt) && slot.receivedAt > 1.6e12, `${what}: ${JSON.stringify(slot)}`);
  };
  const clear = async (page) => {
    const res = await call(page, 'invite.clear');
    expect(res.ok && res.result === true, `invite.clear: ${JSON.stringify(res)}`);
    expect((await pending(page)) === null, 'slot survived invite.clear');
  };
  /** The page after a navigation the shell started: re-attached, on `host`. */
  const pageOn = async (test) => {
    await sleep(2000);
    const p = await ctx.attachPage();
    if (!p) throw new Error('no WebView page');
    await p.waitForURL(test, { timeout: 60_000 });
    return p;
  };
  /** Warm delivery: the shell reloads home with ?invite=1 on the open page's origin. */
  const warm = async (page, url, origin, explicit = false) => {
    const seen = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) seen.push(f.url()); });
    await view(url, explicit);
    for (let i = 0; i < 30 && !seen.some((u) => u.startsWith(origin) && /[?&]invite=1/.test(u)); i++) await sleep(1000);
    expect(seen.some((u) => u.startsWith(origin) && /[?&]invite=1/.test(u)), `no ${origin} ?invite=1 load: ${JSON.stringify(seen)}`);
    return seen;
  };

  await shell(`pm clear ${pkg}`);
  await ctx.step('cold first run: medtracker:// fills the field, opens nothing', async () => {
    await view(scheme);
    await ctx.waitFor({ text: want }, 60_000);
    expect(await ctx.waitFor({ text: 'Continue' }, 5_000).then(() => true, () => false), 'not on the first run');
    await ctx.shot('firstrun-prefilled');
  });

  let page = await ctx.step('local mode: the slot persisted; invite.clear empties it', async () => {
    const p = await ctx.launchLocal('today');
    await expectSlot(p, 'after the first run');
    await clear(p);
    const ops = await call(p, 'shell.ops');
    expect(ops.ok && ['invite.pending', 'invite.clear', 'clipboard.read'].every((o) => ops.result.includes(o)), `shell.ops ${JSON.stringify(ops)}`);
    const clip = await call(p, 'clipboard.read');
    expect(clip.ok && (clip.result === null || typeof clip.result === 'string'), `clipboard.read: ${JSON.stringify(clip)}`);
    return p;
  });

  page = await ctx.step('cold local launch from the landing link: the slot, a plain home', async () => {
    await shell(`am force-stop ${pkg}`);
    await sleep(2000);
    await view(landing, true);
    const p = await pageOn((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`));
    await ctx.waitLocalReady(p);
    expect(!/invite=1/.test(p.url()), `cold start reloaded with invite=1: ${p.url()}`);
    await expectSlot(p, 'cold local');
    return p;
  });

  page = await ctx.step('warm local: medtracker:// reloads home?invite=1', async () => {
    await clear(page);
    r.warmLocal = await warm(page, scheme, `${LOCAL_ORIGIN}/`);
    const p = await pageOn((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`));
    await expectSlot(p, 'warm local');
    await ctx.shot('warm-local');
    return p;
  });

  await ctx.step('local.leave with an invalid url: refused, nothing changes', async () => {
    for (const url of ['', null, 42, '   ', 'https://evil.com/', `https://${base}/`, landing]) {
      const res = await call(page, 'local.leave', { url });
      expect(!res.ok && res.error === 'invalid url', `local.leave ${JSON.stringify(url)}: ${JSON.stringify(res)}`);
    }
    await sleep(1500);
    expect(page.url().startsWith(`${LOCAL_ORIGIN}/`), `left local mode: ${page.url()}`);
    await expectSlot(page, 'after refused leaves');
  });

  page = await ctx.step('local.leave {url}: the claim page, the move stash kept, the slot consumed', async () => {
    await seedMove();
    await call(page, 'local.leave', { url: ctx.claimUrl }); // the page goes away right after the reply
    const p = await pageOn((u) => u.host === claim.host);
    expect((await pending(p)) === null, 'the slot outlived local.leave {url}');
    expect((await moveFiles()) === 'vault.json', `local.leave {url} dropped the move stash: ${await moveFiles()}`);
    const xml = await shell(`run-as ${pkg} cat shared_prefs/shell.xml`);
    expect(xml.includes(`>${claim.host}<`) && /name="wgLocalMode" value="false"/.test(xml), `prefs: ${xml}`);
    await ctx.shot('claim-page');
    return p;
  });

  page = await ctx.step('warm account: medtracker:// reloads the account home with ?invite=1', async () => {
    r.warmAccount = await warm(page, scheme, `https://${claim.host}/`);
    const p = await pageOn((u) => u.host === claim.host);
    await expectSlot(p, 'warm account');
    return p;
  });

  page = await ctx.step('account.leave {url}: invalid refused; valid drops the move stash and the slot', async () => {
    for (const url of ['', null, 'https://evil.com/']) {
      const res = await call(page, 'account.leave', { url, then: 'local' });
      expect(!res.ok && res.error === 'invalid url', `account.leave ${JSON.stringify(url)}: ${JSON.stringify(res)}`);
    }
    expect((await moveFiles()) === 'vault.json', 'move stash gone before account.leave {url}');
    await call(page, 'account.leave', { url: ctx.claimUrl, then: 'local' }); // then is ignored
    const p = await pageOn((u) => u.host === claim.host);
    expect((await pending(p)) === null, 'the slot outlived account.leave {url}');
    expect((await moveFiles()) === '', `account.leave {url} kept the move stash: ${await moveFiles()}`);
    return p;
  });

  await ctx.step('local.reset clears the slot (A4)', async () => {
    await call(page, 'account.leave', { then: 'local' });
    let p = await pageOn((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`));
    await ctx.waitLocalReady(p);
    await warm(p, scheme, `${LOCAL_ORIGIN}/`);
    p = await pageOn((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`));
    await expectSlot(p, 'before local.reset');
    const res = await call(p, 'local.reset');
    expect(res.ok && res.result === true, `local.reset: ${JSON.stringify(res)}`);
    expect((await pending(p)) === null, 'local.reset kept the slot');
    page = p;
  });

  // W1 (web #1234) shows "Have an invite?" only in a v3 shell, in local mode, with no slot.
  await ctx.step('W1: "Have an invite?" with an empty slot, hidden once one waits', async () => {
    // An empty local origin, so the bundled app boots into W1 (as local-smoke wipes it).
    await page.goto(`${LOCAL_ORIGIN}/qa/scenes.json`, { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((d) => new Promise((res) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = res; })));
    });
    await page.goto(`${LOCAL_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    const button = page.locator('[data-firstrun-action="invite"]');
    await button.waitFor({ state: 'visible', timeout: 60_000 });
    await ctx.shot('w1-have-an-invite');
    await warm(page, scheme, `${LOCAL_ORIGIN}/`);
    const p = await pageOn((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`));
    // W1's title ('Medications' also matches hidden app nodes behind the overlay).
    await p.getByText('What do you want to track?').locator('visible=true').first().waitFor({ state: 'visible', timeout: 60_000 });
    await sleep(3000); // the footer's invite.pending probe
    expect((await p.locator('[data-firstrun-action="invite"]').count()) === 0, 'W1 offers an invite while one waits');
    await ctx.shot('w1-invited');
    r.ok = true;
  });
}
