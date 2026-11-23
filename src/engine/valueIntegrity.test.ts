import test from 'node:test';
import assert from 'node:assert/strict';
import { predictPureFlow } from './predictionEngine';
import { evaluateBettingValue } from './valueEngine';
import type { MarketOdds, ScrapedMatch } from '../types/quant';

const NOW = new Date('2026-11-23T18:00:00.000Z');

function match(overrides: Partial<ScrapedMatch> = {}): ScrapedMatch {
  return {
    id: 'm1',
    sport: 'basketball',
    league: 'nba',
    leagueName: 'NBA',
    sportPath: 'basketball/nba',
    status: 'live',
    startTime: '2026-11-23T16:00:00Z',
    clockLabel: 'Q3 04:12',
    period: 3,
    progressPct: 0.66,
    homeTeam: 'Boston Celtics',
    awayTeam: 'Miami Heat',
    homeScore: 84,
    awayScore: 76,
    homeRecord: '14-3',
    awayRecord: '9-8',
    homeStats: { fieldGoalPct: 51.2, threePointPct: 40.5, rebounds: 34, turnovers: 7 },
    awayStats: { fieldGoalPct: 44.0, threePointPct: 33.0, rebounds: 28, turnovers: 11 },
    plays: [],
    dataQuality: 'live_boxscore',
    ...overrides,
  };
}

function metaFor(m: ScrapedMatch) {
  return {
    id: m.id,
    sport: m.sport,
    sportPath: m.sportPath,
    league: m.league,
    leagueName: m.leagueName,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    clockLabel: m.clockLabel,
    status: m.status,
    dataQuality: m.dataQuality,
    progressPct: m.progressPct,
  };
}

const verifiedLiveOdds: MarketOdds = {
  moneylineHome: 1.65,
  moneylineAway: 2.35,
  spreadLine: -5.5,
  spreadHomeOdds: 1.95,
  spreadAwayOdds: 1.95,
  totalLine: 224.5,
  overOdds: 1.91,
  underOdds: 1.91,
  provider: 'ESPN Bet',
  priceKind: 'live',
  source: 'ESPN Bet',
  capturedAt: '2026-11-23T17:59:30.000Z',
  marketId: 'm1:ESPN Bet',
  isLiveVerified: true,
};

test('value recommendations are blocked when the price lacks provenance', () => {
  const m = match();
  const pred = predictPureFlow(m);
  const bare: MarketOdds = {
    moneylineHome: 1.95,
    moneylineAway: 2.1,
    totalLine: 224.5,
    overOdds: 1.91,
    underOdds: 1.91,
    isLiveVerified: true, // asserted by producer, not proven
  };
  const alerts = evaluateBettingValue(pred, bare, metaFor(m), { now: NOW });
  assert.equal(alerts.length, 0);
});

test('verified prices produce alerts carrying the exact price provenance', () => {
  const m = match();
  const pred = predictPureFlow(m);
  const alerts = evaluateBettingValue(pred, verifiedLiveOdds, metaFor(m), { now: NOW });
  assert.ok(alerts.length > 0);
  for (const a of alerts) {
    assert.equal(a.priceVerified, true);
    assert.equal(a.priceKind, 'live');
    assert.equal(a.priceSource, 'ESPN Bet');
    assert.ok(a.priceCapturedAt);
    assert.equal(a.oddsVerifiedLive, true);
    assert.equal(a.oddsLabel, 'Verified Live');
  }
});

test('verified closing price is usable but never labelled live-verified', () => {
  const m = match({ status: 'upcoming' });
  const pred = predictPureFlow(m);
  const closing: MarketOdds = {
    ...verifiedLiveOdds,
    priceKind: 'closing',
    isLiveVerified: false,
  };
  const alerts = evaluateBettingValue(pred, closing, metaFor(m), { now: NOW });
  assert.ok(alerts.length > 0);
  assert.ok(alerts.every((a) => a.priceVerified && !a.oddsVerifiedLive));
  assert.ok(alerts.every((a) => a.oddsLabel === 'Pre-Match / Closing'));
});

test('stale verified-source price blocks recommendations', () => {
  const m = match();
  const pred = predictPureFlow(m);
  const stale: MarketOdds = { ...verifiedLiveOdds, capturedAt: '2026-11-23T17:00:00.000Z' };
  const alerts = evaluateBettingValue(pred, stale, metaFor(m), { now: NOW });
  assert.equal(alerts.length, 0);
});

test('push markets store win/loss/push probabilities and EV matches them', () => {
  const m = match({ status: 'live' });
  const pred = predictPureFlow(m);
  const odds: MarketOdds = {
    ...verifiedLiveOdds,
    spreadLine: -5, // whole number => possible push
    spreadHomeOdds: 1.9,
    spreadAwayOdds: 1.9,
  };
  const alerts = evaluateBettingValue(pred, odds, metaFor(m), {
    now: NOW,
    minEvPct: -100,
  });
  const spread = alerts.find((a) => a.marketCategory === 'Point Spread');
  assert.ok(spread);
  assert.ok((spread?.pushProb ?? 0) >= 0);
  const expectedEv =
    spread!.fairProb * (spread!.bookmakerOdds - 1) - spread!.lossProb;
  assert.ok(Math.abs(spread!.evPct - expectedEv * 100) < 0.11);
});

test('separated model, evidence, uncertainty, calibration and ranking scores', () => {
  const m = match();
  const pred = predictPureFlow(m);
  const alerts = evaluateBettingValue(pred, verifiedLiveOdds, metaFor(m), { now: NOW });
  const a = alerts[0];
  assert.equal(a.modelProbability, a.fairProb);
  assert.equal(a.rankingScore, a.convictionScore);
  assert.ok(a.dataQualityScore >= 0 && a.dataQualityScore <= 1);
  assert.ok(a.uncertaintyScore >= 0 && a.uncertaintyScore <= 1);
  assert.ok(a.calibrationScore >= 0 && a.calibrationScore <= 1);
  assert.ok(a.modelProbability > 0 && a.modelProbability < 1);
});

test('verifiedLiveOnly excludes closing prices from alerts', () => {
  const m = match();
  const pred = predictPureFlow(m);
  const closing: MarketOdds = { ...verifiedLiveOdds, priceKind: 'closing', isLiveVerified: false };
  assert.equal(
    evaluateBettingValue(pred, closing, metaFor(m), { now: NOW, verifiedLiveOnly: true })
      .length,
    0
  );
});
