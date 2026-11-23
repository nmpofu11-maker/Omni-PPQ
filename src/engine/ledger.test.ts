import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendPrediction,
  appendSettlement,
  buildPredictionPayload,
  calibrateLedger,
  computeResultChecksum,
  GENESIS_HASH,
  settleLedgerForMatch,
  verifyLedger,
} from './ledger';
import type { PureFlowPrediction, ScrapedMatch, ValueAlert } from '../types/quant';
import type { EvidenceSummary } from '../types/quant';

const RECORDED_AT = '2026-11-23T18:00:00.000Z';

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
    homeStats: { fieldGoalPct: 51.2, threePointPct: 40.5, rebounds: 34 },
    awayStats: { fieldGoalPct: 44.0, threePointPct: 33.0, rebounds: 28 },
    dataQuality: 'play_by_play_boxscore',
    plays: [],
    odds: {
      moneylineHome: 2.1,
      moneylineAway: 1.75,
      priceKind: 'live',
      source: 'ESPN Bet',
      capturedAt: RECORDED_AT,
      marketId: 'nba-test:ESPN Bet',
      isLiveVerified: true,
    },
    ...overrides,
  };
}

const EVIDENCE: EvidenceSummary = {
  tier: 'play_by_play_boxscore',
  homeBox: 'complete',
  awayBox: 'complete',
  playsTimed: 10,
  playsTotal: 10,
  identityValid: true,
  notes: [],
};

function makePrediction(overrides: Partial<PureFlowPrediction> = {}): PureFlowPrediction {
  return {
    matchId: '401810001',
    sport: 'basketball',
    dataQuality: 'play_by_play_boxscore',
    modelVersion: 'pureflow-2.1.0',
    parameterVersion: '2026.11-default-v1',
    evidence: EVIDENCE,
    progressPct: 0.66,
    fairProbs: { homeWin: 0.58, awayWin: 0.42 },
    expectedRemaining: { homeMean: 10, awayMean: 9, totalMean: 19, spreadMean: 1 },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: [],
    confidence: 0.55,
    modelNotes: [],
    ...overrides,
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
    priceCapturedAt: RECORDED_AT,
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

test('ledger entries capture identity, probabilities, provenance, evidence and model versions', () => {
  const match = makeMatch();
  const alert = makeAlert();
  const payload = buildPredictionPayload(alert, makePrediction(), match, RECORDED_AT);

  assert.equal(payload.predictionId, alert.id);
  assert.equal(payload.matchId, match.id);
  assert.equal(payload.league, 'nba');
  assert.equal(payload.marketCategory, 'Moneyline (2-Way)');
  assert.equal(payload.side, 'home');
  assert.equal(payload.probabilities.fairProb, 0.58);
  assert.equal(payload.probabilities.fairOdds, 1.72);
  assert.equal(payload.pricing.bookmakerOdds, 2.1);
  assert.equal(payload.pricing.priceKind, 'live');
  assert.equal(payload.pricing.priceSource, 'ESPN Bet');
  assert.equal(payload.pricing.priceCapturedAt, RECORDED_AT);
  assert.equal(payload.model.modelVersion, 'pureflow-2.1.0');
  assert.equal(payload.model.parameterVersion, '2026.11-default-v1');
  assert.deepEqual(payload.evidence.evidence, EVIDENCE);
  assert.equal(payload.featureSnapshot.homeScore, 84);
  assert.equal(payload.featureSnapshot.awayScore, 78);
  // The odds firewall extends to the ledger's feature snapshot.
  assert.equal('odds' in (payload.featureSnapshot as Record<string, unknown>), false);
});

test('prediction appends are immutable and deduplicated by snapshot key', () => {
  const payload = buildPredictionPayload(makeAlert(), makePrediction(), makeMatch(), RECORDED_AT);
  const first = appendPrediction([], payload, RECORDED_AT);
  assert.equal(first.appended, true);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].prevHash, GENESIS_HASH);
  assert.equal(first.records[0].seq, 1);

  const duplicate = appendPrediction(first.records, payload, RECORDED_AT);
  assert.equal(duplicate.appended, false);
  assert.equal(duplicate.records, first.records);
  assert.equal(duplicate.records.length, 1);

  const repriced = buildPredictionPayload(
    makeAlert({ bookmakerOdds: 2.15, priceCapturedAt: '2026-11-23T18:00:30.000Z' }),
    makePrediction(),
    makeMatch(),
    '2026-11-23T18:00:30.000Z'
  );
  const updated = appendPrediction(first.records, repriced, '2026-11-23T18:00:30.000Z');
  assert.equal(updated.appended, true);
  assert.equal(updated.records.length, 2);
  assert.equal(updated.records[1].seq, 2);
  assert.equal(updated.records[1].prevHash, updated.records[0].hash);

  const verified = verifyLedger(updated.records);
  assert.equal(verified.valid, true);
});

test('hash chain verification detects tampering and broken ordering', () => {
  const payload = buildPredictionPayload(makeAlert(), makePrediction(), makeMatch(), RECORDED_AT);
  const { records } = appendPrediction([], payload, RECORDED_AT);
  assert.equal(verifyLedger(records).valid, true);

  const tampered = [
    {
      ...records[0],
      payload: {
        ...(records[0].payload as { probabilities: { fairProb: number } }),
        probabilities: {
          ...(records[0].payload as { probabilities: { fairProb: number } }).probabilities,
          fairProb: 0.99,
        },
      },
    },
  ];
  const verdict = verifyLedger(tampered as typeof records);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.brokenAt, 1);

  const reordered = [{ ...records[0], seq: 5 }];
  assert.equal(verifyLedger(reordered as typeof records).valid, false);
});

test('settlement appends are write-once and checksum-bound to the original prediction', () => {
  const payload = buildPredictionPayload(makeAlert(), makePrediction(), makeMatch(), RECORDED_AT);
  const { records } = appendPrediction([], payload, RECORDED_AT);

  const checksum = computeResultChecksum(payload.predictionId, 112, 104);
  const first = appendSettlement(
    records,
    {
      predictionId: payload.predictionId,
      status: 'won',
      homeScore: 112,
      awayScore: 104,
      settledAt: '2026-11-23T20:00:00.000Z',
      resultChecksum: checksum,
    },
    '2026-11-23T20:00:00.000Z'
  );
  assert.equal(first.appended, true);
  assert.equal(first.records.length, 2);
  assert.equal(first.records[1].type, 'settlement');

  const duplicate = appendSettlement(
    first.records,
    {
      predictionId: payload.predictionId,
      status: 'lost',
      homeScore: 100,
      awayScore: 110,
      settledAt: '2026-11-23T21:00:00.000Z',
      resultChecksum: computeResultChecksum(payload.predictionId, 100, 110),
    },
    '2026-11-23T21:00:00.000Z'
  );
  assert.equal(duplicate.appended, false);
  assert.equal(duplicate.error, 'already settled');
  assert.equal(duplicate.records.length, 2);

  const unknown = appendSettlement(records, {
    predictionId: 'missing',
    status: 'won',
    homeScore: 1,
    awayScore: 0,
    settledAt: RECORDED_AT,
    resultChecksum: computeResultChecksum('missing', 1, 0),
  });
  assert.equal(unknown.appended, false);
  assert.equal(unknown.error, 'unknown prediction');

  const badChecksum = appendSettlement(records, {
    predictionId: payload.predictionId,
    status: 'won',
    homeScore: 112,
    awayScore: 104,
    settledAt: RECORDED_AT,
    resultChecksum: 'deadbeef',
  });
  assert.equal(badChecksum.appended, false);
  assert.equal(badChecksum.error, 'result checksum mismatch');
});

test('match settlement settles every pending ledger prediction exactly once', () => {
  const match = makeMatch();
  const home = buildPredictionPayload(makeAlert(), makePrediction(), match, RECORDED_AT);
  const total = buildPredictionPayload(
    makeAlert({
      id: '401810001::Over / Under Total::over::224.5',
      marketCategory: 'Over / Under Total',
      selection: 'Over 224.5',
      side: 'over',
      line: 224.5,
      fairProb: 0.5,
      pushProb: 0.04,
    }),
    makePrediction(),
    match,
    RECORDED_AT
  );
  let records = appendPrediction([], home, RECORDED_AT).records;
  records = appendPrediction(records, total, RECORDED_AT).records;

  const finished = makeMatch({
    status: 'finished',
    homeScore: 112,
    awayScore: 104,
  });
  const first = settleLedgerForMatch(records, finished);
  assert.equal(first.appended, 2);
  assert.equal(first.records.length, 4);
  assert.equal(verifyLedger(first.records).valid, true);

  const homeSettlement = first.records.find(
    (r) => r.type === 'settlement' && r.payload.predictionId === home.predictionId
  );
  assert.ok(homeSettlement && homeSettlement.type === 'settlement');
  assert.equal(homeSettlement.payload.status, 'won');
  assert.equal(
    homeSettlement.payload.resultChecksum,
    computeResultChecksum(home.predictionId, 112, 104)
  );

  // Total = 216 < 224.5, so the over loses.
  const totalSettlement = first.records.find(
    (r) => r.type === 'settlement' && r.payload.predictionId === total.predictionId
  );
  assert.ok(totalSettlement && totalSettlement.type === 'settlement');
  assert.equal(totalSettlement.payload.status, 'lost');

  const again = settleLedgerForMatch(first.records, finished);
  assert.equal(again.appended, 0);
  assert.equal(again.records.length, 4);
});

test('ledger calibration scores decisive outcomes and masks pushes from Brier and log loss', () => {
  const match = makeMatch();
  const a = buildPredictionPayload(makeAlert({ fairProb: 0.6 }), makePrediction(), match, RECORDED_AT);
  const b = buildPredictionPayload(
    makeAlert({ id: 'b', side: 'away', selection: 'Miami Heat ML', fairProb: 0.7 }),
    makePrediction(),
    match,
    RECORDED_AT
  );
  const c = buildPredictionPayload(
    makeAlert({
      id: 'c',
      marketCategory: 'Over / Under Total',
      side: 'over',
      selection: 'Over 224.5',
      line: 224.5,
      fairProb: 0.55,
      pushProb: 0.05,
    }),
    makePrediction(),
    match,
    RECORDED_AT
  );
  let records = appendPrediction([], a, RECORDED_AT).records;
  records = appendPrediction(records, b, RECORDED_AT).records;
  records = appendPrediction(records, c, RECORDED_AT).records;

  records = appendSettlement(records, {
    predictionId: a.predictionId,
    status: 'won',
    homeScore: 1,
    awayScore: 0,
    settledAt: RECORDED_AT,
    resultChecksum: computeResultChecksum(a.predictionId, 1, 0),
  }).records;
  records = appendSettlement(records, {
    predictionId: b.predictionId,
    status: 'lost',
    homeScore: 1,
    awayScore: 0,
    settledAt: RECORDED_AT,
    resultChecksum: computeResultChecksum(b.predictionId, 1, 0),
  }).records;
  records = appendSettlement(records, {
    predictionId: c.predictionId,
    status: 'push',
    homeScore: 112,
    awayScore: 112,
    settledAt: RECORDED_AT,
    resultChecksum: computeResultChecksum(c.predictionId, 112, 112),
  }).records;

  const metrics = calibrateLedger(records);
  assert.equal(metrics.predictions, 3);
  assert.equal(metrics.settled, 3);
  assert.equal(metrics.decisive, 2);
  assert.equal(metrics.pushes, 1);
  const expectedBrier = (Math.pow(0.6 - 1, 2) + Math.pow(0.7 - 0, 2)) / 2;
  assert.ok(Math.abs(metrics.brierScore - expectedBrier) < 1e-9);
  const expectedLogLoss =
    (-Math.log(0.6) + -Math.log(1 - 0.7)) / 2;
  assert.ok(Math.abs(metrics.logLoss - expectedLogLoss) < 1e-6);
});

test('a corrupt ledger chain is reported, never silently repaired', () => {
  const payload = buildPredictionPayload(makeAlert(), makePrediction(), makeMatch(), RECORDED_AT);
  const { records } = appendPrediction([], payload, RECORDED_AT);
  const corrupted = [{ ...records[0], hash: 'f'.repeat(64) }];
  const verdict = verifyLedger(corrupted as typeof records);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.brokenAt, 1);
  assert.match(verdict.reason ?? '', /hash/);
});
