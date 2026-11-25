import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  createApp,
  type AppServices,
  type CreateAppOptions,
} from './app';
import { resolveSecurityConfig } from './security';
import { NOW, bootstrap, ledgerAdapter, tempLedger, makeLiveMatch, makeServices, makeStore, mutation, startApp } from './testSupport';
import type { PersistedStore } from './store';
import { FileLedger } from './ledgerStore';
import { AdaptiveStore } from './adaptiveStore';
import {
  AdaptiveGuardError,
  createAdaptiveState,
  learnInShadow,
  productionModelOverrides,
  promoteCandidate,
  rollbackProduction,
} from '../src/engine/adaptiveController';
import {
  appendPrediction,
  calibrateLedger,
  settleLedgerForMatch,
  verifyLedger,
} from '../src/engine/ledger';
import type { ScrapedMatch, ValueAlert } from '../src/types/quant';
import { predictPureFlow, stripOddsForFirewall } from '../src/engine/predictionEngine';
import { evaluateBettingValue } from '../src/engine/valueEngine';

const MUTATIONS: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'POST', path: '/api/bets/reset' },
  { method: 'POST', path: '/api/bets/settle' },
  { method: 'DELETE', path: '/api/bets/bet_1' },
  { method: 'POST', path: '/api/push/test' },
  { method: 'POST', path: '/api/push/subscribe', body: { endpoint: 'https://push.example/x' } },
  { method: 'POST', path: '/api/adaptive/learn' },
  { method: 'POST', path: '/api/adaptive/promote', body: { candidateId: '0123456789abcdef' } },
  { method: 'POST', path: '/api/adaptive/rollback' },
];

test('mutating endpoints reject requests that never presented a session', async () => {
  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(makeLiveMatch(), state), now: () => NOW });
  try {
    for (const m of MUTATIONS) {
      const res = await mutation(app.base, m.path, { method: m.method, body: m.body });
      assert.equal(res.status, 401, `${m.method} ${m.path} must require a session`);
    }
    assert.equal(state.store.bets.length, 0);
    assert.equal(state.store.bankroll, 10000);
  } finally {
    await app.close();
  }
});

test('mutating endpoints reject requests without a matching CSRF header', async () => {
  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(makeLiveMatch(), state), now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);

    const missing = await mutation(app.base, '/api/bets/reset', {
      method: 'POST',
      cookies,
    });
    assert.equal(missing.status, 403);

    const wrong = await mutation(app.base, '/api/bets/reset', {
      method: 'POST',
      cookies,
      csrf: `${csrf.slice(0, -2)}00`,
    });
    assert.equal(wrong.status, 403);

    const crossSite = await mutation(app.base, '/api/bets/reset', {
      method: 'POST',
      csrf,
    });
    assert.equal(crossSite.status, 401);

    assert.equal(state.store.bankroll, 10000);
  } finally {
    await app.close();
  }
});

test('a tampered session cookie is not accepted as authentication', async () => {
  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(makeLiveMatch(), state), now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    const tampered = cookies.replace(/op_session=([^;]+)/, (_all, token: string) => {
      const last = token.slice(-1) === 'a' ? 'b' : 'a';
      return `op_session=${token.slice(0, -1)}${last}`;
    });
    assert.notEqual(tampered, cookies);

    const res = await mutation(app.base, '/api/bets/reset', {
      method: 'POST',
      cookies: tampered,
      csrf,
    });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('authenticated reset and deletion mutate the store', async () => {
  const state = { store: makeStore(500) };
  const app = await startApp({ services: makeServices(makeLiveMatch(), state), now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);

    const reset = await mutation(app.base, '/api/bets/reset', {
      method: 'POST',
      cookies,
      csrf,
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.equal(resetBody.bankroll, 10000);
    assert.equal(state.store.bankroll, 10000);

    state.store.bets = [
      {
        id: 'bet_manual_1',
        matchId: '401810001',
        sport: 'basketball',
        sportPath: 'basketball/nba',
        leagueName: 'NBA',
        homeTeam: 'Boston Celtics',
        awayTeam: 'Miami Heat',
        marketCategory: 'Moneyline (2-Way)',
        selection: 'Boston Celtics ML',
        side: 'home',
        stakeAmount: 100,
        bookmakerOdds: 1.65,
        fairProbAtPlacement: 0.62,
        evPctAtPlacement: 5,
        convictionAtPlacement: 60,
        oddsVerifiedLive: true,
        placedAt: NOW.toISOString(),
        status: 'pending',
        pnl: 0,
      },
    ];
    state.store.bankroll = 9900;

    const del = await mutation(app.base, '/api/bets/bet_manual_1', {
      method: 'DELETE',
      cookies,
      csrf,
    });
    assert.equal(del.status, 200);
    assert.equal(state.store.bets.length, 0);
    assert.equal(state.store.bankroll, 10000);
  } finally {
    await app.close();
  }
});

test('paper bets reconstruct probabilities server-side and ignore client-supplied evidence', async () => {
  const match = makeLiveMatch();
  const expected: ValueAlert[] = evaluateBettingValue(
    predictPureFlow(stripOddsForFirewall(match)),
    match.odds,
    {
      id: match.id,
      sport: match.sport,
      sportPath: match.sportPath,
      league: match.league,
      leagueName: match.leagueName,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      clockLabel: match.clockLabel,
      status: match.status,
      dataQuality: match.dataQuality,
      progressPct: match.progressPct,
    },
    { verifiedLiveOnly: false, minEvPct: -100, includeFinished: false, now: NOW }
  );
  const candidate = expected.find(
    (a) => a.marketCategory === 'Moneyline (2-Way)' && a.side === 'home'
  );
  assert.ok(candidate, 'test fixture must produce a home moneyline candidate');

  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(match, state), now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    const res = await mutation(app.base, '/api/bets', {
      method: 'POST',
      cookies,
      csrf,
      body: {
        matchId: match.id,
        marketCategory: 'Moneyline (2-Way)',
        side: 'home',
        line: null,
        stakeAmount: 100,
        bookmakerOdds: candidate.bookmakerOdds,
        // Forged client evidence must never be trusted.
        fairProbAtPlacement: 0.99,
        evPctAtPlacement: 999,
        convictionAtPlacement: 100,
        oddsVerifiedLive: false,
        sport: 'tennis',
        sportPath: 'tennis/fake',
        leagueName: 'Fake League',
        homeTeam: 'Hacker FC',
        awayTeam: 'Spoof FC',
        selection: 'Free Money',
      },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.bet.matchId, match.id);
    assert.equal(body.bet.marketCategory, 'Moneyline (2-Way)');
    assert.equal(body.bet.side, 'home');
    assert.equal(body.bet.sport, match.sport);
    assert.equal(body.bet.sportPath, match.sportPath);
    assert.equal(body.bet.homeTeam, match.homeTeam);
    assert.equal(body.bet.awayTeam, match.awayTeam);
    assert.equal(body.bet.selection, candidate.selection);
    assert.equal(body.bet.fairProbAtPlacement, candidate.fairProb);
    assert.equal(body.bet.evPctAtPlacement, candidate.evPct);
    assert.equal(body.bet.convictionAtPlacement, candidate.convictionScore);
    assert.equal(body.bet.oddsVerifiedLive, candidate.oddsVerifiedLive);
    assert.equal(body.bet.bookmakerOdds, candidate.bookmakerOdds);
    assert.equal(body.bet.stakeAmount, 100);
    assert.equal(state.store.bets.length, 1);
    assert.equal(state.store.bankroll, 9900);
  } finally {
    await app.close();
  }
});

test('paper bets are blocked when the selected price is stale or unprovenanced', async () => {
  const stale = makeLiveMatch();
  stale.odds = { ...stale.odds!, capturedAt: '2026-11-23T16:00:00.000Z' };
  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(stale, state), now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    const res = await mutation(app.base, '/api/bets', {
      method: 'POST',
      cookies,
      csrf,
      body: {
        matchId: stale.id,
        marketCategory: 'Moneyline (2-Way)',
        side: 'home',
        stakeAmount: 100,
        bookmakerOdds: 1.65,
      },
    });
    assert.equal(res.status, 409);
    assert.equal(state.store.bets.length, 0);
  } finally {
    await app.close();
  }
});

test('paper bets are blocked when the client price no longer matches the verified price', async () => {
  const match = makeLiveMatch();
  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(match, state), now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    const res = await mutation(app.base, '/api/bets', {
      method: 'POST',
      cookies,
      csrf,
      body: {
        matchId: match.id,
        marketCategory: 'Moneyline (2-Way)',
        side: 'home',
        stakeAmount: 100,
        bookmakerOdds: 9.99,
      },
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.currentPrice, 1.65);
    assert.equal(state.store.bets.length, 0);
  } finally {
    await app.close();
  }
});

test('paper bets reject invalid markets, stakes and malformed match identifiers', async () => {
  const match = makeLiveMatch();
  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(match, state), now: () => NOW });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    const cases = [
      { matchId: '../etc/passwd', marketCategory: 'Moneyline (2-Way)', side: 'home', stakeAmount: 100, bookmakerOdds: 1.65 },
      { matchId: match.id, marketCategory: 'Moneyline (2-Way)', side: 'middle', stakeAmount: 100, bookmakerOdds: 1.65 },
      { matchId: match.id, marketCategory: 'Moneyline (2-Way)', side: 'home', stakeAmount: -5, bookmakerOdds: 1.65 },
      { matchId: match.id, marketCategory: 'Moneyline (2-Way)', side: 'home', stakeAmount: 20000, bookmakerOdds: 1.65 },
      { matchId: match.id, marketCategory: 'Not A Market', side: 'home', stakeAmount: 100, bookmakerOdds: 1.65 },
    ];
    for (const body of cases) {
      const res = await mutation(app.base, '/api/bets', {
        method: 'POST',
        cookies,
        csrf,
        body,
      });
      assert.ok(res.status === 400 || res.status === 409, `unexpected ${res.status} for ${JSON.stringify(body)}`);
    }
    assert.equal(state.store.bets.length, 0);
  } finally {
    await app.close();
  }
});

test('mutation rate limiting returns 429 after the configured budget', async () => {
  const state = { store: makeStore() };
  const app = await startApp({
    services: makeServices(makeLiveMatch(), state),
    now: () => NOW,
    security: { mutationRateLimit: { windowMs: 60_000, max: 2 } },
  });
  try {
    const { cookies, csrf } = await bootstrap(app.base);
    for (let i = 0; i < 2; i++) {
      const res = await mutation(app.base, '/api/bets/reset', { method: 'POST', cookies, csrf });
      assert.equal(res.status, 200);
    }
    const limited = await mutation(app.base, '/api/bets/reset', { method: 'POST', cookies, csrf });
    assert.equal(limited.status, 429);
  } finally {
    await app.close();
  }
});

test('read endpoints issue a session without requiring one', async () => {
  const state = { store: makeStore() };
  const app = await startApp({ services: makeServices(makeLiveMatch(), state), now: () => NOW });
  try {
    const bets = await fetch(`${app.base}/api/bets`);
    assert.equal(bets.status, 200);
    assert.ok(bets.headers.getSetCookie().some((c) => c.startsWith('op_session=')));

    const matches = await fetch(`${app.base}/api/matches`);
    assert.equal(matches.status, 200);
    const body = await matches.json();
    assert.equal(body.matches.length, 1);
  } finally {
    await app.close();
  }
});

test('unexpected failures return a generic error instead of internal details', async () => {
  const logs: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  const state = { store: makeStore() };
  const services: Partial<AppServices> = {
    ...makeServices(makeLiveMatch(), state),
    scrapeMatches: async () => {
      throw new Error('upstream secret-token-abc123 failed');
    },
  };
  const app = await startApp({ services, now: () => NOW });
  try {
    const res = await fetch(`${app.base}/api/matches`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Failed to fetch live matches');
    assert.ok(!JSON.stringify(body).includes('secret-token'));
    assert.ok(logs.length >= 1);
  } finally {
    console.error = originalError;
    await app.close();
  }
});

test('security configuration refuses production without a secret and warns in development', () => {
  assert.throws(
    () => resolveSecurityConfig({ NODE_ENV: 'production' }),
    /SESSION_SECRET/
  );

  const explicit = resolveSecurityConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a'.repeat(64),
  });
  assert.equal(explicit.secret, 'a'.repeat(64));
  assert.equal(explicit.secureCookies, true);

  const warnings: string[] = [];
  const dev = resolveSecurityConfig({ NODE_ENV: 'development' }, (msg) => warnings.push(msg));
  assert.ok(dev.secret.length >= 32);
  assert.equal(dev.secureCookies, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SESSION_SECRET/);
});

test('different server instances with different secrets reject each other\'s sessions', async () => {
  const match = makeLiveMatch();
  const stateA = { store: makeStore() };
  const stateB = { store: makeStore() };
  const a = await startApp({
    services: makeServices(match, stateA),
    now: () => NOW,
    security: { secret: 'a'.repeat(64) },
  });
  const b = await startApp({
    services: makeServices(match, stateB),
    now: () => NOW,
    security: { secret: 'b'.repeat(64) },
  });
  try {
    const { cookies, csrf } = await bootstrap(a.base);
    const res = await mutation(b.base, '/api/bets/reset', {
      method: 'POST',
      cookies,
      csrf,
    });
    assert.equal(res.status, 401);
  } finally {
    await a.close();
    await b.close();
  }
});


test('matches polling records every verified prediction once in the immutable ledger', async () => {
  const ledger = tempLedger();
  const match = makeLiveMatch();
  const state = { store: makeStore() };
  const services = { ...makeServices(match, state), ledger: ledgerAdapter(ledger) };
  const app = await startApp({ services, now: () => NOW });
  try {
    const first = await fetch(`${app.base}/api/matches`);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.ok(body.alerts.length > 0);

    const entries = ledger.read();
    const priced = entries.filter(
      (e) => e.type === 'prediction' && (e.payload.snapshotKind ?? 'priced') === 'priced'
    );
    const modelOnly = entries.filter(
      (e) => e.type === 'prediction' && e.payload.snapshotKind === 'model_only'
    );
    // Every verified alert once, plus one unconditional (unbiased) model snapshot.
    assert.equal(priced.length, body.alerts.length);
    assert.equal(modelOnly.length, 1);
    assert.equal(entries.length, body.alerts.length + 1);
    assert.ok(
      priced.every((e) => e.type === 'prediction' && e.payload.pricing.priceVerified)
    );
    assert.ok(
      modelOnly.every(
        (e) =>
          e.type === 'prediction' &&
          e.payload.pricing.bookmakerOdds === 0 &&
          !e.payload.pricing.priceVerified
      )
    );
    assert.equal(verifyLedger(entries).valid, true);

    const second = await fetch(`${app.base}/api/matches`);
    assert.equal(second.status, 200);
    assert.equal(ledger.read().length, body.alerts.length + 1);

    const ledgerApi = await fetch(`${app.base}/api/ledger`);
    assert.equal(ledgerApi.status, 200);
    const ledgerBody = await ledgerApi.json();
    assert.equal(ledgerBody.verification.valid, true);
    // Default calibration is over priced alerts only; model-only is reported apart.
    assert.equal(ledgerBody.calibration.predictions, body.alerts.length);
    assert.equal(ledgerBody.modelCalibration.predictions, 1);
  } finally {
    await app.close();
  }
});

test('finished matches settle ledger predictions exactly once', async () => {
  const ledger = tempLedger();
  const state = { store: makeStore() };

  const liveApp = await startApp({
    services: { ...makeServices(makeLiveMatch(), state), ledger: ledgerAdapter(ledger) },
    now: () => NOW,
  });
  const liveRes = await fetch(`${liveApp.base}/api/matches`);
  const liveBody = await liveRes.json();
  await liveApp.close();
  assert.ok(liveBody.alerts.length > 0);

  const finished = makeLiveMatch({
    status: 'finished',
    homeScore: 112,
    awayScore: 104,
    clockLabel: 'Final',
  });
  const finishedApp = await startApp({
    services: { ...makeServices(finished, state), ledger: ledgerAdapter(ledger) },
    now: () => NOW,
  });
  try {
    await fetch(`${finishedApp.base}/api/matches`);
    const entries = ledger.read();
    const settlements = entries.filter((e) => e.type === 'settlement');
    // One settlement per alert plus one for the model-only snapshot.
    assert.equal(settlements.length, liveBody.alerts.length + 1);
    assert.ok(
      settlements.every(
        (s) =>
          s.type === 'settlement' &&
          (s.payload.status === 'won' ||
            s.payload.status === 'lost' ||
            s.payload.status === 'push')
      )
    );
    assert.equal(verifyLedger(entries).valid, true);

    await fetch(`${finishedApp.base}/api/matches`);
    assert.equal(ledger.read().length, entries.length);
    assert.equal(calibrateLedger(ledger.read()).settled, liveBody.alerts.length);
    assert.equal(calibrateLedger(ledger.read(), 'model_only').settled, 1);
  } finally {
    await finishedApp.close();
  }
});

test('a corrupt ledger file surfaces an explicit error and is never rewritten', async () => {
  const ledger = tempLedger();
  const file = ledger.paths().file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const corrupt = 'garbage that is not a ledger record\n';
  fs.writeFileSync(file, corrupt, 'utf-8');

  const state = { store: makeStore() };
  const app = await startApp({
    services: { ...makeServices(makeLiveMatch(), state), ledger: ledgerAdapter(ledger) },
    now: () => NOW,
  });
  try {
    const res = await fetch(`${app.base}/api/ledger`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /corrupted/i);
    assert.equal(fs.readFileSync(file, 'utf-8'), corrupt);
  } finally {
    await app.close();
  }
});

function adaptiveAdapter(store: AdaptiveStore): AppServices['adaptive'] {
  let state = store.load();
  return {
    status: () => state,
    learn: (records, nowIso) => {
      const result = learnInShadow(state, records, { now: nowIso });
      if (result.changed) {
        state = result.state;
        store.save(state);
      }
      return result;
    },
    promote: (candidateId, options) => {
      const result = promoteCandidate(state, candidateId, options);
      state = result.state;
      store.save(state);
      return result;
    },
    rollback: (options) => {
      const result = rollbackProduction(state, options);
      state = result.state;
      store.save(state);
      return result;
    },
    predictionOverrides: () => productionModelOverrides(state),
  };
}

function tempAdaptiveStore(): AdaptiveStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnipulse-adaptive-api-'));
  return new AdaptiveStore({ dataDir: dir });
}

test('adaptive controller is shadow-first: learning never changes production and promotion is operator-gated', async () => {
  const adaptiveStore = tempAdaptiveStore();
  const state = { store: makeStore() };
  const app = await startApp({
    services: {
      ...makeServices(makeLiveMatch(), state),
      adaptive: adaptiveAdapter(adaptiveStore),
    },
    now: () => NOW,
  });
  delete process.env.ADAPTIVE_PROMOTION_ENABLED;
  try {
    const statusRes = await fetch(`${app.base}/api/adaptive/status`);
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.production.parameterVersion, '2026.11-default-v1');
    assert.deepEqual(status.production.calibration, {});

    const { cookies, csrf } = await bootstrap(app.base);

    const learn = await mutation(app.base, '/api/adaptive/learn', {
      method: 'POST',
      cookies,
      csrf,
    });
    assert.equal(learn.status, 200);
    const learnBody = await learn.json();
    assert.equal(learnBody.changed, false);
    assert.equal(learnBody.state.production.parameterVersion, '2026.11-default-v1');

    const promote = await mutation(app.base, '/api/adaptive/promote', {
      method: 'POST',
      cookies,
      csrf,
      body: { candidateId: '0123456789abcdef' },
    });
    assert.equal(promote.status, 403);
    const promoteBody = await promote.json();
    assert.equal(promoteBody.code, 'promotion-disabled');

    const rollback = await mutation(app.base, '/api/adaptive/rollback', {
      method: 'POST',
      cookies,
      csrf,
    });
    assert.equal(rollback.status, 409);
    assert.equal((await rollback.json()).code, 'nothing-to-roll-back');

    const after = await (await fetch(`${app.base}/api/adaptive/status`)).json();
    assert.equal(after.production.parameterVersion, '2026.11-default-v1');
    assert.deepEqual(after.production.calibration, {});

    process.env.ADAPTIVE_PROMOTION_ENABLED = 'true';
    const unknown = await mutation(app.base, '/api/adaptive/promote', {
      method: 'POST',
      cookies,
      csrf,
      body: { candidateId: '0123456789abcdef' },
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'unknown-candidate');

    const malformed = await mutation(app.base, '/api/adaptive/promote', {
      method: 'POST',
      cookies,
      csrf,
      body: { candidateId: '../etc/passwd' },
    });
    assert.equal(malformed.status, 400);
  } finally {
    delete process.env.ADAPTIVE_PROMOTION_ENABLED;
    await app.close();
  }
});
