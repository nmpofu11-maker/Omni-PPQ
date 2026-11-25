import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp, parseRecordWinPct, kellyFraction } from './mathUtils';
import { footballMarginPmf, footballMarginTail } from './footballKeyNumbers';
import { baseballRemainingRuns, runExpectancy, parseBaseballSituation } from './baseballState';
import {
  applyFinishedMatch,
  emptyRatingBook,
  eloWinProb,
  getRating,
  ratingImpliedHomeProb,
} from './ratings';
import { shrinkTowardMarket, noVigProbability } from './valueEngine';
import { predictPureFlow, evaluateSpreadLine } from './predictionEngine';
import type { OddsFreeMatchSnapshot } from '../types/quant';

function snap(over: Partial<OddsFreeMatchSnapshot> = {}): OddsFreeMatchSnapshot {
  return {
    id: 's1', sport: 'basketball', league: 'nba', leagueName: 'NBA', sportPath: 'basketball/nba',
    status: 'live', startTime: '2026-11-23T17:00:00Z', clockLabel: 'Q3', period: 3, progressPct: 0.6,
    regulationMinutes: 48, homeTeam: 'H', awayTeam: 'A', homeScore: 70, awayScore: 66,
    homeStats: {}, awayStats: {}, plays: [], dataQuality: 'record_prior', ...over,
  } as OddsFreeMatchSnapshot;
}

test('clamp maps non-finite input to the neutral midpoint, kelly refuses NaN', () => {
  assert.equal(clamp(NaN, 0.01, 0.99), 0.5);
  assert.equal(clamp(Infinity, 0, 10), 5);
  assert.equal(clamp(3, 0, 10), 3);
  assert.equal(kellyFraction(NaN, 0.5, 2), 0);
  assert.equal(kellyFraction(0.6, NaN, 2), 0);
});

test('record formats: soccer is W-D-L, hockey counts OT losses as losses', () => {
  const soccer = parseRecordWinPct('10-5-3', 'wdl')!;
  assert.deepEqual([soccer.wins, soccer.ties, soccer.losses], [10, 5, 3]);
  const hockey = parseRecordWinPct('20-10-4', 'wlotl')!;
  assert.deepEqual([hockey.wins, hockey.losses, hockey.ties], [20, 14, 0]);
  const nfl = parseRecordWinPct('9-7-1', 'wlt')!;
  assert.deepEqual([nfl.wins, nfl.losses, nfl.ties], [9, 7, 1]);
  // A strong soccer side (many wins, few losses) must rate above a weak one.
  assert.ok(parseRecordWinPct('14-3-1', 'wdl')!.winPct > parseRecordWinPct('3-3-12', 'wdl')!.winPct);
});

test('football pmf is a distribution, preserves the mean, and puts extra mass on 3 and 7', () => {
  const { lo, probs } = footballMarginPmf(2.5, 13, 1);
  const sum = probs.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const mean = probs.reduce((a, p, i) => a + p * (lo + i), 0);
  assert.ok(Math.abs(mean - 2.5) < 0.02, `mean ${mean}`);
  const at = (m: number) => probs[m - lo];
  assert.ok(at(3) > at(2) * 1.8 && at(3) > at(4) * 1.5);
  assert.ok(at(7) > at(8) * 1.5);
  // No lumpiness late in the game: collapses back to the smooth distribution.
  const flat = footballMarginPmf(2.5, 13, 0);
  assert.ok(Math.abs(flat.probs[3 - flat.lo] / flat.probs[2 - flat.lo] - 1) < 0.1);
});

test('football spread: a -3 line pushes far more often than the smooth Gaussian says', () => {
  const pred = predictPureFlow(snap({
    sport: 'football', league: 'nfl', sportPath: 'football/nfl', status: 'upcoming',
    progressPct: 0, homeScore: 0, awayScore: 0, regulationMinutes: 60, period: 0, clockLabel: 'Pre',
  }));
  const r = evaluateSpreadLine(pred, -3);
  assert.ok(r.pushProb > 0.05, `push ${r.pushProb}`);
  const tail = footballMarginTail(pred.gaussianParams!.expectedFinalMargin, pred.gaussianParams!.marginStd, 1, 3);
  assert.ok(Math.abs(tail.equal - r.pushProb) < 1e-9);
  assert.ok(Math.abs(r.homeCoverProb + r.awayCoverProb + r.pushProb - 1) < 0.03);
});

test('baseball run expectancy: bases loaded no outs >> bases empty two outs', () => {
  const loaded = runExpectancy({ outs: 0, first: true, second: true, third: true });
  const empty2 = runExpectancy({ outs: 2, first: false, second: false, third: false });
  assert.ok(loaded > 2 && empty2 < 0.2);
  assert.ok(runExpectancy({ outs: 1, first: false, second: false, third: true }) > runExpectancy({ outs: 1, first: true, second: false, third: false }));
});

test('baseball remaining runs use the base-out state of the half-inning in progress', () => {
  const rich = baseballRemainingRuns({
    inning: 9,
    state: { outs: 0, first: true, second: true, third: true, half: 'bottom' },
    homeRate9: 4.5, awayRate9: 4.5,
  })!;
  const poor = baseballRemainingRuns({
    inning: 9,
    state: { outs: 2, first: false, second: false, third: false, half: 'bottom' },
    homeRate9: 4.5, awayRate9: 4.5,
  })!;
  assert.ok(rich.homeLambda > poor.homeLambda + 1.5);
  assert.equal(rich.awayLambda, 0); // top of 9th is over
  // Top of 1st, empty: 17 further half-innings plus the current one.
  const early = baseballRemainingRuns({
    inning: 1,
    state: { outs: 0, first: false, second: false, third: false, half: 'top' },
    homeRate9: 4.5, awayRate9: 4.5,
  })!;
  assert.ok(Math.abs(early.homeLambda - 4.5) < 1e-9);
  assert.ok(early.awayLambda > 4.2 && early.awayLambda < 4.8);
  assert.equal(baseballRemainingRuns({ inning: 11, state: { outs: 0, first: false, second: false, third: false, half: 'top' }, homeRate9: 4, awayRate9: 4 }), null);
});

test('situation parsing needs outs and the half-inning; otherwise falls back', () => {
  assert.equal(parseBaseballSituation({ outs: 1, onFirst: true }, 'Top 5th')?.half, 'top');
  assert.equal(parseBaseballSituation({ outs: 1 }, 'Bot 7th')?.half, 'bottom');
  assert.equal(parseBaseballSituation({ outs: 1 }, 'Final'), null);
  assert.equal(parseBaseballSituation(undefined, 'Top 5th'), null);
  assert.equal(parseBaseballSituation({ outs: 3 }, 'Top 5th'), null);
});

test('baseball prediction responds to the base-out state', () => {
  const base = snap({
    sport: 'baseball', league: 'mlb', sportPath: 'baseball/mlb', period: 9, progressPct: 0.95,
    clockLabel: 'Bot 9th', homeScore: 3, awayScore: 4, regulationMinutes: 9,
  });
  const loaded = predictPureFlow({ ...base, baseState: { outs: 0, first: true, second: true, third: true, half: 'bottom' } });
  const empty = predictPureFlow({ ...base, baseState: { outs: 2, first: false, second: false, third: false, half: 'bottom' } });
  assert.ok(loaded.fairProbs.homeWin > empty.fairProbs.homeWin + 0.15, `${loaded.fairProbs.homeWin} vs ${empty.fairProbs.homeWin}`);
});

test('Elo ratings: winners rise, updates are idempotent per match, ratings feed the prior', () => {
  let book = emptyRatingBook();
  const m = (id: string, hs: number, as: number) => ({ id, sport: 'basketball', homeTeam: 'Good', awayTeam: 'Bad', homeScore: hs, awayScore: as });
  for (let i = 0; i < 25; i++) book = applyFinishedMatch(book, m(`g${i}`, 110, 95)).book;
  const again = applyFinishedMatch(book, m('g0', 110, 95));
  assert.equal(again.changed, false);
  const good = getRating(book, 'basketball', 'Good')!;
  const bad = getRating(book, 'basketball', 'Bad')!;
  assert.ok(good.rating > 1500 && bad.rating < 1500 && good.games === 25);
  assert.ok(Math.abs(good.rating + bad.rating - 3000) < 1e-6, 'zero-sum');
  assert.ok(ratingImpliedHomeProb('basketball', good.rating, bad.rating)! > 0.8);
  assert.ok(Math.abs(eloWinProb(1500, 1500, 0) - 0.5) < 1e-12);

  const base = snap({ status: 'upcoming', progressPct: 0, homeScore: 0, awayScore: 0, homeTeam: 'Good', awayTeam: 'Bad' });
  const plain = predictPureFlow(base);
  const rated = predictPureFlow({ ...base, homeRating: good.rating, awayRating: bad.rating, homeRatingGames: 25, awayRatingGames: 25 });
  assert.ok(rated.fairProbs.homeWin > plain.fairProbs.homeWin + 0.05);
  // Few games behind the rating -> little trust.
  const thin = predictPureFlow({ ...base, homeRating: good.rating, awayRating: bad.rating, homeRatingGames: 2, awayRatingGames: 2 });
  assert.ok(thin.fairProbs.homeWin < rated.fairProbs.homeWin);
});

test('market shrinkage: weight 1 is a no-op, weight 0 is the market, in between lies between', () => {
  const none = shrinkTowardMarket(0.62, 0.38, 0, 0.5, 1);
  assert.equal(none.winProb, 0.62);
  const mkt = shrinkTowardMarket(0.62, 0.38, 0, 0.5, 0);
  assert.ok(Math.abs(mkt.winProb - 0.5) < 1e-9);
  const mid = shrinkTowardMarket(0.62, 0.38, 0, 0.5, 0.6);
  assert.ok(mid.winProb > 0.5 && mid.winProb < 0.62);
  assert.ok(Math.abs(mid.winProb + mid.lossProb - 1) < 1e-9);
  // Push mass is preserved.
  const pushy = shrinkTowardMarket(0.45, 0.45, 0.1, 0.5, 0.5);
  assert.ok(Math.abs(pushy.winProb + pushy.lossProb - 0.9) < 1e-9);
  assert.equal(shrinkTowardMarket(0.6, 0.4, 0, null, 0.5).winProb, 0.6);
});

test('no-vig probability removes the overround', () => {
  const p = noVigProbability(1.9, [1.9])!;
  assert.ok(Math.abs(p - 0.5) < 1e-12);
  const three = noVigProbability(2.0, [3.5, 4.0])!;
  assert.ok(three > 0.4 && three < 0.5);
  assert.equal(noVigProbability(2, []), null);
});

test('basketball: box-score count differentials no longer swamp the scoreboard', () => {
  const base = snap({ progressPct: 0.5, homeScore: 55, awayScore: 55, dataQuality: 'live_boxscore' });
  const lopsidedBox = predictPureFlow({
    ...base,
    homeStats: { fieldGoalPct: 46, threePointPct: 35, turnovers: 4, rebounds: 30 },
    awayStats: { fieldGoalPct: 46, threePointPct: 35, turnovers: 14, rebounds: 18 },
  });
  const evenBox = predictPureFlow({
    ...base,
    homeStats: { fieldGoalPct: 46, threePointPct: 35, turnovers: 9, rebounds: 24 },
    awayStats: { fieldGoalPct: 46, threePointPct: 35, turnovers: 9, rebounds: 24 },
  });
  const shift = lopsidedBox.fairProbs.homeWin - evenBox.fairProbs.homeWin;
  assert.ok(shift > 0, 'still directionally right');
  assert.ok(shift < 0.2, `effect bounded, got ${shift}`);
});
