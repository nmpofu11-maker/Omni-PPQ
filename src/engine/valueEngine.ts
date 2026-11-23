import {
  DataQualityTier,
  MarketCategory,
  MarketOdds,
  MatchStatus,
  PureFlowPrediction,
  SportType,
  ValueAlert,
} from '../types/quant';
import { clamp, decimalToImpliedProb, probToDecimalOdds } from './mathUtils';
import { evaluateSpreadLine, evaluateTotalLine } from './predictionEngine';

export interface MatchValueMeta {
  id: string;
  sport: SportType;
  sportPath: string;
  league: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  clockLabel: string;
  status: MatchStatus;
  dataQuality: DataQualityTier;
  progressPct: number;
}

export interface EvaluateValueOptions {
  verifiedLiveOnly?: boolean;
  minEvPct?: number;
  includeFinished?: boolean;
}

function calcEvAndQuarterKelly(
  winProb: number,
  lossProb: number,
  decimalOdds: number
): { evPct: number; kellyQuarterPct: number } {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1.01) {
    return { evPct: -100, kellyQuarterPct: 0 };
  }
  const b = decimalOdds - 1;
  const ev = winProb * b - lossProb;
  const evPct = Math.round(ev * 1000) / 10;
  if (ev <= 0) {
    return { evPct, kellyQuarterPct: 0 };
  }
  // Exact Kelly for win/loss/push: f* = (winProb * b - lossProb) / b
  const kellyFull = ev / b;
  const kellyQuarterPct = Math.round(clamp(kellyFull * 0.25 * 100, 0, 5.0) * 100) / 100;
  return { evPct, kellyQuarterPct };
}

/**
 * Computes a 0-100 Conviction Score weighting:
 * 1. Positive EV magnitude (diminishing returns + suspicion penalty > +30% EV)
 * 2. Live telemetry data depth (play_by_play_boxscore > live_boxscore > record_prior)
 * 3. Odds verification status (Verified Live > Pre-Match / Closing)
 * 4. Match elapsed progress & Quarter-Kelly sizing consistency
 */
export function computeConvictionScore(
  alert: Pick<
    ValueAlert,
    'evPct' | 'kellyQuarterStakePct' | 'oddsVerifiedLive' | 'dataQuality' | 'progressPct' | 'fairProb' | 'bookmakerOdds'
  >,
  meta?: { progressPct?: number; dataQuality?: DataQualityTier; status?: MatchStatus }
): number {
  const ev = alert.evPct;
  if (ev <= 0) return 0;

  const dataQuality = meta?.dataQuality ?? alert.dataQuality;
  const progressPct = clamp(meta?.progressPct ?? alert.progressPct, 0, 1);
  const status = meta?.status ?? 'live';

  // 1. EV Score (0..36 pts) with concave diminishing returns and suspicion penalty > 30% EV
  let evScore = 0;
  if (ev <= 30) {
    evScore = 36 * (1 - Math.exp(-ev / 9.5));
  } else {
    const peak = 36 * (1 - Math.exp(-30 / 9.5));
    const excessPenalty = Math.min(18, (ev - 30) * 0.45);
    evScore = Math.max(8, peak - excessPenalty);
  }

  // 2. Data Quality Depth (0..26 pts)
  const tierScore =
    dataQuality === 'play_by_play_boxscore'
      ? 26
      : dataQuality === 'live_boxscore'
        ? 17
        : 7;

  // 3. Odds Verification (0..22 pts)
  const oddsScore = alert.oddsVerifiedLive ? 22 : 8;

  // 4. Sample Elapsed Progress & Quarter-Kelly Consistency (0..16 pts)
  let sampleScore = 0;
  if (status === 'upcoming') {
    sampleScore = 4;
  } else if (progressPct >= 0.15 && progressPct <= 0.88) {
    sampleScore = 10;
  } else if (progressPct > 0.88) {
    // Late game garbage time / low remaining variance
    sampleScore = 7;
  } else {
    sampleScore = 6;
  }

  const kellyConsistency = clamp(alert.kellyQuarterStakePct / 3.0, 0, 1) * 6;

  // Extreme longshot penalty (e.g. > 8.0 decimal odds has higher model tail sensitivity)
  const oddsTailPenalty = alert.bookmakerOdds > 7.5 ? Math.min(8, (alert.bookmakerOdds - 7.5) * 1.2) : 0;

  return Math.round(
    clamp(evScore + tierScore + oddsScore + sampleScore + kellyConsistency - oddsTailPenalty, 1, 99)
  );
}

function getSpreadCategory(sport: SportType): MarketCategory {
  switch (sport) {
    case 'soccer':
      return 'Asian Handicap / Spread';
    case 'baseball':
      return 'Run Line';
    case 'hockey':
      return 'Puck Line';
    default:
      return 'Point Spread';
  }
}

function getTotalCategory(sport: SportType): MarketCategory {
  return sport === 'soccer' ? 'Over / Under Goals' : 'Over / Under Total';
}

function getMoneylineCategory(sport: SportType): MarketCategory {
  return sport === 'soccer' ? 'Match Winner (1X2)' : 'Moneyline (2-Way)';
}

/**
 * STAGE 2: Value & Edge Evaluation
 * Compares Stage 1 PureFlowPrediction against scraped MarketOdds.
 */
export function evaluateBettingValue(
  prediction: PureFlowPrediction,
  marketOdds: MarketOdds | undefined,
  meta: MatchValueMeta,
  options: EvaluateValueOptions = {}
): ValueAlert[] {
  if (!marketOdds) return [];
  if (!options.includeFinished && meta.status === 'finished') return [];

  const minEvPct = options.minEvPct ?? 1.5;
  const verifiedLiveOnly = options.verifiedLiveOnly ?? false;
  if (verifiedLiveOnly && !marketOdds.isLiveVerified) {
    return [];
  }

  const oddsLabel: ValueAlert['oddsLabel'] = marketOdds.isLiveVerified
    ? 'Verified Live'
    : 'Pre-Match / Closing';

  const candidates: ValueAlert[] = [];

  const pushCandidate = (
    marketCategory: MarketCategory,
    selection: string,
    side: ValueAlert['side'],
    winProb: number,
    lossProb: number,
    bookmakerOdds: number | undefined,
    line?: number
  ) => {
    if (!bookmakerOdds || !Number.isFinite(bookmakerOdds) || bookmakerOdds <= 1.01) {
      return;
    }
    const { evPct, kellyQuarterPct } = calcEvAndQuarterKelly(
      winProb,
      lossProb,
      bookmakerOdds
    );
    if (evPct < minEvPct) return;

    const fairOdds = probToDecimalOdds(winProb);
    const impliedProb = decimalToImpliedProb(bookmakerOdds);

    const draft: ValueAlert = {
      id: `${meta.id}::${marketCategory}::${side}::${line ?? 'ml'}`,
      matchId: meta.id,
      sport: meta.sport,
      sportPath: meta.sportPath,
      league: meta.league,
      leagueName: meta.leagueName,
      homeTeam: meta.homeTeam,
      awayTeam: meta.awayTeam,
      clockLabel: meta.clockLabel,
      status: meta.status,
      marketCategory,
      selection,
      side,
      line,
      fairProb: Math.round(winProb * 10000) / 10000,
      fairOdds,
      bookmakerOdds: Math.round(bookmakerOdds * 100) / 100,
      impliedProb: Math.round(impliedProb * 10000) / 10000,
      evPct,
      kellyQuarterStakePct: kellyQuarterPct,
      oddsVerifiedLive: marketOdds.isLiveVerified,
      oddsLabel,
      provider: marketOdds.provider,
      dataQuality: meta.dataQuality,
      progressPct: meta.progressPct,
      convictionScore: 0,
    };

    draft.convictionScore = computeConvictionScore(draft, {
      progressPct: meta.progressPct,
      dataQuality: meta.dataQuality,
      status: meta.status,
    });
    candidates.push(draft);
  };

  // 1. Moneyline / 1X2
  const mlCategory = getMoneylineCategory(meta.sport);
  if (meta.sport === 'soccer') {
    const pHome = prediction.fairProbs.homeWin;
    const pDraw = prediction.fairProbs.draw ?? 0;
    const pAway = prediction.fairProbs.awayWin;

    pushCandidate(mlCategory, `${meta.homeTeam} Win`, 'home', pHome, 1 - pHome, marketOdds.moneylineHome);
    if (marketOdds.moneylineDraw) {
      pushCandidate(mlCategory, 'Draw', 'draw', pDraw, 1 - pDraw, marketOdds.moneylineDraw);
    }
    pushCandidate(mlCategory, `${meta.awayTeam} Win`, 'away', pAway, 1 - pAway, marketOdds.moneylineAway);
  } else {
    const pHome = prediction.fairProbs.homeWin;
    const pAway = prediction.fairProbs.awayWin;
    pushCandidate(mlCategory, `${meta.homeTeam} ML`, 'home', pHome, 1 - pHome, marketOdds.moneylineHome);
    pushCandidate(mlCategory, `${meta.awayTeam} ML`, 'away', pAway, 1 - pAway, marketOdds.moneylineAway);
  }

  // 2. Dynamic Spread / Handicap / Run Line / Puck Line
  if (marketOdds.spreadLine !== undefined && Number.isFinite(marketOdds.spreadLine)) {
    const line = marketOdds.spreadLine;
    const { homeCoverProb, awayCoverProb } = evaluateSpreadLine(prediction, line);
    const spreadCategory = getSpreadCategory(meta.sport);
    const homeLabel = `${meta.homeTeam} ${line > 0 ? `+${line}` : line}`;
    const awayLine = -line;
    const awayLabel = `${meta.awayTeam} ${awayLine > 0 ? `+${awayLine}` : awayLine}`;

    pushCandidate(
      spreadCategory,
      homeLabel,
      'home',
      homeCoverProb,
      awayCoverProb,
      marketOdds.spreadHomeOdds,
      line
    );
    pushCandidate(
      spreadCategory,
      awayLabel,
      'away',
      awayCoverProb,
      homeCoverProb,
      marketOdds.spreadAwayOdds,
      awayLine
    );
  }

  // 3. Dynamic Over / Under Total
  if (marketOdds.totalLine !== undefined && Number.isFinite(marketOdds.totalLine)) {
    const line = marketOdds.totalLine;
    const { overProb, underProb } = evaluateTotalLine(prediction, line);
    const totalCategory = getTotalCategory(meta.sport);

    pushCandidate(
      totalCategory,
      `Over ${line}`,
      'over',
      overProb,
      underProb,
      marketOdds.overOdds,
      line
    );
    pushCandidate(
      totalCategory,
      `Under ${line}`,
      'under',
      underProb,
      overProb,
      marketOdds.underOdds,
      line
    );
  }

  return candidates.sort((a, b) => b.convictionScore - a.convictionScore || b.evPct - a.evPct);
}

export function rankBestBets(alerts: ValueAlert[]): ValueAlert[] {
  return [...alerts].sort((a, b) => {
    if (b.convictionScore !== a.convictionScore) {
      return b.convictionScore - a.convictionScore;
    }
    if (b.oddsVerifiedLive !== a.oddsVerifiedLive) {
      return b.oddsVerifiedLive ? 1 : -1;
    }
    return b.evPct - a.evPct;
  });
}
