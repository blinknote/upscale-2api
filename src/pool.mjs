import { config } from './config.mjs';
import { accounts, acquire, callFn, classify, release, saveAccounts } from './session.mjs';
import { sleep } from './util.mjs';

export async function runPooled(fn, body, opts = {}) {
  const model = opts.model ?? null;
  const excluded = new Set();
  const deadline = Date.now() + (opts.waitMs ?? config.queueWaitMs);
  const maxTries = Math.max(2, Math.min(accounts.length * 2, 8));
  let last = null;
  let transient = 0;
  let authRetried = 0;

  for (let i = 0; i < maxTries; i++) {
    const a = await acquire(model, excluded, deadline);
    if (!a) break;
    try {
      const res = await callFn(a, fn, body, { timeoutMs: opts.timeoutMs });
      const c = classify(res);
      if (c.ok) {
        a.stats.ok += 1;
        a.lastError = null;
        if (opts.cost && a.credits != null) a.credits = Math.max(0, a.credits - opts.cost);
        saveAccounts();
        return { ok: true, data: res.body, account: a, ms: res.ms };
      }
      a.stats.fail += 1;
      a.lastError = c.msg;
      last = c;
      if (c.kind === 'auth') {
        let refreshed = false;
        try {
          const { refreshAccount } = await import('./session.mjs');
          await refreshAccount(a);
          refreshed = true;
        } catch {
          /* marked invalid */
        }
        if (refreshed && authRetried === 0) {
          authRetried += 1;
          i -= 1;
          continue;
        }
        excluded.add(a.id);
        continue;
      }
      if (c.kind === 'busy') {
        a.cooldownUntil = Date.now() + 2500;
        excluded.add(a.id);
        await sleep(300);
        continue;
      }
      if (c.kind === 'credits') {
        a.cooldownUntil = Date.now() + 30 * 60 * 1000;
        excluded.add(a.id);
        continue;
      }
      if (c.kind === 'model') {
        if (!a.blockedModels.includes(model)) a.blockedModels.push(model);
        saveAccounts();
        excluded.add(a.id);
        continue;
      }
      if (c.kind === 'transient') {
        transient += 1;
        if (transient <= 2) {
          await sleep(700 * transient);
          i -= 1;
          continue;
        }
        excluded.add(a.id);
        continue;
      }
      excluded.add(a.id);
    } catch (e) {
      a.stats.fail += 1;
      a.lastError = String(e?.message ?? e);
      last = { kind: 'error', msg: a.lastError };
      excluded.add(a.id);
    } finally {
      release(a);
    }
  }

  if (!accounts.length) return { ok: false, code: 'no_accounts', message: 'no upstream accounts configured' };
  return {
    ok: false,
    code: last?.kind ?? 'unavailable',
    message: last?.msg ?? 'all accounts busy or failed',
  };
}
