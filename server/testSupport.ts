import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppServices, type CreateAppOptions } from './app';
import type { PersistedStore } from './store';
import { AdaptiveGuardError, createAdaptiveState } from '../src/engine/adaptiveController';
import type { ScrapedMatch } from '../src/types/quant';
import { FileLedger } from './ledgerStore';
import { appendPredictionsBatch, calibrateLedger, settleLedgerForMatch, verifyLedger } from '../src/engine/ledger';

/** Shared fixtures for API-level tests (not itself a test file). */
export const NOW = new Date('2026-11-23T18:00:00Z');

export function makeLiveMatch(overrides: Partial<ScrapedMatch> = {}): ScrapedMatch {
  return {
    id: '401810001',
    sport: 'basketball',
    league: 'nba',
    leagueName: 'NBA',
    sportPath: 'basketball/nba',
    status: 'live',
    startTime: '2026-11-23T17:00:00Z',
    clockLabel: 'Q3 04:12',
    period: 3,
    progressPct: 0.66,
    regulationMinutes: 48,
    homeTeam: 'Boston Celtics',
    awayTeam: 'Miami Heat',
    homeScore: 84,
    awayScore: 78,
    homeRecord: '14-3',
    awayRecord: '9-8',
    homeStats: { fieldGoalPct: 51.2, threePointPct: 40.5, rebounds: 34, assists: 22, turnovers: 7 },
    awayStats: { fieldGoalPct: 44.0, threePointPct: 33.0, rebounds: 28, assists: 17, turnovers: 11 },
    dataQuality: 'play_by_play_boxscore',
    plays: [],
    odds: {
      moneylineHome: 1.65,
      moneylineAway: 2.35,
      spreadLine: -5.5,
      spreadHomeOdds: 1.95,
      spreadAwayOdds: 1.95,
      totalLine: 224.5,
      overOdds: 1.91,
      underOdds: 1.91,
      priceKind: 'live',
      source: 'ESPN Bet',
      capturedAt: NOW.toISOString(),
      marketId: 'nba-test:ESPN Bet',
      isLiveVerified: true,
    },
    ...overrides,
  };
}

export function makeStore(bankroll = 10000): PersistedStore {
  return {
    bankroll,
    initialBankroll: 10000,
    bets: [],
    firestoreConfig: { enabled: false, collectionName: 'omnipulse_paper_bets' },
  };
}

export function makeServices(match: ScrapedMatch, state: { store: PersistedStore }): Partial<AppServices> {
  return {
    scrapeMatches: async () => [match],
    fetchMatchSummary: async (id: string) => {
      if (id !== match.id) throw new Error('not found');
      return match;
    },
    getCatalog: () => [{ id: 'nba', sport: 'basketball', name: 'NBA', slug: 'basketball/nba' }],
    store: {
      load: () => JSON.parse(JSON.stringify(state.store)) as PersistedStore,
      save: (next) => {
        state.store = JSON.parse(JSON.stringify(next)) as PersistedStore;
      },
    },
    ledger: {
      recordPredictions: () => 0,
      settleMatch: () => 0,
      snapshot: () => ({
        entries: [],
        verification: { valid: true },
        calibration: {
          predictions: 0,
          settled: 0,
          decisive: 0,
          pushes: 0,
          brierScore: 0,
          logLoss: 0,
        },
      }),
    },
    push: {
      getPublicKey: () => 'test-key',
      subscriptionCount: () => 0,
      addSubscription: () => {},
      dispatchBestBet: async () => ({ sent: 0, skipped: true }),
      sendTest: async () => ({ sent: 0 }),
    },
    adaptive: {
      status: () => createAdaptiveState(NOW.toISOString()),
      learn: () => ({
        state: createAdaptiveState(NOW.toISOString()),
        changed: false,
        reason: 'no new verified settlements',
      }),
      promote: () => {
        throw new AdaptiveGuardError(
          'promotion-disabled',
          'Adaptive promotion is disabled; set ADAPTIVE_PROMOTION_ENABLED=true for an explicit operator promotion'
        );
      },
      rollback: () => {
        throw new AdaptiveGuardError(
          'nothing-to-roll-back',
          'No previous production parameters to roll back to'
        );
      },
      predictionOverrides: () => ({}),
    },
  };
}

export async function startApp(options: CreateAppOptions) {
  const app = createApp(options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface Bootstrapped {
  cookies: string;
  csrf: string;
}

export async function bootstrap(base: string): Promise<Bootstrapped> {
  const res = await fetch(`${base}/api/leagues`);
  assert.equal(res.status, 200);
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const csrf = /(?:^|;\s*)op_csrf=([^;]+)/.exec(cookies)?.[1] ?? '';
  assert.ok(cookies.includes('op_session='));
  assert.ok(csrf.length >= 32);
  return { cookies, csrf };
}

export function mutation(base: string, path: string, init: {
  method: string;
  body?: unknown;
  cookies?: string;
  csrf?: string;
}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.cookies) headers.Cookie = init.cookies;
  if (init.csrf !== undefined) headers['x-csrf-token'] = init.csrf;
  return fetch(`${base}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}


export function ledgerAdapter(fileLedger: FileLedger): AppServices['ledger'] {
  return {
    recordPredictions: (payloads) =>
      fileLedger.appendRecords((existing) => appendPredictionsBatch(existing, payloads).records),
    settleMatch: (match) =>
      fileLedger.appendRecords((existing) => settleLedgerForMatch(existing, match).records),
    snapshot: () => {
      const entries = fileLedger.read();
      return {
        entries,
        verification: verifyLedger(entries),
        calibration: calibrateLedger(entries),
        modelCalibration: calibrateLedger(entries, 'model_only'),
      };
    },
  };
}

export function tempLedger(): FileLedger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnipulse-ledger-'));
  return new FileLedger({ dataDir: dir });
}
