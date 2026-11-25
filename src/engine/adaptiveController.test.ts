import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusteredMean,
  createAdaptiveState,
  calibratedSampleProb,
  DEFAULT_ACCEPTANCE_CRITERIA,
  evaluateAdaptiveCandidate,
  extractVerifiedSamples,
  GAMMA_GRID,
  groupClusters,
  learnInShadow,
  productionModelOverrides,
  promoteCandidate,
  rollbackProduction,
  type AcceptanceCriteria,
  type AdaptiveSample,
} from './adaptiveController';
import {
  appendPrediction,
  appendPredictionsBatch,
  appendSettlement,
  buildModelOnlyPayloads,
  buildPredictionPayload,
  computeResultChecksum,
  type LedgerRecord,
} from './ledger';
import { temperatureScaleBinary } from './mathUtils';
import { applyProbabilityCalibration, predictPureFlow } from './predictionEngine';
import type { EvidenceSummary, PureFlowPrediction, ScrapedMatch, SportType, ValueAlert } from '../types/quant';

const NOW = '2026-11-23T20:00:00.000Z';

/** Small-sample criteria for fast tests; significance gating is kept ON. */
const TEST_CRITERIA: AcceptanceCriteria = {
  minTotalSamples: 200,
  minHoldoutSamples: 100,
  minBrierImprovement: 0.001,
  maxLogLossRegression: 0.05,
  maxFoldBrierRegression: 0.05,
  folds: 4,
  minMatches: 150,
  minZ: 2,
};

/**
 * Deterministic synthetic market. The TRUE probability is pTrue; the model
 * states temperatureScaleBinary(pTrue, tau), i.e. it is over-confident when
 * tau > 1 and under-confident when tau < 1. The optimal served gamma is
 * therefore 1 / tau. Outcomes come from a Kronecker sequence so the data are
 * stratified (no flaky randomness) and tests are exactly reproducible.
 */
function syntheticSamples(
  count: number,
  tau: number,
  sport: SportType = 'basketball',
  startIndex = 0
): AdaptiveSample[] {
  const samples: AdaptiveSample[] = [];
  for (let n = 0; n < count; n++) {
    const i = startIndex + n;
    const pTrue = 0.15 + 0.7 * ((i * 0.7548776662466927 + 0.11) % 1);
    const roll = (i * 0.6180339887498949 + 0.37) % 1;
    samples.push({
      key: `${sport}-${i}|checksum-${i}`,
      predictionId: `${sport}-${i}`,
      matchId: `${sport}-m${i}`,
      sport,
      marketCategory: 'Moneyline (2-Way)',
      fairProb: temperatureScaleBinary(pTrue, tau),
      outcome: roll < pTrue ? 1 : 0,
      settledAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    });
  }
  return samples;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('trainer and server apply the identical calibration transform (no train/serve skew)', () => {
  const match = makeMatch();
  for (const gamma of GAMMA_GRID) {
    for (const p of [0.1, 0.3, 0.5, 0.6, 0.8, 0.95]) {
      const served = applyProbabilityCalibration(
        { ...makePrediction(), fairProbs: { homeWin: p, awayWin: 1 - p } },
        gamma
      );
      const sample: AdaptiveSample = {
        key: 'k',
        predictionId: 'k',
        sport: 'basketball',
        marketCategory: 'Moneyline (2-Way)',
        fairProb: p,
        lossProb: 1 - p,
        outcome: 1,
        settledAt: NOW,
      };
      assert.ok(
        Math.abs(served.fairProbs.homeWin - calibratedSampleProb(sample, gamma)) < 1e-6,
        `gamma=${gamma} p=${p}: served ${served.fairProbs.homeWin} vs trained ${calibratedSampleProb(sample, gamma)}`
      );
      assert.ok(Math.abs(served.fairProbs.homeWin + served.fairProbs.awayWin - 1) < 1e-9);
    }
  }
  assert.ok(match);
});

test('gamma > 1 sharpens and gamma < 1 flattens in BOTH training and serving', () => {
  const sample: AdaptiveSample = {
    key: 'k', predictionId: 'k', sport: 'basketball', marketCategory: 'Moneyline (2-Way)',
    fairProb: 0.7, lossProb: 0.3, outcome: 1, settledAt: NOW,
  };
  assert.ok(calibratedSampleProb(sample, 1.3) > 0.7);
  assert.ok(calibratedSampleProb(sample, 0.8) < 0.7);
  const served = (g: number) =>
    applyProbabilityCalibration({ ...makePrediction(), fairProbs: { homeWin: 0.7, awayWin: 0.3 } }, g)
      .fairProbs.homeWin;
  assert.ok(served(1.3) > 0.7);
  assert.ok(served(0.8) < 0.7);
});

test('three-way (1X2) calibration stays a valid distribution', () => {
  const base = {
    ...makePrediction(),
    sport: 'soccer' as const,
    fairProbs: { homeWin: 0.5, draw: 0.27, awayWin: 0.23 },
  };
  for (const g of GAMMA_GRID) {
    const c = applyProbabilityCalibration(base, g);
    const sum = c.fairProbs.homeWin + (c.fairProbs.draw ?? 0) + c.fairProbs.awayWin;
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
});

test('calibration preserves raw probabilities and leaves totals/spreads untouched', () => {
  const match = makeMatch();
  const baseline = predictPureFlow(match);
  const calibrated = predictPureFlow(match, {
    params: { calibration: { perSport: { basketball: { gamma: 1.2 } } } },
  });
  assert.notEqual(calibrated.fairProbs.homeWin, baseline.fairProbs.homeWin);
  assert.ok(Math.abs(calibrated.fairProbs.homeWin + calibrated.fairProbs.awayWin - 1) < 1e-9);
  assert.match(calibrated.parameterVersion, /cal1\.2$/);
  assert.ok(calibrated.modelNotes.some((n) => n.includes('calibration gamma=1.2')));
  // The learner must be able to recover the pre-calibration probability.
  assert.equal(calibrated.uncalibratedFairProbs?.homeWin, baseline.fairProbs.homeWin);
  // Gamma is learned from moneyline outcomes only; other markets are unchanged.
  assert.deepEqual(calibrated.standardLines, baseline.standardLines);
  assert.equal(baseline.uncalibratedFairProbs, undefined);
});

test('sample extraction uses only unbiased, decisive, checksum-verified model snapshots', () => {
  const match = makeMatch();
  const prediction = makePrediction();
  const priced = buildPredictionPayload(makeAlert({ id: 'p-priced' }), prediction, match, NOW);
  const [modelOnly] = buildModelOnlyPayloads(prediction, match, NOW);
  const pushOnly = { ...modelOnly, snapshotKey: 'x|model_only', predictionId: 'p-push' };

  let records: LedgerRecord[] = appendPrediction([], priced, NOW).records;
  records = appendPrediction(records, modelOnly, NOW).records;
  records = appendPrediction(records, pushOnly, NOW).records;
  const settle = (id: string, status: 'won' | 'lost' | 'push', h: number, a: number) => {
    records = appendSettlement(records, {
      predictionId: id, status, homeScore: h, awayScore: a, settledAt: NOW,
      resultChecksum: computeResultChecksum(id, h, a),
    }).records;
  };
  settle('p-priced', 'won', 112, 104);
  settle(modelOnly.predictionId, 'won', 112, 104);
  settle('p-push', 'push', 112, 112);

  const { samples, skipped, excludedPriced } = extractVerifiedSamples(records);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].predictionId, modelOnly.predictionId);
  assert.equal(samples[0].matchId, match.id);
  assert.equal(excludedPriced, 1, 'the edge-filtered alert must not be trained on');
  assert.equal(skipped, 1, 'the push is skipped');

  const withPriced = extractVerifiedSamples(records, { includePriced: true });
  assert.equal(withPriced.samples.length, 2);

  // A settlement whose stored scores no longer match its checksum is rejected.
  const tampered = records.map((r) =>
    r.type === 'settlement' && r.payload.predictionId === modelOnly.predictionId
      ? { ...r, payload: { ...r.payload, homeScore: 999 } }
      : r
  );
  assert.equal(extractVerifiedSamples(tampered).samples.length, 0);
});

test('a ledger holding only edge-filtered alerts yields nothing to learn and says why', () => {
  const match = makeMatch();
  const prediction = makePrediction();
  let records: LedgerRecord[] = [];
  for (let i = 0; i < 30; i++) {
    const id = `biased-${i}`;
    records = appendPrediction(records, buildPredictionPayload(makeAlert({ id }), prediction, match, NOW), NOW).records;
    records = appendSettlement(records, {
      predictionId: id, status: 'won', homeScore: 100, awayScore: 90, settledAt: NOW,
      resultChecksum: computeResultChecksum(id, 100, 90),
    }).records;
  }
  const result = learnInShadow(createAdaptiveState(NOW), records, { now: NOW });
  assert.equal(result.changed, false);
  assert.match(result.reason ?? '', /selection-biased/);
});

test('insufficient history yields a rejected candidate and leaves production untouched', () => {
  const state = createAdaptiveState(NOW);
  const candidate = evaluateAdaptiveCandidate(syntheticSamples(10, 1.5), TEST_CRITERIA, NOW);
  assert.equal(candidate.status, 'rejected');
  assert.ok(candidate.rejectionReasons.length > 0);
  assert.deepEqual(state.production.calibration, {});
});

test('the learner recovers a known over-confidence and the fix improves out-of-sample Brier', () => {
  // The model is over-confident by temperature 1.5, so the right gamma is ~1/1.5.
  const candidate = evaluateAdaptiveCandidate(syntheticSamples(1000, 1.5), DEFAULT_ACCEPTANCE_CRITERIA, NOW);
  assert.equal(candidate.status, 'eligible', candidate.rejectionReasons.join('; '));
  const gamma = candidate.perSportGammas.basketball as number;
  assert.ok(GAMMA_GRID.includes(gamma));
  assert.ok(gamma < 1 && gamma >= 0.7, `expected flattening gamma, got ${gamma}`);
  assert.ok(candidate.candidateBrier < candidate.baselineBrier);
  assert.ok(candidate.candidateLogLoss < candidate.baselineLogLoss, 'log loss is now out-of-sample too');
  const report = candidate.sportReports?.find((r) => r.sport === 'basketball');
  assert.ok(report && report.zScore >= 2 && report.passes);

  // And it recovers an UNDER-confident model with the opposite sign.
  const under = evaluateAdaptiveCandidate(syntheticSamples(1000, 0.7), DEFAULT_ACCEPTANCE_CRITERIA, NOW);
  assert.equal(under.status, 'eligible', under.rejectionReasons.join('; '));
  assert.ok((under.perSportGammas.basketball as number) > 1);
});

test('a perfectly calibrated model is almost never promoted (false-promotion rate)', () => {
  // The first version promoted a calibrated model in 14.5% of 60-sample runs.
  let eligible = 0;
  const trials = 150;
  for (let t = 0; t < trials; t++) {
    const rand = mulberry32(5000 + t);
    const samples: AdaptiveSample[] = [];
    for (let i = 0; i < 400; i++) {
      const p = 0.15 + 0.7 * rand();
      samples.push({
        key: `k${t}-${i}`, predictionId: `p${t}-${i}`, matchId: `m${t}-${i}`,
        sport: 'soccer', marketCategory: 'Match Winner (1X2)',
        fairProb: p, outcome: rand() < p ? 1 : 0,
        settledAt: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
      });
    }
    if (evaluateAdaptiveCandidate(samples, DEFAULT_ACCEPTANCE_CRITERIA, NOW).accepted) eligible++;
  }
  assert.ok(eligible / trials <= 0.05, `false promotion rate ${(100 * eligible) / trials}% (${eligible}/${trials})`);
});

test('snapshots of one match count once: few matches cannot masquerade as large samples', () => {
  // 60 matches x 10 snapshots = 600 samples, but only 60 independent matches.
  const samples: AdaptiveSample[] = [];
  for (let m = 0; m < 60; m++) {
    for (let k = 0; k < 10; k++) {
      samples.push({
        key: `m${m}-s${k}`, predictionId: `m${m}-s${k}`, matchId: `m${m}`,
        sport: 'basketball', marketCategory: 'Moneyline (2-Way)',
        fairProb: 0.8, outcome: m % 5 === 0 ? 0 : 1,
        settledAt: new Date(Date.UTC(2026, 0, 1) + m * 3600000).toISOString(),
      });
    }
  }
  const candidate = evaluateAdaptiveCandidate(samples, DEFAULT_ACCEPTANCE_CRITERIA, NOW);
  assert.equal(candidate.accepted, false);
  assert.ok(candidate.rejectionReasons.some((r) => /distinct matches/.test(r)));
});

test('groupClusters keeps a match together and orders matches by settlement time', () => {
  const mk = (id: string, matchId: string, at: string): AdaptiveSample => ({
    key: id, predictionId: id, matchId, sport: 'basketball',
    marketCategory: 'Moneyline (2-Way)', fairProb: 0.6, outcome: 1, settledAt: at,
  });
  const clusters = groupClusters([
    mk('a1', 'A', '2026-01-01T00:00:00Z'),
    mk('b1', 'B', '2026-01-01T00:05:00Z'),
    mk('a2', 'A', '2026-01-01T00:10:00Z'),
  ]);
  assert.deepEqual(clusters.map((c) => [c.id, c.samples.length]), [['B', 1], ['A', 2]]);
});

test('clusteredMean treats positively correlated snapshots of one match as one observation', () => {
  // 20 independent matches vs the SAME 20 values grouped so that each match's
  // snapshots share a sign (as snapshots of one match share an outcome).
  const independent = Array.from({ length: 20 }, (_, i) => ({ cluster: `c${i}`, d: i % 2 ? 0.02 : -0.01 }));
  const correlated = [...independent]
    .sort((a, b) => a.d - b.d)
    .map((x, i) => ({ cluster: `c${Math.floor(i / 5)}`, d: x.d }));
  const a = clusteredMean(independent);
  const b = clusteredMean(correlated);
  assert.ok(Math.abs(a.mean - b.mean) < 1e-12);
  assert.ok(b.se > a.se * 2, `clustering must widen the standard error (${b.se} vs ${a.se})`);
  assert.ok(b.z < a.z);
  assert.equal(clusteredMean([]).z, 0);
  assert.equal(clusteredMean([{ cluster: 'x', d: 1 }]).z, 0);
});

test('each sport is judged on its own evidence: a failing sport never rides along', () => {
  const miscalibrated = syntheticSamples(1000, 1.5, 'soccer');
  const calibrated = syntheticSamples(1000, 1.0, 'basketball');
  const candidate = evaluateAdaptiveCandidate([...miscalibrated, ...calibrated], DEFAULT_ACCEPTANCE_CRITERIA, NOW);
  assert.equal(candidate.status, 'eligible', candidate.rejectionReasons.join('; '));
  assert.ok(candidate.perSportGammas.soccer !== undefined);
  assert.equal(candidate.perSportGammas.basketball, undefined);
});

test('learning deduplicates settlements and candidates without touching production', () => {
  const records = ledgerForSamples(syntheticSamples(300, 1.5));
  const initial = createAdaptiveState(NOW);

  const first = learnInShadow(initial, records, { criteria: TEST_CRITERIA, now: NOW });
  assert.equal(first.changed, true);
  assert.equal(first.state.candidates.length, 1);
  assert.deepEqual(first.state.production, initial.production);
  assert.equal(first.state.processedSampleKeys.length, 300);

  const second = learnInShadow(first.state, records, { criteria: TEST_CRITERIA, now: NOW });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'no new verified settlements');
  assert.equal(second.state.candidates.length, 1);

  const later = learnInShadow(initial, records, {
    criteria: TEST_CRITERIA,
    now: '2026-11-24T00:00:00.000Z',
  });
  assert.equal(later.candidate?.candidateId, first.state.candidates[0].candidateId);
});

test('promotion is guarded by the enable flag and acceptance status, and rollback restores the prior version', () => {
  const records = ledgerForSamples(syntheticSamples(1000, 1.5));
  const learned = learnInShadow(createAdaptiveState(NOW), records, { now: NOW });
  const candidate = learned.state.candidates[0];
  assert.equal(candidate.status, 'eligible', candidate.rejectionReasons.join('; '));

  assert.throws(
    () => promoteCandidate(learned.state, candidate.candidateId, { enabled: false, actor: 'ops', now: NOW }),
    /disabled/
  );

  const rejected = evaluateAdaptiveCandidate(syntheticSamples(10, 1.5), TEST_CRITERIA, NOW);
  const stateWithRejected = { ...learned.state, candidates: [...learned.state.candidates, rejected] };
  assert.throws(
    () => promoteCandidate(stateWithRejected, rejected.candidateId, { enabled: true, actor: 'ops', now: NOW }),
    /acceptance criteria/
  );

  const promoted = promoteCandidate(learned.state, candidate.candidateId, { enabled: true, actor: 'ops', now: NOW });
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

test('default acceptance criteria are strict and promotion is never automatic', () => {
  assert.ok(DEFAULT_ACCEPTANCE_CRITERIA.minBrierImprovement > 0);
  assert.ok(DEFAULT_ACCEPTANCE_CRITERIA.maxFoldBrierRegression >= 0);
  assert.ok(DEFAULT_ACCEPTANCE_CRITERIA.minTotalSamples >= 300);
  assert.ok((DEFAULT_ACCEPTANCE_CRITERIA.minZ ?? 0) >= 2);
  const learned = learnInShadow(
    createAdaptiveState(NOW),
    ledgerForSamples(syntheticSamples(1000, 1.5)),
    { now: NOW }
  );
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
  // One unbiased model-only snapshot per sample, each in its own match.
  const payloads = samples.map((sample) => {
    const match = { ...makeMatch(), id: `m-${sample.predictionId}`, sport: sample.sport };
    const prediction = {
      ...makePrediction(),
      sport: sample.sport,
      fairProbs: { homeWin: sample.fairProb, awayWin: 1 - sample.fairProb },
    } as PureFlowPrediction;
    const payload = buildModelOnlyPayloads(prediction, match, sample.settledAt)[0];
    return { payload, sample };
  });
  let records: LedgerRecord[] = appendPredictionsBatch(
    [],
    payloads.map((x) => x.payload)
  ).records;
  for (const { payload, sample } of payloads) {
    records = appendSettlement(
      records,
      {
        predictionId: payload.predictionId,
        status: sample.outcome === 1 ? 'won' : 'lost',
        homeScore: 100,
        awayScore: 90,
        settledAt: sample.settledAt,
        resultChecksum: computeResultChecksum(payload.predictionId, 100, 90),
      },
      sample.settledAt
    ).records;
  }
  return records;
}
