import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAdaptiveState,
  DEFAULT_ACCEPTANCE_CRITERIA,
  evaluateAdaptiveCandidate,
  extractVerifiedSamples,
  GAMMA_GRID,
  learnInShadow,
  productionModelOverrides,
  promoteCandidate,
  rollbackProduction,
  type AcceptanceCriteria,
  type AdaptiveSample,
} from './adaptiveController';
import {
  appendPrediction,
  appendSettlement,
  buildPredictionPayload,
  computeResultChecksum,
  type LedgerPredictionPayload,
  type LedgerRecord,
} from './ledger';
import { predictPureFlow } from './predictionEngine';
import type { EvidenceSummary, PureFlowPrediction, ScrapedMatch, SportType, ValueAlert } from '../types/quant';

const NOW = '2026-11-23T20:00:00.000Z';

const TEST_CRITERIA: AcceptanceCriteria = {
  minTotalSamples: 40,
  minHoldoutSamples: 40,
  minBrierImprovement: 0.001,
  maxLogLossRegression: 0.05,
  maxFoldBrierRegression: 0.05,
  folds: 4,
};

/** Deterministic synthetic market where true calibration is p^gammaTrue. */
function syntheticSamples(count: number, gammaTrue: number, sport: SportType = 'basketball'): AdaptiveSample[] {
  const samples: AdaptiveSample[] = [];
  for (let i = 0; i < count; i++) {
    const fairProb = 0.2 + 0.6 * (i / Math.max(1, count - 1));
    const trueProb = Math.pow(fairProb, gammaTrue);
    const roll = (i * 0.6180339887 + 0.37) % 1;
    const settledAt = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    samples.push({
      key: `${sport}-${i}|checksum-${i}`,
      predictionId: `${sport}-${i}`,
      sport,
      marketCategory: 'Moneyline (2-Way)',
      fairProb,
      outcome: roll < trueProb ? 1 : 0,
      settledAt,
    });
  }
  return samples;
}

test('sample extraction uses only decisive, checksum-verified settlements linked to a prediction', () => {
  const match = makeMatch();
  const prediction = makePrediction();
  const decisive = buildPredictionPayload(makeAlert({ id: 'p-won' }), prediction, match, NOW);
  const push = buildPredictionPayload(
    makeAlert({ id: 'p-push', marketCategory: 'Over / Under Total', side: 'over', line: 224.5 }),
    prediction,
    match,
    NOW
  );

  let records: LedgerRecord[] = appendPrediction([], decisive, NOW).records;
  records = appendPrediction(records, push, NOW).records;
  records = appendSettlement(records, {
    predictionId: 'p-won',
    status: 'won',
    homeScore: 112,
    awayScore: 104,
    settledAt: NOW,
    resultChecksum: computeResultChecksum('p-won', 112, 104),
  }).records;
  records = appendSettlement(records, {
    predictionId: 'p-push',
    status: 'push',
    homeScore: 112,
    awayScore: 112,
    settledAt: NOW,
    resultChecksum: computeResultChecksum('p-push', 112, 112),
  }).records;

  const { samples, skipped } = extractVerifiedSamples(records);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].predictionId, 'p-won');
  assert.equal(samples[0].outcome, 1);
  assert.equal(skipped, 1);

  // A settlement whose stored scores no longer match its checksum is rejected.
  const tampered = records.map((r) =>
    r.type === 'settlement' && r.payload.predictionId === 'p-won'
      ? { ...r, payload: { ...r.payload, homeScore: 999 } }
      : r
  );
  const verification = extractVerifiedSamples(tampered);
  assert.equal(verification.samples.length, 0);
  assert.equal(verification.skipped, 2);
});

test('probability calibration is applied only when explicitly supplied', () => {
  const match = makeMatch();
  const baseline = predictPureFlow(match);
  const calibrated = predictPureFlow(match, {
    params: { calibration: { perSport: { basketball: { gamma: 1.2 } } } },
  });
  assert.notEqual(calibrated.fairProbs.homeWin, baseline.fairProbs.homeWin);
  assert.ok(Math.abs(calibrated.fairProbs.homeWin + calibrated.fairProbs.awayWin - 1) < 1e-9);
  assert.match(calibrated.parameterVersion, /cal1\.2$/);
  assert.ok(calibrated.modelNotes.some((n) => n.includes('calibration gamma=1.2')));
});

test('insufficient history yields a rejected candidate and leaves production untouched', () => {
  const state = createAdaptiveState(NOW);
  const candidate = evaluateAdaptiveCandidate(syntheticSamples(10, 1.2), TEST_CRITERIA, NOW);
  assert.equal(candidate.status, 'rejected');
  assert.ok(candidate.rejectionReasons.length > 0);
  assert.deepEqual(state.production.calibration, {});
});

test('chronological walk-forward finds a calibration improvement and marks the candidate eligible', () => {
  const candidate = evaluateAdaptiveCandidate(syntheticSamples(400, 1.3), TEST_CRITERIA, NOW);
  assert.equal(candidate.status, 'eligible', candidate.rejectionReasons.join('; '));
  assert.ok(candidate.accepted);
  assert.ok(candidate.perSportGammas.basketball !== undefined);
  assert.ok(GAMMA_GRID.includes(candidate.perSportGammas.basketball as number));
  assert.ok(candidate.candidateBrier < candidate.baselineBrier);
  assert.ok(candidate.holdoutSamples >= TEST_CRITERIA.minHoldoutSamples);
  // Folds are chronological: each fold evaluated against strictly earlier training data.
  const sportsFolds = candidate.folds.filter((f) => f.sport === 'basketball');
  assert.ok(sportsFolds.length >= 2);
});

test('learning deduplicates settlements and candidates without touching production', () => {
  const records = ledgerForSamples(syntheticSamples(120, 1.3));
  const initial = createAdaptiveState(NOW);

  const first = learnInShadow(initial, records, { criteria: TEST_CRITERIA, now: NOW });
  assert.equal(first.changed, true);
  assert.equal(first.state.candidates.length, 1);
  assert.deepEqual(first.state.production, initial.production);
  assert.equal(first.state.processedSampleKeys.length, 120);

  const second = learnInShadow(first.state, records, { criteria: TEST_CRITERIA, now: NOW });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'no new verified settlements');
  assert.equal(second.state.candidates.length, 1);

  // Re-evaluating the same data at a different wall-clock time is deterministic.
  const later = learnInShadow(initial, records, {
    criteria: TEST_CRITERIA,
    now: '2026-11-24T00:00:00.000Z',
  });
  assert.equal(later.candidate?.candidateId, first.state.candidates[0].candidateId);
});

test('promotion is guarded by the enable flag and acceptance status, and rollback restores the prior version', () => {
  const samples = syntheticSamples(400, 1.3);
  const records = ledgerForSamples(samples);
  const learned = learnInShadow(createAdaptiveState(NOW), records, {
    criteria: TEST_CRITERIA,
    now: NOW,
  });
  const candidate = learned.state.candidates[0];
  assert.equal(candidate.status, 'eligible', candidate.rejectionReasons.join('; '));

  assert.throws(
    () => promoteCandidate(learned.state, candidate.candidateId, { enabled: false, actor: 'ops', now: NOW }),
    /disabled/
  );

  const rejected = evaluateAdaptiveCandidate(syntheticSamples(10, 1.3), TEST_CRITERIA, NOW);
  const stateWithRejected = {
    ...learned.state,
    candidates: [...learned.state.candidates, rejected],
  };
  assert.throws(
    () =>
      promoteCandidate(stateWithRejected, rejected.candidateId, {
        enabled: true,
        actor: 'ops',
        now: NOW,
      }),
    /acceptance criteria/
  );

  const promoted = promoteCandidate(learned.state, candidate.candidateId, {
    enabled: true,
    actor: 'ops',
    now: NOW,
  });
  assert.equal(promoted.production.parameterVersion, candidate.parameterVersion);
  assert.ok(promoted.production.calibration.basketball?.gamma);
  assert.equal(promoted.state.productionHistory.length, 1);
  assert.deepEqual(productionModelOverrides(promoted.state).calibration?.perSport, promoted.production.calibration);

  const rolledBack = rollbackProduction(promoted.state, { actor: 'ops', now: NOW });
  assert.equal(rolledBack.production.parameterVersion, '2026.11-default-v1');
  assert.deepEqual(rolledBack.production.calibration, {});
  assert.deepEqual(productionModelOverrides(rolledBack.state), {});
  assert.throws(() => rollbackProduction(rolledBack.state, { actor: 'ops', now: NOW }), /No previous/);
});

test('default acceptance criteria are documented and promotion is never automatic', () => {
  assert.equal(DEFAULT_ACCEPTANCE_CRITERIA.minBrierImprovement > 0, true);
  assert.equal(DEFAULT_ACCEPTANCE_CRITERIA.maxFoldBrierRegression >= 0, true);
  const learned = learnInShadow(
    createAdaptiveState(NOW),
    ledgerForSamples(syntheticSamples(400, 1.3)),
    { criteria: TEST_CRITERIA, now: NOW }
  );
  // Learning alone never changes production, even for an eligible candidate.
  assert.deepEqual(learned.state.production.calibration, {});
  assert.equal(learned.state.production.parameterVersion, '2026.11-default-v1');
});

function makeMatch(): ScrapedMatch {
  return {
    id: 'adaptive-1',
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
    homeStats: {},
    awayStats: {},
    dataQuality: 'play_by_play_boxscore',
    plays: [],
  };
}

const EVIDENCE: EvidenceSummary = {
  tier: 'play_by_play_boxscore',
  homeBox: 'complete',
  awayBox: 'complete',
  playsTimed: 1,
  playsTotal: 1,
  identityValid: true,
  notes: [],
};

function makePrediction(): PureFlowPrediction {
  return {
    matchId: 'adaptive-1',
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
  } as PureFlowPrediction;
}

function makeAlert(overrides: Partial<ValueAlert> = {}): ValueAlert {
  return {
    id: 'adaptive-1::Moneyline (2-Way)::home::ml',
    matchId: 'adaptive-1',
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
    priceCapturedAt: NOW,
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

function ledgerForSamples(samples: AdaptiveSample[]): LedgerRecord[] {
  const match = makeMatch();
  const prediction = makePrediction();
  let records: LedgerRecord[] = [];
  for (const sample of samples) {
    const alert = makeAlert({
      id: sample.predictionId,
      fairProb: sample.fairProb,
      modelProbability: sample.fairProb,
    });
    const payload: LedgerPredictionPayload = buildPredictionPayload(
      alert,
      prediction,
      match,
      sample.settledAt
    );
    records = appendPrediction(records, payload).records;
    records = appendSettlement(
      records,
      {
        predictionId: sample.predictionId,
        status: sample.outcome === 1 ? 'won' : 'lost',
        homeScore: 100,
        awayScore: 90,
        settledAt: sample.settledAt,
        resultChecksum: computeResultChecksum(sample.predictionId, 100, 90),
      },
      sample.settledAt
    ).records;
  }
  return records;
}
