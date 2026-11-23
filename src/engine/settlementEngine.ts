import {
  CalibrationMetrics,
  MatchStatus,
  PaperBet,
} from '../types/quant';
import { clamp } from './mathUtils';

export interface FinalMatchResult {
  status: MatchStatus;
  homeScore: number;
  awayScore: number;
  homeLinescores?: number[];
  awayLinescores?: number[];
}

/**
 * Settles a PaperBet across all supported sports and market categories:
 * - Moneyline (2-Way)
 * - Point Spread / Run Line / Puck Line / Asian Handicap / Spread
 * - Over / Under Total / Over / Under Goals
 * - Match Winner (1X2)
 * - Double Chance
 */
export function settlePaperBet(
  bet: PaperBet,
  result: FinalMatchResult
): PaperBet {
  if (bet.status !== 'pending' || result.status !== 'finished') {
    return bet;
  }

  let hScore = result.homeScore;
  let aScore = result.awayScore;

  // For Tennis game spreads / totals, use sum of set games when linescores are available
  const isTennisGameMarket =
    bet.sport === 'tennis' &&
    (bet.marketCategory === 'Point Spread' ||
      bet.marketCategory === 'Over / Under Total' ||
      bet.marketCategory === 'Asian Handicap / Spread');

  if (
    isTennisGameMarket &&
    result.homeLinescores &&
    result.awayLinescores &&
    result.homeLinescores.length > 0
  ) {
    hScore = result.homeLinescores.reduce((acc, v) => acc + v, 0);
    aScore = result.awayLinescores.reduce((acc, v) => acc + v, 0);
  }

  const diff = hScore - aScore;
  const total = hScore + aScore;
  let outcome: 'won' | 'lost' | 'push' = 'lost';

  switch (bet.marketCategory) {
    case 'Moneyline (2-Way)': {
      if (diff === 0) {
        outcome = 'push';
      } else if (bet.side === 'home') {
        outcome = diff > 0 ? 'won' : 'lost';
      } else {
        outcome = diff < 0 ? 'won' : 'lost';
      }
      break;
    }

    case 'Match Winner (1X2)': {
      if (bet.side === 'home') outcome = diff > 0 ? 'won' : 'lost';
      else if (bet.side === 'away') outcome = diff < 0 ? 'won' : 'lost';
      else if (bet.side === 'draw') outcome = diff === 0 ? 'won' : 'lost';
      break;
    }

    case 'Double Chance': {
      if (bet.side === 'home_draw') outcome = diff >= 0 ? 'won' : 'lost';
      else if (bet.side === 'away_draw') outcome = diff <= 0 ? 'won' : 'lost';
      else outcome = diff !== 0 ? 'won' : 'lost';
      break;
    }

    case 'Point Spread':
    case 'Run Line':
    case 'Puck Line':
    case 'Asian Handicap / Spread': {
      const line = bet.line ?? 0;
      // Note: bet.line is stored for the selected side (e.g., away +5.5 => line = +5.5)
      const selectedScoreDiff = bet.side === 'home' ? diff : -diff;
      const adjusted = selectedScoreDiff + line;
      if (Math.abs(adjusted) < 1e-6) outcome = 'push';
      else outcome = adjusted > 0 ? 'won' : 'lost';
      break;
    }

    case 'Over / Under Total':
    case 'Over / Under Goals': {
      const line = bet.line ?? 0;
      const delta = total - line;
      if (Math.abs(delta) < 1e-6) {
        outcome = 'push';
      } else if (bet.side === 'over') {
        outcome = delta > 0 ? 'won' : 'lost';
      } else {
        outcome = delta < 0 ? 'won' : 'lost';
      }
      break;
    }
  }

  let pnl = 0;
  if (outcome === 'won') {
    pnl = Math.round(bet.stakeAmount * (bet.bookmakerOdds - 1) * 100) / 100;
  } else if (outcome === 'lost') {
    pnl = -Math.round(bet.stakeAmount * 100) / 100;
  }

  return {
    ...bet,
    status: outcome,
    pnl,
    settledAt: new Date().toISOString(),
    finalScore: `${result.homeScore} - ${result.awayScore}`,
  };
}

export function computeCalibrationMetrics(bets: PaperBet[]): CalibrationMetrics {
  const settled = bets.filter(
    (b) => b.status === 'won' || b.status === 'lost' || b.status === 'push'
  );
  if (settled.length === 0) {
    return {
      totalSettled: 0,
      brierScore: 0,
      logLoss: 0,
      totalStaked: 0,
      totalPnl: 0,
      roiPct: 0,
      winRatePct: 0,
    };
  }

  let brierSum = 0;
  let logLossSum = 0;
  let scoredCount = 0;
  let totalStaked = 0;
  let totalPnl = 0;
  let wins = 0;
  let decisive = 0;

  for (const b of settled) {
    totalStaked += b.stakeAmount;
    totalPnl += b.pnl;
    if (b.status === 'won' || b.status === 'lost') {
      decisive++;
      if (b.status === 'won') wins++;
      const y = b.status === 'won' ? 1 : 0;
      const p = clamp(b.fairProbAtPlacement, 0.01, 0.99);
      brierSum += Math.pow(p - y, 2);
      logLossSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      scoredCount++;
    }
  }

  return {
    totalSettled: settled.length,
    brierScore: scoredCount > 0 ? Math.round((brierSum / scoredCount) * 10000) / 10000 : 0,
    logLoss: scoredCount > 0 ? Math.round((logLossSum / scoredCount) * 10000) / 10000 : 0,
    totalStaked: Math.round(totalStaked * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    roiPct: totalStaked > 0 ? Math.round((totalPnl / totalStaked) * 10000) / 100 : 0,
    winRatePct: decisive > 0 ? Math.round((wins / decisive) * 10000) / 100 : 0,
  };
}
