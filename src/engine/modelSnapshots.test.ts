import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPredictionsBatch, buildModelOnlyPayloads, progressBucketOf } from './ledger';
import type { PureFlowPrediction, ScrapedMatch } from '../types/quant';

const AT = '2026-11-23T17:00:00.000Z';

function match(over: Partial<ScrapedMatch> = {}): ScrapedMatch {
  return {
    id: 'm1', sport: 'basketball', league: 'nba', leagueName: 'NBA', sportPath: 'basketball/nba',
    status: 'live', startTime: AT, clockLabel: 'Q3 04:12', period: 3, progressPct: 0.66,
    regulationMinutes: 48, homeTeam: 'Home', awayTeam: 'Away', homeScore: 84, awayScore: 78,
    homeStats: {}, awayStats: {}, dataQuality: 'play_by_play_boxscore', plays: [], ...over,
  } as ScrapedMatch;
}

function pred(over: Partial<PureFlowPrediction> = {}): PureFlowPrediction {
  return {
    matchId: 'm1', sport: 'basketball', dataQuality: 'play_by_play_boxscore',
    modelVersion: 'pureflow-2.1.0', parameterVersion: 'v1',
    evidence: { tier: 'play_by_play_boxscore', homeBox: 'complete', awayBox: 'complete', playsTimed: 1, playsTotal: 1, identityValid: true, notes: [] },
    progressPct: 0.66, fairProbs: { homeWin: 0.58, awayWin: 0.42 },
    expectedRemaining: { homeMean: 10, awayMean: 9, totalMean: 19, spreadMean: 1 },
    standardLines: { totalLines: [], spreadLines: [] }, momentumSeries: [], confidence: 0.55, modelNotes: [],
    ...over,
  } as PureFlowPrediction;
}

test('progressBucketOf: upcoming is -1, live buckets are capped at 9', () => {
  assert.equal(progressBucketOf('upcoming', 0), -1);
  assert.equal(progressBucketOf('live', 0.05), 0);
  assert.equal(progressBucketOf('live', 0.55), 5);
  assert.equal(progressBucketOf('live', 1), 9);
});

test('buildModelOnlyPayloads: counts per sport and ineligible matches', () => {
  assert.equal(buildModelOnlyPayloads(pred(), match(), AT).length, 1);
  const soccer = match({ sport: 'soccer', sportPath: 'soccer/eng.1' });
  const sp = pred({ sport: 'soccer', fairProbs: { homeWin: 0.5, draw: 0.3, awayWin: 0.2 } });
  assert.equal(buildModelOnlyPayloads(sp, soccer, AT).length, 3);
  assert.equal(buildModelOnlyPayloads(pred(), match({ status: 'finished' }), AT).length, 0);
  const bad = pred({ evidence: { ...pred().evidence, identityValid: false } });
  assert.equal(buildModelOnlyPayloads(bad, match(), AT).length, 0);
});

test('model snapshot records the raw probability, not the calibrated served one', () => {
  const p = pred({ fairProbs: { homeWin: 0.7, awayWin: 0.3 }, uncalibratedFairProbs: { homeWin: 0.8, awayWin: 0.2 } });
  const [pl] = buildModelOnlyPayloads(p, match(), AT);
  assert.equal(pl.probabilities.fairProb, 0.8);
  assert.equal(pl.probabilities.modelProbability, 0.7);
  assert.equal(pl.progressBucket, 6);
  const [up] = buildModelOnlyPayloads(pred(), match({ status: 'upcoming', progressPct: 0 }), AT);
  assert.equal(up.progressBucket, -1);
});

test('appendPredictionsBatch dedupes by snapshot key', () => {
  const payloads = buildModelOnlyPayloads(pred(), match(), AT);
  const first = appendPredictionsBatch([], payloads);
  assert.equal(first.appended, 1);
  const second = appendPredictionsBatch(first.records, payloads);
  assert.equal(second.appended, 0);
});
