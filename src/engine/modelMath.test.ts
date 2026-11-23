import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_PARAMS,
  MODEL_VERSION,
} from './modelParams';
import {
  dixonColesTau,
  predictPureFlow,
} from './predictionEngine';
import { computeConvictionScore } from './valueEngine';
import { ScrapedMatch } from '../types/quant';

function makeMatch(overrides: Partial<ScrapedMatch>): ScrapedMatch {
  return {
    id: 'model-math-1',
    sport: 'soccer',
    league: 'eng.1',
    leagueName: 'Premier League',
    sportPath: 'soccer/eng.1',
    status: 'live',
    startTime: '2026-11-23T15:00:00Z',
    clockLabel: "10'",
    period: 1,
    progressPct: 0.12,
    regulationMinutes: 90,
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeScore: 0,
    awayScore: 0,
    homeRecord: '10-2-1',
    awayRecord: '7-4-2',
    homeStats: { shots: 2, shotsOnTarget: 0, corners: 1, possessionPct: 52 },
    awayStats: { shots: 2, shotsOnTarget: 0, corners: 1, possessionPct: 48 },
    plays: [],
    dataQuality: 'record_prior',
    ...overrides,
  };
}

test('Dixon-Coles tau adjusts only the low-score cells', () => {
  assert.ok(Math.abs(dixonColesTau(0, 0, 1.2, 1.0, -0.13) - (1 + 1.2 * 1.0 * 0.13)) < 1e-9);
  assert.ok(Math.abs(dixonColesTau(1, 0, 1.2, 1.0, -0.13) - (1 - 1.0 * 0.13)) < 1e-9);
  assert.ok(Math.abs(dixonColesTau(0, 1, 1.2, 1.0, -0.13) - (1 - 1.2 * 0.13)) < 1e-9);
  assert.ok(Math.abs(dixonColesTau(1, 1, 1.2, 1.0, -0.13) - 1.13) < 1e-9);
  assert.equal(dixonColesTau(2, 0, 1.2, 1.0, -0.13), 1);
  assert.equal(dixonColesTau(0, 3, 1.2, 1.0, -0.13), 1);
});

test('soccer draw probability rises with the low-score correction enabled', () => {
  const match = makeMatch({ homeScore: 1, awayScore: 1, progressPct: 0.55, clockLabel: "50'" });
  const corrected = predictPureFlow(match);
  const independent = predictPureFlow(match, {
    params: { soccer: { ...DEFAULT_MODEL_PARAMS.soccer, rho: 0 } },
  });
  assert.ok((corrected.fairProbs.draw ?? 0) > (independent.fairProbs.draw ?? 0));
});

test('predictions are stamped with model, parameter version and evidence', () => {
  const pred = predictPureFlow(makeMatch({ sport: 'basketball', league: 'nba' }));
  assert.equal(pred.modelVersion, MODEL_VERSION);
  assert.equal(pred.parameterVersion, DEFAULT_MODEL_PARAMS.version);
  assert.equal(pred.evidence.tier, 'record_prior');
  assert.equal(pred.dataQuality, pred.evidence.tier);
});

test('confidence reflects evidence quality, not elapsed progress', () => {
  const early = predictPureFlow(makeMatch({ progressPct: 0.3 }));
  const late = predictPureFlow(makeMatch({ progressPct: 0.75 }));
  assert.equal(early.confidence, late.confidence);
});

test('hockey two-way moneyline keeps an OT/SO expectation separate from regulation totals', () => {
  const pred = predictPureFlow(
    makeMatch({
      sport: 'hockey',
      league: 'nhl',
      sportPath: 'hockey/nhl',
      regulationMinutes: 60,
      clockLabel: '3rd 05:00',
      period: 3,
      progressPct: 0.86,
      homeScore: 2,
      awayScore: 2,
      homeStats: { shotsOnTarget: 24, powerPlayPct: 25, faceoffPct: 52 },
      awayStats: { shotsOnTarget: 20, powerPlayPct: 18, faceoffPct: 48 },
    })
  );
  assert.ok((pred.expectedAdditionalGoals ?? 0) > 0);
  const currentTotal = 2 + 2;
  assert.ok(
    Math.abs(
      pred.expectedRemaining.totalMean -
        currentTotal -
        (pred.poissonLambdas!.homeLambda + pred.poissonLambdas!.awayLambda)
    ) < 1e-9
  );
  assert.ok(pred.fairProbs.homeWin + pred.fairProbs.awayWin > 0.999);
  void DEFAULT_MODEL_PARAMS.hockey;
});

test('baseball bottom-9 home lead ends home at-bats and the game', () => {
  const pred = predictPureFlow(
    makeMatch({
      sport: 'baseball',
      league: 'mlb',
      sportPath: 'baseball/mlb',
      clockLabel: 'Bot 9th',
      period: 9,
      progressPct: 0.92,
      homeScore: 5,
      awayScore: 3,
      homeStats: { baseballHits: 9, battingAvg: 0.27 },
      awayStats: { baseballHits: 6, battingAvg: 0.25 },
    })
  );
  assert.equal(pred.expectedRemaining.homeMean, 0);
  assert.ok(pred.fairProbs.homeWin > 0.95);
});

test('baseball tie entering extras exposes an extra-inning run expectation', () => {
  const pred = predictPureFlow(
    makeMatch({
      sport: 'baseball',
      league: 'mlb',
      sportPath: 'baseball/mlb',
      clockLabel: 'Top 9th',
      period: 9,
      progressPct: 0.9,
      homeScore: 3,
      awayScore: 3,
      homeStats: { baseballHits: 8, battingAvg: 0.26 },
      awayStats: { baseballHits: 8, battingAvg: 0.26 },
    })
  );
  assert.ok((pred.expectedAdditionalGoals ?? 0) > 0);
  assert.ok(pred.fairProbs.homeWin > 0.01 && pred.fairProbs.homeWin < 0.99);
  assert.ok(Math.abs(pred.fairProbs.homeWin + pred.fairProbs.awayWin - 1) < 1e-9);
});

test('tennis serve/return quality changes the match probability', () => {
  const base = makeMatch({
    sport: 'tennis',
    league: 'atp',
    sportPath: 'tennis/atp',
    bestOfSets: 3,
    progressPct: 0.5,
    homeScore: 0,
    awayScore: 0,
    homeStats: { linescores: [4], firstServePct: 55, aces: 2 },
    awayStats: { linescores: [4], firstServePct: 55, aces: 2 },
  });
  const strongerServe = predictPureFlow({
    ...base,
    homeStats: { linescores: [4], firstServePct: 74, aces: 11 },
    awayStats: { linescores: [4], firstServePct: 48, aces: 1 },
  });
  const evenServe = predictPureFlow(base);
  assert.ok(strongerServe.fairProbs.homeWin > evenServe.fairProbs.homeWin + 0.01);
});

test('conviction does not reward elapsed match progress', () => {
  const args = {
    evPct: 9,
    kellyQuarterStakePct: 2.1,
    oddsVerifiedLive: true,
    dataQuality: 'live_boxscore' as const,
    fairProb: 0.58,
    bookmakerOdds: 1.9,
  };
  const early = computeConvictionScore({ ...args, progressPct: 0.2 });
  const late = computeConvictionScore({ ...args, progressPct: 0.9 });
  assert.equal(early, late);
});
