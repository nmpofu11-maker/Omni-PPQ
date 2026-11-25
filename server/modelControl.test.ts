import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { requireAdmin } from './security';
import type { PersistedStore } from './store';
import type { AppServices } from './app';
import type { PaperBet, ScrapedMatch } from '../src/types/quant';
import {
  NOW,
  bootstrap,
  ledgerAdapter,
  makeLiveMatch,
  makeServices,
  makeStore,
  mutation,
  startApp,
  tempLedger,
} from './testSupport';

const ADMIN_ROUTES: Array<{ path: string; body?: unknown }> = [
  { path: '/api/adaptive/learn' },
  { path: '/api/adaptive/promote', body: { candidateId: '0123456789abcdef' } },
  { path: '/api/adaptive/rollback' },
  { path: '/api/push/test' },
];

test('model-control endpoints need the admin token; a session cookie alone is not enough', async () => {
  const state = { store: makeStore() };
  const app = await startApp({
    services: makeServices(makeLiveMatch(), state),
    now: () => NOW,
    admin: { token: 's3cret-admin-token', production: true },
  });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    for (const route of ADMIN_ROUTES) {
      // Valid session + CSRF, no admin credential.
      const anon = await mutation(app.base, route.path, { method: 'POST', cookies, csrf, body: route.body });
      assert.equal(anon.status, 401, `${route.path} must reject a plain session`);

      const wrong = await fetch(`${app.base}${route.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookies,
          'x-csrf-token': csrf,
          Authorization: 'Bearer not-the-token',
        },
        body: route.body === undefined ? undefined : JSON.stringify(route.body),
      });
      assert.equal(wrong.status, 401, `${route.path} must reject a wrong token`);
    }

    const ok = await fetch(`${app.base}/api/adaptive/learn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookies,
        'x-csrf-token': csrf,
        Authorization: 'Bearer s3cret-admin-token',
      },
    });
    assert.equal(ok.status, 200);
  } finally {
    await app.close();
  }
});

test('in production without ADMIN_TOKEN the model-control endpoints are closed, not open', async () => {
  const state = { store: makeStore() };
  const app = await startApp({
    services: makeServices(makeLiveMatch(), state),
    now: () => NOW,
    admin: { token: undefined, production: true },
  });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    for (const route of ADMIN_ROUTES) {
      const res = await mutation(app.base, route.path, { method: 'POST', cookies, csrf, body: route.body });
      assert.equal(res.status, 503, `${route.path} must be disabled`);
    }
  } finally {
    await app.close();
  }
});

test('without a token (development) only a direct loopback connection is admitted', () => {
  const guard = requireAdmin({ token: undefined, production: false });
  const run = (remoteAddress: string, headers: Record<string, string> = {}) => {
    let status = 200;
    let nexted = false;
    const req = { headers, socket: { remoteAddress } } as unknown as Request;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    guard(req, res, () => {
      nexted = true;
    });
    return { status, nexted };
  };
  assert.equal(run('127.0.0.1').nexted, true);
  assert.equal(run('::1').nexted, true);
  assert.equal(run('::ffff:127.0.0.1').nexted, true);
  const remote = run('203.0.113.9');
  assert.equal(remote.nexted, false);
  assert.equal(remote.status, 403);
  // A forged forwarding header must not turn a remote caller into "localhost".
  assert.equal(run('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }).nexted, false);
});

test('concurrent paper bets are all persisted and the bankroll is exact (no lost update)', async () => {
  const match = makeLiveMatch();
  const state = { store: makeStore() };
  const base = makeServices(match, state);
  const services: Partial<AppServices> = {
    ...base,
    // Latency makes the two requests overlap across the await, which is where a
    // load-before-await / save-after-await implementation loses one of them.
    fetchMatchSummary: async (id: string) => {
      await new Promise((r) => setTimeout(r, 25));
      return (base.fetchMatchSummary as (id: string) => Promise<ScrapedMatch>)(id);
    },
  };
  const app = await startApp({ services, now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    const place = (stakeAmount: number) =>
      mutation(app.base, '/api/bets', {
        method: 'POST',
        cookies,
        csrf,
        body: {
          matchId: match.id,
          marketCategory: 'Moneyline (2-Way)',
          side: 'home',
          line: null,
          stakeAmount,
          bookmakerOdds: 1.65,
        },
      });
    const [a, b, c] = await Promise.all([place(100), place(200), place(300)]);
    assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
    assert.equal(state.store.bets.length, 3, 'no bet may be lost');
    assert.equal(state.store.bankroll, 10000 - 600);
  } finally {
    await app.close();
  }
});

test('settling does not discard a bet placed while results were being fetched', async () => {
  const match = makeLiveMatch();
  const finished = makeLiveMatch({ status: 'finished', homeScore: 112, awayScore: 104, clockLabel: 'Final' });
  const bet = (id: string, stake: number): PaperBet => ({
    id,
    matchId: match.id,
    sport: 'basketball',
    sportPath: 'basketball/nba',
    leagueName: 'NBA',
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    marketCategory: 'Moneyline (2-Way)',
    selection: `${match.homeTeam} ML`,
    side: 'home',
    stakeAmount: stake,
    bookmakerOdds: 2,
    fairProbAtPlacement: 0.5,
    evPctAtPlacement: 0,
    convictionAtPlacement: 50,
    oddsVerifiedLive: true,
    placedAt: NOW.toISOString(),
    status: 'pending',
    pnl: 0,
  });
  const store: PersistedStore = { ...makeStore(9900), bets: [bet('bet_existing', 100)] };
  const state = { store };

  const base = makeServices(match, state);
  const services: Partial<AppServices> = {
    ...base,
    fetchMatchSummary: async () => {
      await new Promise((r) => setTimeout(r, 15));
      // A concurrent request places another bet while we are "fetching".
      if (!state.store.bets.some((b) => b.id === 'bet_concurrent')) {
        state.store = {
          ...state.store,
          bankroll: state.store.bankroll - 50,
          bets: [bet('bet_concurrent', 50), ...state.store.bets],
        };
      }
      return finished;
    },
  };
  const app = await startApp({ services, now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    const res = await mutation(app.base, '/api/bets/settle', { method: 'POST', cookies, csrf });
    assert.equal(res.status, 200);
    const ids = state.store.bets.map((b) => b.id).sort();
    assert.deepEqual(ids, ['bet_concurrent', 'bet_existing']);
    const existing = state.store.bets.find((b) => b.id === 'bet_existing');
    const concurrent = state.store.bets.find((b) => b.id === 'bet_concurrent');
    assert.equal(existing?.status, 'won');
    assert.equal(concurrent?.status, 'won', 'the concurrently placed bet is on the same finished match');
    // 9900 - 50 (concurrent stake) + (100+100) + (50+50) settlement credits
    assert.equal(state.store.bankroll, 9900 - 50 + 200 + 100);
  } finally {
    await app.close();
  }
});

test('rate limiting is per client behind a trusted proxy, and cannot be spoofed without one', async () => {
  const run = async (trustProxy: number | undefined) => {
    const state = { store: makeStore() };
    const app = await startApp({
      services: makeServices(makeLiveMatch(), state),
      now: () => NOW,
      security: { mutationRateLimit: { windowMs: 60_000, max: 2 } },
      trustProxy,
    });
    try {
      const { cookies, csrf } = await bootstrap(app.base);
      const reset = (ip: string) =>
        fetch(`${app.base}/api/bets/reset`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookies,
            'x-csrf-token': csrf,
            'X-Forwarded-For': ip,
          },
        });
      assert.equal((await reset('198.51.100.1')).status, 200);
      assert.equal((await reset('198.51.100.1')).status, 200);
      const sameClient = (await reset('198.51.100.1')).status;
      const otherClient = (await reset('198.51.100.2')).status;
      return { sameClient, otherClient };
    } finally {
      await app.close();
    }
  };

  const behindProxy = await run(1);
  assert.equal(behindProxy.sameClient, 429);
  assert.equal(behindProxy.otherClient, 200, 'a different client must not share the first client budget');

  const untrusted = await run(undefined);
  assert.equal(untrusted.sameClient, 429);
  assert.equal(untrusted.otherClient, 429, 'forwarded headers are ignored unless a proxy is trusted');
});

test('a match with no priced alert still yields an unbiased model snapshot', async () => {
  const ledger = tempLedger();
  const noOdds = makeLiveMatch({ odds: undefined });
  const state = { store: makeStore() };
  const app = await startApp({
    services: { ...makeServices(noOdds, state), ledger: ledgerAdapter(ledger) },
    now: () => NOW,
  });
  try {
    const res = await fetch(`${app.base}/api/matches`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.alerts.length, 0);
    const entries = ledger.read();
    assert.equal(entries.length, 1);
    const [only] = entries;
    assert.ok(only.type === 'prediction' && only.payload.snapshotKind === 'model_only');
    // Repeated polls inside the same progress bucket do not duplicate it.
    await fetch(`${app.base}/api/matches`);
    assert.equal(ledger.read().length, 1);
  } finally {
    await app.close();
  }
});
