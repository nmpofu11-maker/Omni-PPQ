import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  getStorePaths,
  loadStore,
  saveStore,
} from './store';
import { FileLedger, LedgerCorruptionError } from './ledgerStore';
import {
  appendPrediction,
  appendSettlement,
  buildPredictionPayload,
  computeResultChecksum,
  GENESIS_HASH,
  type LedgerRecord,
  verifyLedger,
} from '../src/engine/ledger';
import type { PureFlowPrediction, ScrapedMatch, ValueAlert } from '../src/types/quant';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omnipulse-test-'));
}

function makeBet(id = 'bet_1') {
  return {
    id,
    matchId: '401810001',
    sport: 'basketball' as const,
    sportPath: 'basketball/nba',
    leagueName: 'NBA',
    homeTeam: 'Boston Celtics',
    awayTeam: 'Miami Heat',
    marketCategory: 'Moneyline (2-Way)' as const,
    selection: 'Boston Celtics ML',
    side: 'home' as const,
    stakeAmount: 100,
    bookmakerOdds: 2.1,
    fairProbAtPlacement: 0.58,
    evPctAtPlacement: 21.8,
    convictionAtPlacement: 74,
    oddsVerifiedLive: true,
    placedAt: '2026-11-23T18:00:00.000Z',
    status: 'pending' as const,
    pnl: 0,
  };
}

test('store round-trips bets and preserves unknown/legacy fields through migration', () => {
  const dataDir = tempDir();
  const initial = loadStore({ dataDir });
  assert.equal(initial.bankroll, 10000);
  assert.equal(initial.bets.length, 0);

  const pending = {
    ...initial,
    bankroll: 12345,
    initialBankroll: 5000,
    bets: [makeBet()],
    legacyNotes: { operator: 'local' },
  } as unknown as typeof initial;
  saveStore(pending, { dataDir });

  const loaded = loadStore({ dataDir });
  assert.equal(loaded.bankroll, 12345);
  assert.equal(loaded.initialBankroll, 5000);
  assert.equal(loaded.bets.length, 1);
  assert.equal(loaded.bets[0].id, 'bet_1');
  assert.equal(loaded.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    (loaded as unknown as { legacyNotes: unknown }).legacyNotes,
    { operator: 'local' }
  );
});

test('saves are atomic and keep the previous version as a backup', () => {
  const dataDir = tempDir();
  const paths = getStorePaths({ dataDir });
  const base = loadStore({ dataDir });

  saveStore({ ...base, bankroll: 9000 }, { dataDir });
  saveStore({ ...base, bankroll: 8000 }, { dataDir });

  assert.equal(JSON.parse(fs.readFileSync(paths.storeFile, 'utf-8')).bankroll, 8000);
  assert.equal(JSON.parse(fs.readFileSync(paths.backupFile, 'utf-8')).bankroll, 9000);

  const leftovers = fs
    .readdirSync(dataDir)
    .filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('corrupted store data is quarantined and recovered from the backup, never silently dropped', () => {
  const dataDir = tempDir();
  const paths = getStorePaths({ dataDir });
  const base = loadStore({ dataDir });
  saveStore({ ...base, bankroll: 9100 }, { dataDir });
  saveStore({ ...base, bankroll: 9200 }, { dataDir });

  const corrupt = '{"bankroll": 9200, "bets": [ BROKEN';
  fs.writeFileSync(paths.storeFile, corrupt, 'utf-8');

  const loaded = loadStore({ dataDir });
  assert.equal(loaded.bankroll, 9100);

  const quarantined = fs
    .readdirSync(dataDir)
    .filter((name) => name.startsWith('omnipulse-store.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, quarantined[0]), 'utf-8'), corrupt);

  // The main file is restored to the recovered backup content.
  assert.equal(JSON.parse(fs.readFileSync(paths.storeFile, 'utf-8')).bankroll, 9100);
});

test('corruption without a backup still preserves the original bytes in quarantine', () => {
  const dataDir = tempDir();
  const paths = getStorePaths({ dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  const corrupt = 'not json at all';
  fs.writeFileSync(paths.storeFile, corrupt, 'utf-8');

  const loaded = loadStore({ dataDir });
  assert.equal(loaded.bankroll, 10000);
  assert.equal(loaded.bets.length, 0);

  const quarantined = fs
    .readdirSync(dataDir)
    .filter((name) => name.startsWith('omnipulse-store.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, quarantined[0]), 'utf-8'), corrupt);
});

test('ledger file appends atomically, verifies its hash chain and refuses to touch corrupt files', () => {
  const dataDir = tempDir();
  const ledger = new FileLedger({ dataDir });
  assert.deepEqual(ledger.read(), []);

  const match = makeMatch();
  const alert = makeAlert();
  const payload = buildPredictionPayload(alert, makePrediction(), match, '2026-11-23T18:00:00.000Z');
  const appended = ledger.appendRecords((existing) => appendPrediction(existing, payload).records);
  assert.equal(appended, 1);

  const records = ledger.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].prevHash, GENESIS_HASH);
  assert.equal(verifyLedger(records).valid, true);

  const duplicate = ledger.appendRecords((existing) => appendPrediction(existing, payload).records);
  assert.equal(duplicate, 0);

  const settlement = computeResultChecksum(payload.predictionId, 112, 104);
  const settled = ledger.appendRecords(
    (existing) =>
      appendSettlement(existing, {
        predictionId: payload.predictionId,
        status: 'won',
        homeScore: 112,
        awayScore: 104,
        settledAt: '2026-11-23T20:00:00.000Z',
        resultChecksum: settlement,
      }).records
  );
  assert.equal(settled, 1);
  assert.equal(verifyLedger(ledger.read()).valid, true);

  const paths = ledger.paths();
  const corrupt = `${fs.readFileSync(paths.file, 'utf-8')}{"broken":`;
  fs.writeFileSync(paths.file, corrupt, 'utf-8');

  assert.throws(() => ledger.read(), LedgerCorruptionError);
  assert.throws(
    () => ledger.appendRecords((existing) => appendPrediction(existing, payload).records),
    LedgerCorruptionError
  );
  assert.equal(fs.readFileSync(paths.file, 'utf-8'), corrupt);
});

test('a tampered ledger chain is rejected before any further append', () => {
  const dataDir = tempDir();
  const ledger = new FileLedger({ dataDir });
  const payload = buildPredictionPayload(
    makeAlert(),
    makePrediction(),
    makeMatch(),
    '2026-11-23T18:00:00.000Z'
  );
  ledger.appendRecords((existing) => appendPrediction(existing, payload).records);

  const paths = ledger.paths();
  const records = JSON.parse(
    `[${fs.readFileSync(paths.file, 'utf-8').trim().split('\n').join(',')}]`
  ) as LedgerRecord[];
  records[0] = { ...records[0], hash: 'f'.repeat(64) };
  fs.writeFileSync(paths.file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');

  assert.throws(() => ledger.read(), LedgerCorruptionError);
  assert.throws(
    () => ledger.appendRecords((existing) => appendPrediction(existing, payload).records),
    LedgerCorruptionError
  );
});

function makeMatch(overrides: Partial<ScrapedMatch> = {}): ScrapedMatch {
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
    homeStats: {},
    awayStats: {},
    dataQuality: 'play_by_play_boxscore',
    plays: [],
    ...overrides,
  };
}

function makePrediction(): PureFlowPrediction {
  return {
    matchId: '401810001',
    sport: 'basketball',
    dataQuality: 'play_by_play_boxscore',
    modelVersion: 'pureflow-2.1.0',
    parameterVersion: '2026.11-default-v1',
    evidence: {
      tier: 'play_by_play_boxscore',
      homeBox: 'complete',
      awayBox: 'complete',
      playsTimed: 1,
      playsTotal: 1,
      identityValid: true,
      notes: [],
    },
    progressPct: 0.66,
    fairProbs: { homeWin: 0.58, awayWin: 0.42 },
    expectedRemaining: { homeMean: 10, awayMean: 9, totalMean: 19, spreadMean: 1 },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: [],
    confidence: 0.55,
    modelNotes: [],
  } as PureFlowPrediction;
}

function makeAlert(overrides: Partial<ValueAlert> = {}): ValueAlert {
  return {
    id: '401810001::Moneyline (2-Way)::home::ml',
    matchId: '401810001',
    sport: 'basketball',
    sportPath: 'basketball/nba',
    league: 'nba',
    leagueName: 'NBA',
    homeTeam: 'Boston Celtics',
    awayTeam: 'Miami Heat',
    clockLabel: 'Q3 04:12',
    status: 'live',
    marketCategory: 'Moneyline (2-Way)',
    selection: 'Boston Celtics ML',
    side: 'home',
    fairProb: 0.58,
    lossProb: 0.42,
    pushProb: 0,
    fairOdds: 1.72,
    bookmakerOdds: 2.1,
    impliedProb: 0.4762,
    evPct: 21.8,
    kellyQuarterStakePct: 3.1,
    oddsVerifiedLive: true,
    oddsLabel: 'Verified Live',
    priceVerified: true,
    priceKind: 'live',
    priceSource: 'ESPN Bet',
    priceCapturedAt: '2026-11-23T18:00:00.000Z',
    dataQuality: 'play_by_play_boxscore',
    progressPct: 0.66,
    modelProbability: 0.58,
    dataQualityScore: 1,
    uncertaintyScore: 0.45,
    calibrationScore: 1,
    convictionScore: 74,
    rankingScore: 74,
    ...overrides,
  };
}
