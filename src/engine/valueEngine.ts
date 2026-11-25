import {
  DataQualityTier,
  MarketCategory,
  MarketOdds,
  MatchStatus,
  PureFlowPrediction,
  SportType,
  ValueAlert,
} from '../types/quant';
import { clamp, decimalToImpliedProb, kellyFraction, probToDecimalOdds } from './mathUtils';
import { evaluateSpreadLine, evaluateTotalLine } from './predictionEngine';
import { verifyMarketOdds } from './oddsVerification';

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
  /** Default: refuse to recommend against an unprovenanced price. */
  requireVerifiedPrice?: boolean;
  now?: Date;
  maxPriceAgeSec?: number;
  /**
   * Weight on the model in a logit blend with the de-vigged market price,
   * in [0, 1]. 1 = trust the model fully (no shrinkage). When omitted a
   * default weight is chosen from the evidence tier (see DEFAULT_MODEL_WEIGHT).
   * Shrinking toward the market counters the winner's curse: a bet is only
   * selected when the model disagrees with the market, and a share of that
   * disagreement is model error rather than edge.
   */
  modelWeight?: number;
}

/** Conservative defaults: thinner evidence means more shrinkage toward the market. */
export const DEFAULT_MODEL_WEIGHT: Record<DataQualityTier, number> = {
  play_by_play_boxscore: 0.8,
  live_boxscore: 0.7,
  record_prior: 0.5,
};

const logit = (p: number): number => {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
};
const expit = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Shrink a model win/loss/push split toward the no-vig market probability.
 * Works on the conditional (non-push) win probability and re-applies the push mass.
 */
export function shrinkTowardMarket(
  winProb: number,
  lossProb: number,
  pushProb: number,
  marketNoVigProb: number | null,
  weight: number
): { winProb: number; lossProb: number } {
  const w = clamp(weight, 0, 1);
  if (w >= 1 || marketNoVigProb === null || !Number.isFinite(marketNoVigProb)) {
    return { winProb, lossProb };
  }
  const decided = winProb + lossProb;
  if (!(decided > 0)) return { winProb, lossProb };
  const modelCond = winProb / decided;
  const blendedCond = expit(w * logit(modelCond) + (1 - w) * logit(marketNoVigProb));
  return { winProb: blendedCond * decided, lossProb: (1 - blendedCond) * decided };
}

/** No-vig probability of one selection given every mutually exclusive price in its market. */
export function noVigProbability(selfOdds: number | undefined, otherOdds: Array<number | undefined>): number | null {
  const valid = (o: number | undefined): o is number => typeof o === 'number' && Number.isFinite(o) && o > 1.01;
  if (!valid(selfOdds)) return null;
  const others = otherOdds.filter(valid);
  if (others.length === 0) return null;
  const self = 1 / selfOdds;
  const total = self + others.reduce((a, o) => a + 1 / o, 0);
  return total > 0 ? self / total : null;
}

const DATA_QUALITY_SCORE: Record<DataQualityTier, number> = {
  play_by_play_boxscore: 1,
  live_boxscore: 0.66,
  record_prior: 0.25,
};

function calcEvAndQuarterKelly(
  winProb: number,
  lossProb: number,
  decimalOdds: number
): { evPct: number; kellyQuarterPct: number } {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1.01) {
    return { evPct: -100, kellyQuarterPct: 0 };
  }
  if (!Number.isFinite(winProb) || !Number.isFinite(lossProb)) {
    return { evPct: -100, kellyQuarterPct: 0 };
  }
  const b = decimalOdds - 1;
  const ev = winProb * b - lossProb;
  const evPct = Math.round(ev * 1000) / 10;
  const kellyFull = kellyFraction(winProb, lossProb, decimalOdds);
  const kellyQuarterPct =
    kellyFull <= 0 ? 0 : Math.round(clamp(kellyFull * 0.25 * 100, 0, 5.0) * 100) / 100;
  return { evPct, kellyQuarterPct };
}

/**
 * Computes a 0-100 Conviction Score weighting:
 * 1. Positive EV magnitude (diminishing returns + suspicion penalty > +30% EV)
 * 2. Live telemetry data depth (play_by_play_boxscore > live_boxscore > record_prior)
 * 3. Odds verification status (Verified Live > Pre-Match / Closing)
 * 4. Quarter-Kelly sizing consistency
 * Elapsed match progress is deliberately excluded: time on the clock is not
 * evidence quality and must not inflate conviction.
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

  const kellyConsistency = clamp(alert.kellyQuarterStakePct / 3.0, 0, 1) * 6;

  // Extreme longshot penalty (e.g. > 8.0 decimal odds has higher model tail sensitivity)
  const oddsTailPenalty = alert.bookmakerOdds > 7.5 ? Math.min(8, (alert.bookmakerOdds - 7.5) * 1.2) : 0;

  return Math.round(
    clamp(evScore + tierScore + oddsScore + kellyConsistency - oddsTailPenalty, 1, 99)
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
  const requireVerifiedPrice = options.requireVerifiedPrice ?? true;

  // Verification is recomputed against the selected price and the current
  // time; a producer flag alone is never trusted.
  const verification = verifyMarketOdds(marketOdds, {
    matchStatus: meta.status,
    now: options.now,
    maxAgeSec: options.maxPriceAgeSec,
    liveMaxAgeSec: Math.min(options.maxPriceAgeSec ?? 180, 180),
  });
  if (requireVerifiedPrice && !verification.verified) {
    return [];
  }

  const verifiedLiveOnly = options.verifiedLiveOnly ?? false;
  if (verifiedLiveOnly && !verification.isLiveVerified) {
    return [];
  }

  const oddsVerifiedLive = verification.isLiveVerified;
  const oddsLabel: ValueAlert['oddsLabel'] = oddsVerifiedLive
    ? 'Verified Live'
    : 'Pre-Match / Closing';
  const priceKind = marketOdds.priceKind ?? 'unknown';
  const dataQualityScore = DATA_QUALITY_SCORE[meta.dataQuality] ?? 0.25;

  const candidates: ValueAlert[] = [];

  const pushCandidate = (
    marketCategory: MarketCategory,
    selection: string,
    side: ValueAlert['side'],
    winProb: number,
    lossProb: number,
    pushProb: number,
    bookmakerOdds: number | undefined,
    line?: number,
    siblingOdds: Array<number | undefined> = []
  ) => {
    if (!bookmakerOdds || !Number.isFinite(bookmakerOdds) || bookmakerOdds <= 1.01) {
      return;
    }
    const rawModelProb = winProb;
    const envWeight = Number.parseFloat(process.env.MODEL_MARKET_WEIGHT ?? '');
    const weight =
      options.modelWeight ??
      (Number.isFinite(envWeight) ? envWeight : undefined) ??
      DEFAULT_MODEL_WEIGHT[meta.dataQuality] ??
      0.7;
    const shrunk = shrinkTowardMarket(
      winProb,
      lossProb,
      pushProb,
      noVigProbability(bookmakerOdds, siblingOdds),
      weight
    );
    winProb = shrunk.winProb;
    lossProb = shrunk.lossProb;
    const { evPct, kellyQuarterPct } = calcEvAndQuarterKelly(
      winProb,
      lossProb,
      bookmakerOdds
    );
    if (evPct < minEvPct) return;

    const fairOdds = probToDecimalOdds(winProb, pushProb);
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
      lossProb: Math.round(clamp(lossProb, 0, 1) * 10000) / 10000,
      pushProb: Math.round(clamp(pushProb, 0, 1) * 10000) / 10000,
      bookmakerOdds: Math.round(bookmakerOdds * 100) / 100,
      impliedProb: Math.round(impliedProb * 10000) / 10000,
      evPct,
      kellyQuarterStakePct: kellyQuarterPct,
      oddsVerifiedLive,
      oddsLabel,
      priceVerified: verification.verified,
      priceKind,
      priceSource: marketOdds.source ?? marketOdds.provider,
      priceCapturedAt: marketOdds.capturedAt ?? marketOdds.lastUpdated,
      provider: marketOdds.provider,
      dataQuality: meta.dataQuality,
      progressPct: meta.progressPct,
      modelProbability: Math.round(rawModelProb * 10000) / 10000,
      dataQualityScore,
      uncertaintyScore:
        Math.round(clamp(1 - prediction.confidence, 0, 1) * 10000) / 10000,
      calibrationScore: 1,
      convictionScore: 0,
      rankingScore: 0,
    };

    draft.convictionScore = computeConvictionScore(draft, {
      progressPct: meta.progressPct,
      dataQuality: meta.dataQuality,
      status: meta.status,
    });
    draft.rankingScore = draft.convictionScore;
    candidates.push(draft);
  };

  // 1. Moneyline / 1X2
  const mlCategory = getMoneylineCategory(meta.sport);
  if (meta.sport === 'soccer') {
    const pHome = prediction.fairProbs.homeWin;
    const pDraw = prediction.fairProbs.draw ?? 0;
    const pAway = prediction.fairProbs.awayWin;

    pushCandidate(mlCategory, `${meta.homeTeam} Win`, 'home', pHome, 1 - pHome, 0, marketOdds.moneylineHome, undefined, [marketOdds.moneylineDraw, marketOdds.moneylineAway]);
    if (marketOdds.moneylineDraw) {
      pushCandidate(mlCategory, 'Draw', 'draw', pDraw, 1 - pDraw, 0, marketOdds.moneylineDraw, undefined, [marketOdds.moneylineHome, marketOdds.moneylineAway]);
    }
    pushCandidate(mlCategory, `${meta.awayTeam} Win`, 'away', pAway, 1 - pAway, 0, marketOdds.moneylineAway, undefined, [marketOdds.moneylineHome, marketOdds.moneylineDraw]);
  } else {
    const pHome = prediction.fairProbs.homeWin;
    const pAway = prediction.fairProbs.awayWin;
    pushCandidate(mlCategory, `${meta.homeTeam} ML`, 'home', pHome, 1 - pHome, 0, marketOdds.moneylineHome, undefined, [marketOdds.moneylineAway]);
    pushCandidate(mlCategory, `${meta.awayTeam} ML`, 'away', pAway, 1 - pAway, 0, marketOdds.moneylineAway, undefined, [marketOdds.moneylineHome]);
  }

  // 2. Dynamic Spread / Handicap / Run Line / Puck Line
  if (marketOdds.spreadLine !== undefined && Number.isFinite(marketOdds.spreadLine)) {
    const line = marketOdds.spreadLine;
    const { homeCoverProb, awayCoverProb, pushProb } = evaluateSpreadLine(prediction, line);
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
      pushProb,
      marketOdds.spreadHomeOdds,
      line,
      [marketOdds.spreadAwayOdds]
    );
    pushCandidate(
      spreadCategory,
      awayLabel,
      'away',
      awayCoverProb,
      homeCoverProb,
      pushProb,
      marketOdds.spreadAwayOdds,
      awayLine,
      [marketOdds.spreadHomeOdds]
    );
  }

  // 3. Dynamic Over / Under Total
  if (marketOdds.totalLine !== undefined && Number.isFinite(marketOdds.totalLine)) {
    const line = marketOdds.totalLine;
    const { overProb, underProb, pushProb } = evaluateTotalLine(prediction, line);
    const totalCategory = getTotalCategory(meta.sport);

    pushCandidate(
      totalCategory,
      `Over ${line}`,
      'over',
      overProb,
      underProb,
      pushProb,
      marketOdds.overOdds,
      line,
      [marketOdds.underOdds]
    );
    pushCandidate(
      totalCategory,
      `Under ${line}`,
      'under',
      underProb,
      overProb,
      pushProb,
      marketOdds.underOdds,
      line,
      [marketOdds.overOdds]
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
