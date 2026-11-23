import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSpreadLine,
  evaluateTotalLine,
  predictPureFlow,
  stripOddsForFirewall,
} from './predictionEngine';
import {
  computeConvictionScore,
  evaluateBettingValue,
  rankBestBets,
} from './valueEngine';
import {
  computeCalibrationMetrics,
  settlePaperBet,
} from './settlementEngine';
import { PaperBet, ScrapedMatch } from '../types/quant';

function makeBaseMatch(overrides: Partial<ScrapedMatch>): ScrapedMatch {
  return {
    id: 'test-match-1',
    sport: 'soccer',
    league: 'eng.1',
    leagueName: 'Premier League',
    sportPath: 'soccer/eng.1',
    status: 'live',
    startTime: '2026-11-23T15:00:00Z',
    clockLabel: "65'",
    period: 2,
    progressPct: 0.72,
    regulationMinutes: 90,
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeScore: 1,
    awayScore: 1,
    homeRecord: '10-2-1',
    awayRecord: '7-4-2',
    homeStats: {
      shots: 14,
      shotsOnTarget: 6,
      corners: 7,
      possessionPct: 61,
      redCards: 0,
    },
    awayStats: {
      shots: 7,
      shotsOnTarget: 2,
      corners: 3,
      possessionPct: 39,
      redCards: 0,
    },
    plays: [
      {
        id: 'p1',
        clock: "58'",
        period: 2,
        elapsedPct: 0.64,
        team: 'home',
        type: 'Shot on Target',
        text: 'Shot saved in box',
        weight: 1.5,
      },
      {
        id: 'p2',
        clock: "63'",
        period: 2,
        elapsedPct: 0.7,
        team: 'home',
        type: 'Corner',
        text: 'Corner kick won',
        weight: 1.5,
      },
    ],
    dataQuality: 'play_by_play_boxscore',
    ...overrides,
  };
}

test('Stage 1 Odds Firewall completely isolates predictions from bookmaker odds', () => {
  const matchLowOdds = makeBaseMatch({
    odds: {
      moneylineHome: 1.15,
      moneylineDraw: 6.5,
      moneylineAway: 15.0,
      isLiveVerified: true,
    },
  });
  const matchHighOdds = makeBaseMatch({
    odds: {
      moneylineHome: 4.5,
      moneylineDraw: 3.4,
      moneylineAway: 1.75,
      isLiveVerified: true,
    },
  });

  const stripped = stripOddsForFirewall(matchLowOdds);
  assert.equal('odds' in stripped, false);

  const pred1 = predictPureFlow(matchLowOdds);
  const pred2 = predictPureFlow(matchHighOdds);
  assert.deepEqual(pred1.fairProbs, pred2.fairProbs);
  assert.deepEqual(pred1.expectedRemaining, pred2.expectedRemaining);
});

test('Soccer model produces valid 1X2, DNB, Next Goal, and red card tilt', () => {
  const normal = makeBaseMatch({});
  const redCardAway = makeBaseMatch({
    awayStats: { ...normal.awayStats, redCards: 1 },
  });

  const pNormal = predictPureFlow(normal);
  const pRed = predictPureFlow(redCardAway);

  const sum1x2 =
    pNormal.fairProbs.homeWin +
    (pNormal.fairProbs.draw ?? 0) +
    pNormal.fairProbs.awayWin;
  assert.ok(Math.abs(sum1x2 - 1) < 1e-4);
  assert.ok(pNormal.fairProbs.homeWin > pNormal.fairProbs.awayWin);
  assert.ok(pRed.fairProbs.homeWin > pNormal.fairProbs.homeWin);
  assert.ok(pNormal.fairProbs.nextGoalHome! > pNormal.fairProbs.nextGoalAway!);
});

test('Basketball Gaussian model uses exact sigma curves and evaluates dynamic lines', () => {
  const nba = makeBaseMatch({
    sport: 'basketball',
    league: 'nba',
    leagueName: 'NBA',
    sportPath: 'basketball/nba',
    clockLabel: 'Q3 04:12',
    period: 3,
    progressPct: 0.66,
    regulationMinutes: 48,
    homeTeam: 'Boston Celtics',
    awayTeam: 'Miami Heat',
    homeScore: 84,
    awayScore: 76,
    homeRecord: '14-3',
    awayRecord: '9-8',
    homeStats: { fieldGoalPct: 51.2, threePointPct: 40.5, rebounds: 34, assists: 22, turnovers: 7 },
    awayStats: { fieldGoalPct: 44.0, threePointPct: 33.0, rebounds: 28, assists: 17, turnovers: 11 },
  });

  const pred = predictPureFlow(nba);
  assert.ok(pred.fairProbs.homeWin > 0.72);
  assert.equal(pred.fairProbs.draw, undefined);

  const expectedMarginStd = 12.2 * Math.sqrt(1 - 0.66 + 0.04);
  const expectedTotalStd = 15.8 * Math.sqrt(1 - 0.66 + 0.04);
  assert.ok(Math.abs(pred.gaussianParams!.marginStd - expectedMarginStd) < 1e-6);
  assert.ok(Math.abs(pred.gaussianParams!.totalStd - expectedTotalStd) < 1e-6);

  const totEval = evaluateTotalLine(pred, 218.5);
  assert.ok(Math.abs(totEval.overProb + totEval.underProb - 1) < 1e-6);

  const sprEval = evaluateSpreadLine(pred, -8.5);
  assert.ok(Math.abs(sprEval.homeCoverProb + sprEval.awayCoverProb - 1) < 1e-6);
});

test('American Football Gaussian model computes margin/total with 13.8 and 14.5 sigma curves', () => {
  const nfl = makeBaseMatch({
    sport: 'football',
    league: 'nfl',
    leagueName: 'NFL',
    sportPath: 'football/nfl',
    clockLabel: 'Q3 07:30',
    period: 3,
    progressPct: 0.625,
    regulationMinutes: 60,
    homeTeam: 'Kansas City Chiefs',
    awayTeam: 'Buffalo Bills',
    homeScore: 21,
    awayScore: 17,
    homeStats: { totalYards: 310, firstDowns: 19, thirdDownPct: 55, turnovers: 0 },
    awayStats: { totalYards: 245, firstDowns: 14, thirdDownPct: 38, turnovers: 1 },
  });

  const pred = predictPureFlow(nfl);
  const expMarginStd = 13.8 * Math.sqrt(1 - 0.625 + 0.05);
  const expTotalStd = 14.5 * Math.sqrt(1 - 0.625 + 0.05);
  assert.ok(Math.abs(pred.gaussianParams!.marginStd - expMarginStd) < 1e-6);
  assert.ok(Math.abs(pred.gaussianParams!.totalStd - expTotalStd) < 1e-6);
  assert.ok(pred.fairProbs.homeWin > 0.6);
});

test('Ice Hockey Poisson + OT tie-split model produces 2-way ML and Puck Line', () => {
  const nhl = makeBaseMatch({
    sport: 'hockey',
    league: 'nhl',
    leagueName: 'NHL',
    sportPath: 'hockey/nhl',
    clockLabel: '2nd 11:20',
    period: 2,
    progressPct: 0.48,
    regulationMinutes: 60,
    homeTeam: 'Edmonton Oilers',
    awayTeam: 'Calgary Flames',
    homeScore: 2,
    awayScore: 2,
    homeStats: { shotsOnTarget: 23, powerPlayPct: 33.3, faceoffPct: 56, hits: 14, saves: 15 },
    awayStats: { shotsOnTarget: 17, powerPlayPct: 16.7, faceoffPct: 44, hits: 18, saves: 21 },
  });

  const pred = predictPureFlow(nhl);
  assert.ok(Math.abs(pred.fairProbs.homeWin + pred.fairProbs.awayWin - 1) < 1e-6);
  assert.ok(pred.fairProbs.homeWin > 0.52);
  const puckLine = evaluateSpreadLine(pred, -1.5);
  assert.ok(puckLine.homeCoverProb > 0 && puckLine.awayCoverProb > 0);
});

test('Baseball inning-discrete Poisson model evaluates Run Line and Totals', () => {
  const mlb = makeBaseMatch({
    sport: 'baseball',
    league: 'mlb',
    leagueName: 'MLB',
    sportPath: 'baseball/mlb',
    clockLabel: 'Top 7th',
    period: 7,
    progressPct: 0.68,
    homeTeam: 'Los Angeles Dodgers',
    awayTeam: 'San Diego Padres',
    homeScore: 4,
    awayScore: 2,
    homeStats: { baseballHits: 9, battingAvg: 0.278, era: 3.45, errors: 0 },
    awayStats: { baseballHits: 5, battingAvg: 0.241, era: 4.35, errors: 1 },
  });

  const pred = predictPureFlow(mlb);
  assert.ok(pred.fairProbs.homeWin > 0.7);
  const total85 = evaluateTotalLine(pred, 8.5);
  assert.ok(Math.abs(total85.overProb + total85.underProb - 1) < 1e-6);
});

test('Tennis Markov set/game state model reacts to set & game lead', () => {
  const tennis = makeBaseMatch({
    sport: 'tennis',
    league: 'atp',
    leagueName: 'ATP Tour',
    sportPath: 'tennis/atp',
    clockLabel: 'Set 2',
    period: 2,
    progressPct: 0.55,
    bestOfSets: 3,
    homeTeam: 'Carlos Alcaraz',
    awayTeam: 'Jannik Sinner',
    homeScore: 1,
    awayScore: 0,
    homeRecord: '48-9',
    awayRecord: '45-10',
    homeStats: { linescores: [6, 4] },
    awayStats: { linescores: [3, 2] },
  });

  const pred = predictPureFlow(tennis);
  assert.ok(pred.fairProbs.homeWin > 0.85);
  assert.equal(pred.tennisParams?.homeSets, 1);
  assert.equal(pred.tennisParams?.currentSetHomeGames, 4);
});

test('Stage 2 Value Engine filters verifiedLiveOnly and Conviction Score penalizes >30% EV outliers', () => {
  const nba = makeBaseMatch({
    sport: 'basketball',
    league: 'nba',
    leagueName: 'NBA',
    sportPath: 'basketball/nba',
    clockLabel: 'Q3 04:12',
    progressPct: 0.66,
    homeScore: 84,
    awayScore: 78,
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
      capturedAt: '2026-11-23T17:59:30.000Z',
      marketId: 'nba-test:ESPN Bet',
      isLiveVerified: true,
    },
  });

  const pred = predictPureFlow(nba);
  const liveAlerts = evaluateBettingValue(pred, nba.odds, {
    id: nba.id,
    sport: nba.sport,
    sportPath: nba.sportPath,
    league: nba.league,
    leagueName: nba.leagueName,
    homeTeam: nba.homeTeam,
    awayTeam: nba.awayTeam,
    clockLabel: nba.clockLabel,
    status: nba.status,
    dataQuality: nba.dataQuality,
    progressPct: nba.progressPct,
  }, { verifiedLiveOnly: true, now: new Date('2026-11-23T18:00:00Z') });
  assert.ok(liveAlerts.length > 0);
  assert.ok(liveAlerts.every((a) => a.oddsVerifiedLive));

  const preMatchOnly = evaluateBettingValue(
    pred,
    { ...nba.odds!, isLiveVerified: false, priceKind: 'closing' },
    {
      id: nba.id,
      sport: nba.sport,
      sportPath: nba.sportPath,
      league: nba.league,
      leagueName: nba.leagueName,
      homeTeam: nba.homeTeam,
      awayTeam: nba.awayTeam,
      clockLabel: nba.clockLabel,
      status: nba.status,
      dataQuality: nba.dataQuality,
      progressPct: nba.progressPct,
    },
    { verifiedLiveOnly: true, now: new Date('2026-11-23T18:00:00Z') }
  );
  assert.equal(preMatchOnly.length, 0);

  // Conviction suspicion penalty above +30% EV
  const healthyEvConv = computeConvictionScore({
    evPct: 12,
    kellyQuarterStakePct: 2.5,
    oddsVerifiedLive: true,
    dataQuality: 'play_by_play_boxscore',
    progressPct: 0.55,
    fairProb: 0.62,
    bookmakerOdds: 1.81,
  });
  const extremeOutlierConv = computeConvictionScore({
    evPct: 75,
    kellyQuarterStakePct: 5.0,
    oddsVerifiedLive: true,
    dataQuality: 'play_by_play_boxscore',
    progressPct: 0.55,
    fairProb: 0.8,
    bookmakerOdds: 2.19,
  });
  assert.ok(healthyEvConv > extremeOutlierConv);

  const ranked = rankBestBets(liveAlerts);
  assert.ok(ranked[0].convictionScore >= ranked[ranked.length - 1].convictionScore);
});

test('Multi-sport paper bet settlement & Brier/LogLoss calibration across all market categories', () => {
  const base: Omit<PaperBet, 'id' | 'marketCategory' | 'selection' | 'side' | 'line' | 'sport'> = {
    matchId: 'm1',
    sportPath: 'basketball/nba',
    leagueName: 'NBA',
    homeTeam: 'Home',
    awayTeam: 'Away',
    stakeAmount: 100,
    bookmakerOdds: 2.0,
    fairProbAtPlacement: 0.6,
    evPctAtPlacement: 20,
    convictionAtPlacement: 80,
    oddsVerifiedLive: true,
    placedAt: '2026-11-23T12:00:00Z',
    status: 'pending',
    pnl: 0,
  };

  // 1. Point Spread win & push
  const spreadWin = settlePaperBet(
    { ...base, id: '1', sport: 'basketball', marketCategory: 'Point Spread', selection: 'Home -5.5', side: 'home', line: -5.5 },
    { status: 'finished', homeScore: 110, awayScore: 100 }
  );
  assert.equal(spreadWin.status, 'won');
  assert.equal(spreadWin.pnl, 100);

  const spreadPush = settlePaperBet(
    { ...base, id: '2', sport: 'football', marketCategory: 'Point Spread', selection: 'Home -3', side: 'home', line: -3 },
    { status: 'finished', homeScore: 24, awayScore: 21 }
  );
  assert.equal(spreadPush.status, 'push');
  assert.equal(spreadPush.pnl, 0);

  // 2. Soccer 1X2 & Double Chance
  const soccerDraw = settlePaperBet(
    { ...base, id: '3', sport: 'soccer', marketCategory: 'Double Chance', selection: 'Home or Draw', side: 'home_draw' },
    { status: 'finished', homeScore: 1, awayScore: 1 }
  );
  assert.equal(soccerDraw.status, 'won');

  const soccerLoss = settlePaperBet(
    { ...base, id: '4', sport: 'soccer', marketCategory: 'Match Winner (1X2)', selection: 'Home Win', side: 'home' },
    { status: 'finished', homeScore: 1, awayScore: 2 }
  );
  assert.equal(soccerLoss.status, 'lost');
  assert.equal(soccerLoss.pnl, -100);

  // 3. Tennis Game Total from linescores
  const tennisOver = settlePaperBet(
    { ...base, id: '5', sport: 'tennis', marketCategory: 'Over / Under Total', selection: 'Over 21.5', side: 'over', line: 21.5 },
    { status: 'finished', homeScore: 2, awayScore: 1, homeLinescores: [6, 4, 6], awayLinescores: [4, 6, 3] }
  );
  // Total games = 6+4+6+4+6+3 = 29 > 21.5
  assert.equal(tennisOver.status, 'won');

  const metrics = computeCalibrationMetrics([spreadWin, spreadPush, soccerDraw, soccerLoss, tennisOver]);
  assert.equal(metrics.totalSettled, 5);
  assert.ok(metrics.brierScore > 0 && metrics.brierScore < 0.35);
  assert.ok(metrics.logLoss > 0);
  assert.equal(metrics.totalPnl, 200);
});
