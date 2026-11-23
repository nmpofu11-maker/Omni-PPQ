import {
  DataQualityTier,
  OddsFreeMatchSnapshot,
  PlayEvent,
  PureFlowPrediction,
  ScrapedMatch,
  TeamTelemetry,
} from '../types/quant';
import {
  clamp,
  normalCdf,
  parseRecordWinPct,
  poissonPmf,
} from './mathUtils';

/**
 * STAGE 1 ODDS FIREWALL:
 * Explicitly strips all bookmaker odds, implied probabilities, and market lines
 * before any prediction math can run.
 */
export function stripOddsForFirewall(
  match: ScrapedMatch | OddsFreeMatchSnapshot
): OddsFreeMatchSnapshot {
  return {
    id: match.id,
    sport: match.sport,
    league: match.league,
    leagueName: match.leagueName,
    sportPath: match.sportPath,
    status: match.status,
    startTime: match.startTime,
    clockLabel: match.clockLabel,
    period: match.period,
    progressPct: clamp(match.progressPct, 0, 1),
    regulationMinutes: match.regulationMinutes,
    bestOfSets: match.bestOfSets,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    homeAbbrev: match.homeAbbrev,
    awayAbbrev: match.awayAbbrev,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    homeRecord: match.homeRecord,
    awayRecord: match.awayRecord,
    homeStats: { ...match.homeStats },
    awayStats: { ...match.awayStats },
    plays: Array.isArray(match.plays) ? match.plays.map((p) => ({ ...p })) : [],
    dataQuality: match.dataQuality,
    bbcVerifiedScore: match.bbcVerifiedScore
      ? { ...match.bbcVerifiedScore }
      : undefined,
  };
}

function buildMomentumSeries(
  plays: PlayEvent[],
  progressPct: number,
  homeBase: number,
  awayBase: number
): PureFlowPrediction['momentumSeries'] {
  const buckets = 8;
  const maxPct = Math.max(0.1, progressPct);
  const series: PureFlowPrediction['momentumSeries'] = [];

  for (let i = 1; i <= buckets; i++) {
    const bucketEnd = (i / buckets) * maxPct;
    const bucketStart = ((i - 1) / buckets) * maxPct;
    let homeSignal = 0;
    let awaySignal = 0;

    for (const play of plays) {
      if (play.elapsedPct >= bucketStart && play.elapsedPct <= bucketEnd) {
        if (play.team === 'home') homeSignal += play.weight;
        else if (play.team === 'away') awaySignal += play.weight;
      }
    }

    const total = homeSignal + awaySignal;
    const homeMomentum =
      total > 0
        ? clamp(0.25 + 0.75 * (homeSignal / total), 0.1, 0.95)
        : clamp(homeBase / Math.max(0.1, homeBase + awayBase), 0.2, 0.8);
    const awayMomentum = clamp(1 - homeMomentum, 0.05, 0.9);

    series.push({
      pct: Math.round(bucketEnd * 100),
      label: `${Math.round(bucketEnd * 100)}%`,
      homeMomentum: Math.round(homeMomentum * 100) / 100,
      awayMomentum: Math.round(awayMomentum * 100) / 100,
    });
  }

  return series;
}

function computeRecencyFlowScore(
  plays: PlayEvent[],
  currentPct: number,
  scaleMinutes: number,
  decayRate = 0.08
): { homeFlow: number; awayFlow: number; count: number } {
  let homeFlow = 0;
  let awayFlow = 0;
  let count = 0;

  for (const p of plays) {
    const deltaPct = Math.max(0, currentPct - p.elapsedPct);
    const deltaMin = deltaPct * scaleMinutes;
    const recencyWeight = Math.exp(-decayRate * deltaMin);
    const w = Math.max(0.1, p.weight) * recencyWeight;
    if (p.team === 'home') {
      homeFlow += w;
      count++;
    } else if (p.team === 'away') {
      awayFlow += w;
      count++;
    }
  }
  return { homeFlow, awayFlow, count };
}

function getRecordAdvantage(homeRecord?: string, awayRecord?: string): {
  homeStrength: number; // centered around 0.5
  awayStrength: number;
  diffPrior: number; // [-0.35, +0.35]
} {
  const h = parseRecordWinPct(homeRecord);
  const a = parseRecordWinPct(awayRecord);
  const hPct = h ? h.winPct : 0.53; // slight home field/court prior when unknown
  const aPct = a ? a.winPct : 0.47;
  // Log5 / Bradley-Terry relative strength
  const denom = hPct * (1 - aPct) + (1 - hPct) * aPct;
  const homeWinPrior = denom > 0 ? (hPct * (1 - aPct)) / denom : 0.53;
  // Blend slight home advantage
  const adjustedHome = clamp(homeWinPrior * 0.92 + 0.54 * 0.08, 0.15, 0.85);
  return {
    homeStrength: adjustedHome,
    awayStrength: 1 - adjustedHome,
    diffPrior: adjustedHome - 0.5,
  };
}

function hasLiveBoxscoreMetrics(stats: TeamTelemetry): boolean {
  return Boolean(
    stats.shots !== undefined ||
      stats.shotsOnTarget !== undefined ||
      stats.fieldGoalPct !== undefined ||
      stats.totalYards !== undefined ||
      stats.baseballHits !== undefined ||
      stats.powerPlayPct !== undefined ||
      stats.hits !== undefined ||
      stats.aces !== undefined ||
      (stats.linescores && stats.linescores.length > 0)
  );
}

export function inferDataQuality(snapshot: OddsFreeMatchSnapshot): DataQualityTier {
  const hasPlays = snapshot.plays && snapshot.plays.length > 0;
  const hasBox =
    hasLiveBoxscoreMetrics(snapshot.homeStats) ||
    hasLiveBoxscoreMetrics(snapshot.awayStats);

  if (hasPlays && hasBox) return 'play_by_play_boxscore';
  if (hasBox || (snapshot.status === 'live' && snapshot.progressPct > 0.05)) {
    return 'live_boxscore';
  }
  return 'record_prior';
}

// ---------------- POISSON GRID HELPERS ----------------

function computePoissonMatrixOutcomes(
  currentHome: number,
  currentAway: number,
  lambdaHomeRem: number,
  lambdaAwayRem: number,
  maxGoals = 12
) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  const pH: number[] = [];
  const pA: number[] = [];
  for (let i = 0; i <= maxGoals; i++) {
    pH.push(poissonPmf(i, lambdaHomeRem));
    pA.push(poissonPmf(i, lambdaAwayRem));
  }

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const prob = pH[i] * pA[j];
      const finalH = currentHome + i;
      const finalA = currentAway + j;
      if (finalH > finalA) homeWin += prob;
      else if (finalH === finalA) draw += prob;
      else awayWin += prob;
    }
  }

  const norm = homeWin + draw + awayWin;
  if (norm > 0) {
    homeWin /= norm;
    draw /= norm;
    awayWin /= norm;
  }

  return { homeWin, draw, awayWin };
}

export function evaluateTotalLine(
  prediction: PureFlowPrediction,
  line: number
): { overProb: number; underProb: number; pushProb: number } {
  if (prediction.progressPct >= 1) {
    const finalTotal =
      prediction.poissonLambdas
        ? prediction.poissonLambdas.currentHome + prediction.poissonLambdas.currentAway
        : prediction.gaussianParams
          ? prediction.gaussianParams.currentTotal
          : prediction.expectedRemaining.totalMean;
    if (finalTotal > line) return { overProb: 1, underProb: 0, pushProb: 0 };
    if (finalTotal < line) return { overProb: 0, underProb: 1, pushProb: 0 };
    return { overProb: 0, underProb: 0, pushProb: 1 };
  }

  // Discrete Poisson evaluation for Soccer, Hockey, Baseball
  if (prediction.poissonLambdas) {
    const { currentHome, currentAway, homeLambda, awayLambda } =
      prediction.poissonLambdas;
    const currentTotal = currentHome + currentAway;
    const totalLambda = Math.max(0.001, homeLambda + awayLambda);
    let overProb = 0;
    let underProb = 0;
    let pushProb = 0;

    for (let k = 0; k <= 30; k++) {
      const p = poissonPmf(k, totalLambda);
      const finalTotal = currentTotal + k;
      if (finalTotal > line) overProb += p;
      else if (finalTotal < line) underProb += p;
      else pushProb += p;
    }

    const total = overProb + underProb + pushProb;
    if (total > 0) {
      overProb /= total;
      underProb /= total;
      pushProb /= total;
    }
    return { overProb, underProb, pushProb };
  }

  // Gaussian evaluation for Basketball, Football, Tennis
  const mean =
    prediction.gaussianParams?.expectedFinalTotal ??
    prediction.expectedRemaining.totalMean;
  const std = Math.max(
    0.5,
    prediction.gaussianParams?.totalStd ??
      prediction.expectedRemaining.totalStd ??
      12
  );

  const isIntegerLine = Math.abs(line - Math.round(line)) < 1e-6;
  if (isIntegerLine) {
    // Continuity correction for whole-number totals
    const underProb = normalCdf((line - 0.5 - mean) / std);
    const overProb = 1 - normalCdf((line + 0.5 - mean) / std);
    const pushProb = clamp(1 - underProb - overProb, 0, 1);
    return {
      overProb: clamp(overProb, 0.01, 0.99),
      underProb: clamp(underProb, 0.01, 0.99),
      pushProb,
    };
  }

  const underProb = clamp(normalCdf((line - mean) / std), 0.01, 0.99);
  const overProb = clamp(1 - underProb, 0.01, 0.99);
  return { overProb, underProb, pushProb: 0 };
}

export function evaluateSpreadLine(
  prediction: PureFlowPrediction,
  spreadHomeLine: number
): { homeCoverProb: number; awayCoverProb: number; pushProb: number } {
  // spreadHomeLine = -5.5 means home must win by >= 6 (homeScore + spreadHomeLine > awayScore)
  if (prediction.progressPct >= 1) {
    const finalMargin =
      prediction.poissonLambdas
        ? prediction.poissonLambdas.currentHome - prediction.poissonLambdas.currentAway
        : prediction.gaussianParams
          ? prediction.gaussianParams.currentMargin
          : prediction.expectedRemaining.spreadMean;
    const adjusted = finalMargin + spreadHomeLine;
    if (adjusted > 0) return { homeCoverProb: 1, awayCoverProb: 0, pushProb: 0 };
    if (adjusted < 0) return { homeCoverProb: 0, awayCoverProb: 1, pushProb: 0 };
    return { homeCoverProb: 0, awayCoverProb: 0, pushProb: 1 };
  }

  if (prediction.poissonLambdas) {
    const { currentHome, currentAway, homeLambda, awayLambda } =
      prediction.poissonLambdas;
    let homeCoverProb = 0;
    let awayCoverProb = 0;
    let pushProb = 0;
    const maxK = 14;
    const pH: number[] = [];
    const pA: number[] = [];
    for (let k = 0; k <= maxK; k++) {
      pH.push(poissonPmf(k, homeLambda));
      pA.push(poissonPmf(k, awayLambda));
    }

    for (let i = 0; i <= maxK; i++) {
      for (let j = 0; j <= maxK; j++) {
        const prob = pH[i] * pA[j];
        const margin = currentHome + i - (currentAway + j);
        const adj = margin + spreadHomeLine;
        if (adj > 1e-6) homeCoverProb += prob;
        else if (adj < -1e-6) awayCoverProb += prob;
        else pushProb += prob;
      }
    }

    const norm = homeCoverProb + awayCoverProb + pushProb;
    if (norm > 0) {
      homeCoverProb /= norm;
      awayCoverProb /= norm;
      pushProb /= norm;
    }
    return { homeCoverProb, awayCoverProb, pushProb };
  }

  // Gaussian spread evaluation (Basketball, Football, Tennis)
  const meanMargin =
    prediction.gaussianParams?.expectedFinalMargin ??
    prediction.expectedRemaining.spreadMean;
  const stdMargin = Math.max(
    0.5,
    prediction.gaussianParams?.marginStd ??
      prediction.expectedRemaining.spreadStd ??
      10
  );

  // Home covers when FinalMargin > -spreadHomeLine
  const targetMargin = -spreadHomeLine;
  const isIntegerLine = Math.abs(spreadHomeLine - Math.round(spreadHomeLine)) < 1e-6;
  if (isIntegerLine) {
    const awayCoverProb = normalCdf((targetMargin - 0.5 - meanMargin) / stdMargin);
    const homeCoverProb = 1 - normalCdf((targetMargin + 0.5 - meanMargin) / stdMargin);
    const pushProb = clamp(1 - awayCoverProb - homeCoverProb, 0, 1);
    return {
      homeCoverProb: clamp(homeCoverProb, 0.01, 0.99),
      awayCoverProb: clamp(awayCoverProb, 0.01, 0.99),
      pushProb,
    };
  }

  const awayCoverProb = clamp(normalCdf((targetMargin - meanMargin) / stdMargin), 0.01, 0.99);
  const homeCoverProb = clamp(1 - awayCoverProb, 0.01, 0.99);
  return { homeCoverProb, awayCoverProb, pushProb: 0 };
}

// ---------------- SPORT MODELS ----------------

function predictSoccer(snapshot: OddsFreeMatchSnapshot): PureFlowPrediction {
  const p = clamp(snapshot.progressPct, 0, 1);
  const rem = Math.max(0, 1 - p);
  const tier = inferDataQuality(snapshot);
  const { diffPrior } = getRecordAdvantage(snapshot.homeRecord, snapshot.awayRecord);

  const h = snapshot.homeStats;
  const a = snapshot.awayStats;

  // Base per-90 goal expectation (prior ~1.42 home, ~1.18 away)
  const priorHome90 = clamp(1.42 + diffPrior * 1.15, 0.65, 2.55);
  const priorAway90 = clamp(1.18 - diffPrior * 1.15, 0.55, 2.35);

  // Live boxscore intensity shrunk with Bayesian pseudo-minutes (35m prior weight)
  const elapsedMin = Math.max(1, p * 90);
  const shrinkage = elapsedMin / (elapsedMin + 35);

  const hSot = h.shotsOnTarget ?? 0;
  const aSot = a.shotsOnTarget ?? 0;
  const hShots = h.shots ?? hSot * 2.4;
  const aShots = a.shots ?? aSot * 2.4;
  const hCorners = h.corners ?? 0;
  const aCorners = a.corners ?? 0;
  const hPoss = h.possessionPct ?? 50;
  const aPoss = a.possessionPct ?? 50;

  const liveHome90 =
    ((hSot * 0.31 + (hShots - hSot) * 0.07 + hCorners * 0.04) * (90 / elapsedMin)) *
      (0.85 + (hPoss / 100) * 0.3) +
    0.15;
  const liveAway90 =
    ((aSot * 0.31 + (aShots - aSot) * 0.07 + aCorners * 0.04) * (90 / elapsedMin)) *
      (0.85 + (aPoss / 100) * 0.3) +
    0.15;

  const hasBox = hasLiveBoxscoreMetrics(h) || hasLiveBoxscoreMetrics(a);
  let blendedHome90 = hasBox
    ? priorHome90 * (1 - shrinkage) + clamp(liveHome90, 0.35, 3.6) * shrinkage
    : priorHome90;
  let blendedAway90 = hasBox
    ? priorAway90 * (1 - shrinkage) + clamp(liveAway90, 0.35, 3.6) * shrinkage
    : priorAway90;

  // Play-by-play recency-decayed flow adjustment
  const flow = computeRecencyFlowScore(snapshot.plays, p, 90, 0.08);
  if (flow.count > 0) {
    const flowShareH = flow.homeFlow / Math.max(0.01, flow.homeFlow + flow.awayFlow);
    const flowTilt = (flowShareH - 0.5) * 0.55;
    blendedHome90 = clamp(blendedHome90 * (1 + flowTilt), 0.3, 3.8);
    blendedAway90 = clamp(blendedAway90 * (1 - flowTilt), 0.3, 3.8);
  }

  // Red card discipline adjustment
  const hRed = h.redCards ?? 0;
  const aRed = a.redCards ?? 0;
  if (hRed > aRed) {
    blendedHome90 *= Math.pow(0.74, hRed - aRed);
    blendedAway90 *= Math.pow(1.22, hRed - aRed);
  } else if (aRed > hRed) {
    blendedAway90 *= Math.pow(0.74, aRed - hRed);
    blendedHome90 *= Math.pow(1.22, aRed - hRed);
  }

  // Trailing game-state urgency in final 25%
  if (p > 0.7 && snapshot.homeScore !== snapshot.awayScore) {
    if (snapshot.homeScore < snapshot.awayScore) {
      blendedHome90 *= 1.14;
      blendedAway90 *= 0.96;
    } else {
      blendedAway90 *= 1.14;
      blendedHome90 *= 0.96;
    }
  }

  const homeLambdaRem = snapshot.status === 'finished' || rem <= 0 ? 0.0001 : blendedHome90 * rem;
  const awayLambdaRem = snapshot.status === 'finished' || rem <= 0 ? 0.0001 : blendedAway90 * rem;

  const { homeWin, draw, awayWin } =
    snapshot.status === 'finished'
      ? {
          homeWin: snapshot.homeScore > snapshot.awayScore ? 1 : 0,
          draw: snapshot.homeScore === snapshot.awayScore ? 1 : 0,
          awayWin: snapshot.homeScore < snapshot.awayScore ? 1 : 0,
        }
      : computePoissonMatrixOutcomes(
          snapshot.homeScore,
          snapshot.awayScore,
          homeLambdaRem,
          awayLambdaRem,
          10
        );

  const nonDraw = Math.max(0.001, homeWin + awayWin);
  const nextDenom = Math.max(0.001, homeLambdaRem + awayLambdaRem);

  const basePred: PureFlowPrediction = {
    matchId: snapshot.id,
    sport: 'soccer',
    dataQuality: tier,
    progressPct: p,
    fairProbs: {
      homeWin,
      draw,
      awayWin,
      dnbHome: homeWin / nonDraw,
      dnbAway: awayWin / nonDraw,
      nextGoalHome: homeLambdaRem / nextDenom,
      nextGoalAway: awayLambdaRem / nextDenom,
    },
    expectedRemaining: {
      homeMean: homeLambdaRem,
      awayMean: awayLambdaRem,
      totalMean: snapshot.homeScore + snapshot.awayScore + homeLambdaRem + awayLambdaRem,
      spreadMean: snapshot.homeScore - snapshot.awayScore + (homeLambdaRem - awayLambdaRem),
    },
    poissonLambdas: {
      homeLambda: homeLambdaRem,
      awayLambda: awayLambdaRem,
      currentHome: snapshot.homeScore,
      currentAway: snapshot.awayScore,
    },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: buildMomentumSeries(
      snapshot.plays,
      p,
      blendedHome90,
      blendedAway90
    ),
    confidence: clamp(0.45 + 0.35 * p + (tier === 'play_by_play_boxscore' ? 0.2 : tier === 'live_boxscore' ? 0.1 : 0), 0.35, 0.96),
    modelNotes: [
      `Per-90 goal intensities: ${blendedHome90.toFixed(2)} vs ${blendedAway90.toFixed(2)}`,
      `Remaining joint Poisson λ: (${homeLambdaRem.toFixed(2)}, ${awayLambdaRem.toFixed(2)})`,
    ],
  };

  basePred.standardLines.totalLines = [1.5, 2.5, 3.5, 4.5].map((line) => ({
    line,
    ...evaluateTotalLine(basePred, line),
  }));
  basePred.standardLines.spreadLines = [-1.5, -0.5, 0, 0.5, 1.5].map((line) => ({
    line,
    ...evaluateSpreadLine(basePred, line),
  }));

  return basePred;
}

function predictBasketball(snapshot: OddsFreeMatchSnapshot): PureFlowPrediction {
  const p = clamp(snapshot.progressPct, 0, 1);
  const rem = Math.max(0, 1 - p);
  const tier = inferDataQuality(snapshot);
  const { diffPrior } = getRecordAdvantage(snapshot.homeRecord, snapshot.awayRecord);
  const regMinutes = snapshot.regulationMinutes ?? (snapshot.league.includes('nba') ? 48 : 40);
  const isNba = snapshot.league.includes('nba');
  const priorTeamTotal = isNba ? 113.5 : 73.5;

  const h = snapshot.homeStats;
  const a = snapshot.awayStats;

  // Prior full-game margin & total
  const priorMargin = diffPrior * (isNba ? 24 : 26) + (isNba ? 2.1 : 2.8);
  const priorTotal = priorTeamTotal * 2;

  const currentTotal = snapshot.homeScore + snapshot.awayScore;
  const currentMargin = snapshot.homeScore - snapshot.awayScore;

  // Shooting & efficiency adjustment (FG%, 3P%, TO, REB)
  const hFg = h.fieldGoalPct ?? 46;
  const aFg = a.fieldGoalPct ?? 46;
  const h3p = h.threePointPct ?? 35;
  const a3p = a.threePointPct ?? 35;
  const hTo = h.turnovers ?? 0;
  const aTo = a.turnovers ?? 0;
  const hReb = h.rebounds ?? 0;
  const aReb = a.rebounds ?? 0;

  const hasBox = hasLiveBoxscoreMetrics(h) || hasLiveBoxscoreMetrics(a);
  const effEdge = hasBox
    ? (hFg - aFg) * 0.28 + (h3p - a3p) * 0.14 + (aTo - hTo) * 0.45 + (hReb - aReb) * 0.16
    : 0;

  // Play-by-play recent scoring run momentum
  const flow = computeRecencyFlowScore(snapshot.plays, p, regMinutes, 0.14);
  const flowMarginAdj =
    flow.count > 0
      ? ((flow.homeFlow - flow.awayFlow) / Math.max(1, flow.homeFlow + flow.awayFlow)) * 3.8
      : 0;

  // Pace projection blended from current scoring pace & prior total
  const livePaceTotal = p > 0.08 ? currentTotal / p : priorTotal;
  const paceWeight = clamp(p * 1.15, 0, 0.85);
  const projectedFullTotal = priorTotal * (1 - paceWeight) + clamp(livePaceTotal, priorTotal * 0.68, priorTotal * 1.35) * paceWeight;

  const expectedRemainingMargin =
    (priorMargin * (1 - clamp(p * 0.6, 0, 0.6)) + effEdge * 0.45 + flowMarginAdj) * rem;
  const expectedRemainingTotal = Math.max(0, (projectedFullTotal / regMinutes) * (regMinutes * rem));

  const expectedFinalMargin =
    snapshot.status === 'finished' ? currentMargin : currentMargin + expectedRemainingMargin;
  const expectedFinalTotal =
    snapshot.status === 'finished' ? currentTotal : currentTotal + expectedRemainingTotal;

  // Exact Gaussian uncertainty curves from specification
  const marginStd =
    snapshot.status === 'finished'
      ? 0.01
      : 12.2 * Math.sqrt(Math.max(0.01, 1 - p + 0.04));
  const totalStd =
    snapshot.status === 'finished'
      ? 0.01
      : 15.8 * Math.sqrt(Math.max(0.01, 1 - p + 0.04));

  const homeWin =
    snapshot.status === 'finished'
      ? currentMargin > 0
        ? 1
        : currentMargin < 0
          ? 0
          : 0.5
      : clamp(normalCdf(expectedFinalMargin / marginStd), 0.01, 0.99);
  const awayWin = 1 - homeWin;

  const pred: PureFlowPrediction = {
    matchId: snapshot.id,
    sport: 'basketball',
    dataQuality: tier,
    progressPct: p,
    fairProbs: {
      homeWin,
      awayWin,
    },
    expectedRemaining: {
      homeMean: Math.max(0, (expectedRemainingTotal + expectedRemainingMargin) / 2),
      awayMean: Math.max(0, (expectedRemainingTotal - expectedRemainingMargin) / 2),
      totalMean: expectedFinalTotal,
      spreadMean: expectedFinalMargin,
      spreadStd: marginStd,
      totalStd,
    },
    gaussianParams: {
      currentMargin,
      currentTotal,
      expectedFinalMargin,
      marginStd,
      expectedFinalTotal,
      totalStd,
    },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: buildMomentumSeries(snapshot.plays, p, Math.max(0.2, 0.5 + effEdge * 0.02), Math.max(0.2, 0.5 - effEdge * 0.02)),
    confidence: clamp(0.45 + 0.35 * p + (tier === 'play_by_play_boxscore' ? 0.2 : tier === 'live_boxscore' ? 0.1 : 0), 0.35, 0.97),
    modelNotes: [
      `Projected final margin: ${expectedFinalMargin >= 0 ? '+' : ''}${expectedFinalMargin.toFixed(1)} (σ=${marginStd.toFixed(1)})`,
      `Projected final total: ${expectedFinalTotal.toFixed(1)} (σ=${totalStd.toFixed(1)})`,
    ],
  };

  const roundedTotal = Math.round(expectedFinalTotal * 2) / 2;
  const roundedSpread = Math.round(-expectedFinalMargin * 2) / 2;
  pred.standardLines.totalLines = [-6, -2, 0, 2, 6].map((d) => {
    const line = Math.max(80.5, roundedTotal + d + (Number.isInteger(roundedTotal + d) ? 0.5 : 0));
    return { line, ...evaluateTotalLine(pred, line) };
  });
  pred.standardLines.spreadLines = [-4, -1.5, 0, 1.5, 4].map((d) => {
    const line = roundedSpread + d;
    return { line, ...evaluateSpreadLine(pred, line) };
  });

  return pred;
}

function predictFootball(snapshot: OddsFreeMatchSnapshot): PureFlowPrediction {
  const p = clamp(snapshot.progressPct, 0, 1);
  const rem = Math.max(0, 1 - p);
  const tier = inferDataQuality(snapshot);
  const { diffPrior } = getRecordAdvantage(snapshot.homeRecord, snapshot.awayRecord);

  const h = snapshot.homeStats;
  const a = snapshot.awayStats;

  const priorTotal = 45.5;
  const priorMargin = diffPrior * 19 + 1.8;

  const currentTotal = snapshot.homeScore + snapshot.awayScore;
  const currentMargin = snapshot.homeScore - snapshot.awayScore;

  const hasBox = hasLiveBoxscoreMetrics(h) || hasLiveBoxscoreMetrics(a);
  const hYards = h.totalYards ?? (h.passingYards ?? 0) + (h.rushingYards ?? 0);
  const aYards = a.totalYards ?? (a.passingYards ?? 0) + (a.rushingYards ?? 0);
  const h1st = h.firstDowns ?? 0;
  const a1st = a.firstDowns ?? 0;
  const hTo = h.turnovers ?? 0;
  const aTo = a.turnovers ?? 0;
  const h3rd = h.thirdDownPct ?? 40;
  const a3rd = a.thirdDownPct ?? 40;

  const yardEdge = hasBox
    ? (hYards - aYards) * 0.032 + (h1st - a1st) * 0.42 + (aTo - hTo) * 2.6 + (h3rd - a3rd) * 0.06
    : 0;

  const flow = computeRecencyFlowScore(snapshot.plays, p, 60, 0.1);
  const flowAdj =
    flow.count > 0
      ? ((flow.homeFlow - flow.awayFlow) / Math.max(1, flow.homeFlow + flow.awayFlow)) * 3.2
      : 0;

  const paceTotal = p > 0.12 ? currentTotal / p : priorTotal;
  const paceWeight = clamp(p * 0.9, 0, 0.72);
  const yardRateTotal = hasBox && p > 0.1 ? ((hYards + aYards) / p) * 0.068 : priorTotal;
  const projectedFullTotal =
    priorTotal * (1 - paceWeight) +
    (paceTotal * 0.6 + clamp(yardRateTotal, 24, 78) * 0.4) * paceWeight;

  const expectedRemainingMargin =
    (priorMargin * (1 - clamp(p * 0.55, 0, 0.55)) + yardEdge * 0.5 + flowAdj) * rem;
  const expectedRemainingTotal = Math.max(0, projectedFullTotal * rem);

  const expectedFinalMargin =
    snapshot.status === 'finished' ? currentMargin : currentMargin + expectedRemainingMargin;
  const expectedFinalTotal =
    snapshot.status === 'finished' ? currentTotal : currentTotal + expectedRemainingTotal;

  // Exact Gaussian sigma from specification
  const marginStd =
    snapshot.status === 'finished'
      ? 0.01
      : 13.8 * Math.sqrt(Math.max(0.01, 1 - p + 0.05));
  const totalStd =
    snapshot.status === 'finished'
      ? 0.01
      : 14.5 * Math.sqrt(Math.max(0.01, 1 - p + 0.05));

  const homeWin =
    snapshot.status === 'finished'
      ? currentMargin > 0
        ? 1
        : currentMargin < 0
          ? 0
          : 0.5
      : clamp(normalCdf(expectedFinalMargin / marginStd), 0.01, 0.99);

  const pred: PureFlowPrediction = {
    matchId: snapshot.id,
    sport: 'football',
    dataQuality: tier,
    progressPct: p,
    fairProbs: {
      homeWin,
      awayWin: 1 - homeWin,
    },
    expectedRemaining: {
      homeMean: Math.max(0, (expectedRemainingTotal + expectedRemainingMargin) / 2),
      awayMean: Math.max(0, (expectedRemainingTotal - expectedRemainingMargin) / 2),
      totalMean: expectedFinalTotal,
      spreadMean: expectedFinalMargin,
      spreadStd: marginStd,
      totalStd,
    },
    gaussianParams: {
      currentMargin,
      currentTotal,
      expectedFinalMargin,
      marginStd,
      expectedFinalTotal,
      totalStd,
    },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: buildMomentumSeries(snapshot.plays, p, Math.max(0.2, 0.5 + yardEdge * 0.02), Math.max(0.2, 0.5 - yardEdge * 0.02)),
    confidence: clamp(0.45 + 0.35 * p + (tier === 'play_by_play_boxscore' ? 0.2 : tier === 'live_boxscore' ? 0.1 : 0), 0.35, 0.96),
    modelNotes: [
      `Yards differential: ${hYards} vs ${aYards} | Turnovers: ${hTo} vs ${aTo}`,
      `Final margin μ=${expectedFinalMargin.toFixed(1)} (σ=${marginStd.toFixed(1)})`,
    ],
  };

  const baseTot = Math.round(expectedFinalTotal) + 0.5;
  const baseSpr = Math.round(-expectedFinalMargin) - 0.5;
  pred.standardLines.totalLines = [-7, -3, 0, 3, 7].map((d) => ({
    line: Math.max(20.5, baseTot + d),
    ...evaluateTotalLine(pred, Math.max(20.5, baseTot + d)),
  }));
  pred.standardLines.spreadLines = [-4, -1, 0, 1, 4].map((d) => ({
    line: baseSpr + d,
    ...evaluateSpreadLine(pred, baseSpr + d),
  }));

  return pred;
}

function predictHockey(snapshot: OddsFreeMatchSnapshot): PureFlowPrediction {
  const p = clamp(snapshot.progressPct, 0, 1);
  const rem = Math.max(0, 1 - p);
  const tier = inferDataQuality(snapshot);
  const { diffPrior } = getRecordAdvantage(snapshot.homeRecord, snapshot.awayRecord);

  const h = snapshot.homeStats;
  const a = snapshot.awayStats;

  // Base ~3.05 goals per 60m per team
  const priorHome60 = clamp(3.05 + diffPrior * 1.4, 1.8, 4.4);
  const priorAway60 = clamp(2.85 - diffPrior * 1.4, 1.7, 4.2);

  const elapsedMin = Math.max(1, p * 60);
  const shrinkage = elapsedMin / (elapsedMin + 24);
  const hasBox = hasLiveBoxscoreMetrics(h) || hasLiveBoxscoreMetrics(a);

  const hSog = h.shotsOnTarget ?? h.shots ?? 0;
  const aSog = a.shotsOnTarget ?? a.shots ?? 0;
  const hPp = h.powerPlayPct ?? 20;
  const aPp = a.powerPlayPct ?? 20;
  const hFo = h.faceoffPct ?? 50;
  const aFo = a.faceoffPct ?? 50;

  const liveHome60 =
    (hSog * 0.095 * (60 / elapsedMin)) * (0.9 + (hPp - 20) * 0.005 + (hFo - 50) * 0.004) + 0.4;
  const liveAway60 =
    (aSog * 0.095 * (60 / elapsedMin)) * (0.9 + (aPp - 20) * 0.005 + (aFo - 50) * 0.004) + 0.4;

  let blendedHome60 = hasBox
    ? priorHome60 * (1 - shrinkage) + clamp(liveHome60, 1.3, 5.2) * shrinkage
    : priorHome60;
  let blendedAway60 = hasBox
    ? priorAway60 * (1 - shrinkage) + clamp(liveAway60, 1.3, 5.2) * shrinkage
    : priorAway60;

  const flow = computeRecencyFlowScore(snapshot.plays, p, 60, 0.09);
  if (flow.count > 0) {
    const shareH = flow.homeFlow / Math.max(0.01, flow.homeFlow + flow.awayFlow);
    const tilt = (shareH - 0.5) * 0.35;
    blendedHome60 = clamp(blendedHome60 * (1 + tilt), 1.2, 5.4);
    blendedAway60 = clamp(blendedAway60 * (1 - tilt), 1.2, 5.4);
  }

  const homeLambdaRem = snapshot.status === 'finished' || rem <= 0 ? 0.0001 : blendedHome60 * rem;
  const awayLambdaRem = snapshot.status === 'finished' || rem <= 0 ? 0.0001 : blendedAway60 * rem;

  const reg =
    snapshot.status === 'finished'
      ? {
          homeWin: snapshot.homeScore > snapshot.awayScore ? 1 : 0,
          draw: snapshot.homeScore === snapshot.awayScore ? 1 : 0,
          awayWin: snapshot.homeScore < snapshot.awayScore ? 1 : 0,
        }
      : computePoissonMatrixOutcomes(
          snapshot.homeScore,
          snapshot.awayScore,
          homeLambdaRem,
          awayLambdaRem,
          10
        );

  // Flow-weighted OT/SO tie split for 2-Way NHL Moneyline
  const otHomeShare = clamp(
    blendedHome60 / Math.max(0.1, blendedHome60 + blendedAway60),
    0.35,
    0.65
  );
  const twoWayHome = clamp(reg.homeWin + reg.draw * otHomeShare, 0.01, 0.99);
  const twoWayAway = 1 - twoWayHome;

  const pred: PureFlowPrediction = {
    matchId: snapshot.id,
    sport: 'hockey',
    dataQuality: tier,
    progressPct: p,
    fairProbs: {
      homeWin: twoWayHome,
      awayWin: twoWayAway,
    },
    expectedRemaining: {
      homeMean: homeLambdaRem,
      awayMean: awayLambdaRem,
      totalMean: snapshot.homeScore + snapshot.awayScore + homeLambdaRem + awayLambdaRem,
      spreadMean: snapshot.homeScore - snapshot.awayScore + (homeLambdaRem - awayLambdaRem),
    },
    poissonLambdas: {
      homeLambda: homeLambdaRem,
      awayLambda: awayLambdaRem,
      currentHome: snapshot.homeScore,
      currentAway: snapshot.awayScore,
      otHomeShare,
    },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: buildMomentumSeries(snapshot.plays, p, blendedHome60, blendedAway60),
    confidence: clamp(0.45 + 0.35 * p + (tier === 'play_by_play_boxscore' ? 0.2 : tier === 'live_boxscore' ? 0.1 : 0), 0.35, 0.96),
    modelNotes: [
      `60m goal rates: ${blendedHome60.toFixed(2)} vs ${blendedAway60.toFixed(2)} (OT share ${(otHomeShare * 100).toFixed(1)}%)`,
      `Remaining Poisson λ: (${homeLambdaRem.toFixed(2)}, ${awayLambdaRem.toFixed(2)})`,
    ],
  };

  pred.standardLines.totalLines = [4.5, 5.5, 6.5, 7.5].map((line) => ({
    line,
    ...evaluateTotalLine(pred, line),
  }));
  pred.standardLines.spreadLines = [-1.5, -0.5, 0.5, 1.5].map((line) => ({
    line,
    ...evaluateSpreadLine(pred, line),
  }));

  return pred;
}

function predictBaseball(snapshot: OddsFreeMatchSnapshot): PureFlowPrediction {
  const p = clamp(snapshot.progressPct, 0, 1);
  const rem = Math.max(0, 1 - p);
  const tier = inferDataQuality(snapshot);
  const { diffPrior } = getRecordAdvantage(snapshot.homeRecord, snapshot.awayRecord);

  const h = snapshot.homeStats;
  const a = snapshot.awayStats;

  // Base MLB ~4.45 runs per 9 innings per team
  const priorHome9 = clamp(4.45 + diffPrior * 2.4, 2.5, 6.6);
  const priorAway9 = clamp(4.25 - diffPrior * 2.4, 2.4, 6.4);

  const elapsedInnings = Math.max(0.5, p * 9);
  const shrinkage = elapsedInnings / (elapsedInnings + 4.5);
  const hasBox = hasLiveBoxscoreMetrics(h) || hasLiveBoxscoreMetrics(a);

  const hHits = h.baseballHits ?? 0;
  const aHits = a.baseballHits ?? 0;
  const hAvg = h.battingAvg ?? 0.248;
  const aAvg = a.battingAvg ?? 0.248;
  const aEra = a.era ?? 4.1;
  const hEra = h.era ?? 4.1;

  const liveHome9 =
    (hHits * 0.52 * (9 / elapsedInnings)) * (0.8 + (hAvg - 0.248) * 1.4 + (aEra - 4.1) * 0.06) + 0.5;
  const liveAway9 =
    (aHits * 0.52 * (9 / elapsedInnings)) * (0.8 + (aAvg - 0.248) * 1.4 + (hEra - 4.1) * 0.06) + 0.5;

  let blendedHome9 = hasBox
    ? priorHome9 * (1 - shrinkage) + clamp(liveHome9, 1.8, 8.2) * shrinkage
    : priorHome9;
  let blendedAway9 = hasBox
    ? priorAway9 * (1 - shrinkage) + clamp(liveAway9, 1.8, 8.2) * shrinkage
    : priorAway9;

  const flow = computeRecencyFlowScore(snapshot.plays, p, 9, 0.35);
  if (flow.count > 0) {
    const shareH = flow.homeFlow / Math.max(0.01, flow.homeFlow + flow.awayFlow);
    const tilt = (shareH - 0.5) * 0.3;
    blendedHome9 = clamp(blendedHome9 * (1 + tilt), 1.6, 8.5);
    blendedAway9 = clamp(blendedAway9 * (1 - tilt), 1.6, 8.5);
  }

  const homeLambdaRem = snapshot.status === 'finished' || rem <= 0 ? 0.0001 : blendedHome9 * rem;
  const awayLambdaRem = snapshot.status === 'finished' || rem <= 0 ? 0.0001 : blendedAway9 * rem;

  const reg =
    snapshot.status === 'finished'
      ? {
          homeWin: snapshot.homeScore > snapshot.awayScore ? 1 : 0,
          draw: snapshot.homeScore === snapshot.awayScore ? 1 : 0,
          awayWin: snapshot.homeScore < snapshot.awayScore ? 1 : 0,
        }
      : computePoissonMatrixOutcomes(
          snapshot.homeScore,
          snapshot.awayScore,
          homeLambdaRem,
          awayLambdaRem,
          14
        );

  const extraShare = clamp(blendedHome9 / Math.max(0.1, blendedHome9 + blendedAway9) + 0.02, 0.4, 0.65);
  const twoWayHome = clamp(reg.homeWin + reg.draw * extraShare, 0.01, 0.99);

  const pred: PureFlowPrediction = {
    matchId: snapshot.id,
    sport: 'baseball',
    dataQuality: tier,
    progressPct: p,
    fairProbs: {
      homeWin: twoWayHome,
      awayWin: 1 - twoWayHome,
    },
    expectedRemaining: {
      homeMean: homeLambdaRem,
      awayMean: awayLambdaRem,
      totalMean: snapshot.homeScore + snapshot.awayScore + homeLambdaRem + awayLambdaRem,
      spreadMean: snapshot.homeScore - snapshot.awayScore + (homeLambdaRem - awayLambdaRem),
    },
    poissonLambdas: {
      homeLambda: homeLambdaRem,
      awayLambda: awayLambdaRem,
      currentHome: snapshot.homeScore,
      currentAway: snapshot.awayScore,
      extraInningHomeShare: extraShare,
    },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: buildMomentumSeries(snapshot.plays, p, blendedHome9, blendedAway9),
    confidence: clamp(0.45 + 0.35 * p + (tier === 'play_by_play_boxscore' ? 0.2 : tier === 'live_boxscore' ? 0.1 : 0), 0.35, 0.96),
    modelNotes: [
      `9-inning run projection: ${blendedHome9.toFixed(2)} vs ${blendedAway9.toFixed(2)}`,
      `Remaining Poisson λ: (${homeLambdaRem.toFixed(2)}, ${awayLambdaRem.toFixed(2)})`,
    ],
  };

  pred.standardLines.totalLines = [6.5, 7.5, 8.5, 9.5].map((line) => ({
    line,
    ...evaluateTotalLine(pred, line),
  }));
  pred.standardLines.spreadLines = [-1.5, 1.5].map((line) => ({
    line,
    ...evaluateSpreadLine(pred, line),
  }));

  return pred;
}

/**
 * Markov set/match probability solver for Tennis
 */
function solveTennisSetWinProb(
  gH: number,
  gA: number,
  pGameH: number,
  memo = new Map<string, number>()
): number {
  if ((gH >= 6 && gH - gA >= 2) || gH === 7) return 1;
  if ((gA >= 6 && gA - gH >= 2) || gA === 7) return 0;
  if (gH === 6 && gA === 6) {
    // Tiebreak probability skewed slightly by game-win strength
    const tbH = clamp(0.5 + (pGameH - 0.5) * 1.15, 0.15, 0.85);
    return tbH;
  }
  const key = `${gH}:${gA}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const val =
    pGameH * solveTennisSetWinProb(gH + 1, gA, pGameH, memo) +
    (1 - pGameH) * solveTennisSetWinProb(gH, gA + 1, pGameH, memo);
  memo.set(key, val);
  return val;
}

function solveTennisMatchWinProb(
  sH: number,
  sA: number,
  setsToWin: 2 | 3,
  pCurrentSetH: number,
  pFreshSetH: number
): number {
  const memo = new Map<string, number>();
  function dp(h: number, a: number, firstSet: boolean): number {
    if (h >= setsToWin) return 1;
    if (a >= setsToWin) return 0;
    const key = `${h}:${a}:${firstSet ? 1 : 0}`;
    const c = memo.get(key);
    if (c !== undefined) return c;
    const pSet = firstSet ? pCurrentSetH : pFreshSetH;
    const res = pSet * dp(h + 1, a, false) + (1 - pSet) * dp(h, a + 1, false);
    memo.set(key, res);
    return res;
  }
  return dp(sH, sA, true);
}

function predictTennis(snapshot: OddsFreeMatchSnapshot): PureFlowPrediction {
  const p = clamp(snapshot.progressPct, 0, 1);
  const tier = inferDataQuality(snapshot);
  const { diffPrior } = getRecordAdvantage(snapshot.homeRecord, snapshot.awayRecord);
  const setsToWin: 2 | 3 = snapshot.bestOfSets === 5 ? 3 : 2;

  const hSetsArr = snapshot.homeStats.linescores ?? [];
  const aSetsArr = snapshot.awayStats.linescores ?? [];

  let homeSetsWon = 0;
  let awaySetsWon = 0;
  let completedGamesHome = 0;
  let completedGamesAway = 0;

  const numCompletedOrActive = Math.max(hSetsArr.length, aSetsArr.length);
  let curH = 0;
  let curA = 0;

  for (let idx = 0; idx < numCompletedOrActive; idx++) {
    const gH = hSetsArr[idx] ?? 0;
    const gA = aSetsArr[idx] ?? 0;
    completedGamesHome += gH;
    completedGamesAway += gA;

    const isCompletedSet =
      (gH >= 6 && gH - gA >= 2) ||
      (gA >= 6 && gA - gH >= 2) ||
      gH === 7 ||
      gA === 7;

    if (isCompletedSet) {
      if (gH > gA) homeSetsWon++;
      else awaySetsWon++;
    } else if (idx === numCompletedOrActive - 1) {
      curH = gH;
      curA = gA;
    }
  }

  // Fallback to top-level score if linescores unavailable
  if (numCompletedOrActive === 0) {
    homeSetsWon = snapshot.homeScore;
    awaySetsWon = snapshot.awayScore;
  }

  const totalGamesPlayed = completedGamesHome + completedGamesAway;
  const gameWinRate =
    totalGamesPlayed > 0
      ? (completedGamesHome + 4 * (0.5 + diffPrior * 0.45)) / (totalGamesPlayed + 4)
      : 0.5 + diffPrior * 0.45;

  const flow = computeRecencyFlowScore(snapshot.plays, p, 100, 0.08);
  const flowTilt =
    flow.count > 0
      ? ((flow.homeFlow - flow.awayFlow) / Math.max(1, flow.homeFlow + flow.awayFlow)) * 0.08
      : 0;

  const pGameHome = clamp(gameWinRate + flowTilt, 0.25, 0.75);
  const pCurrentSetH = solveTennisSetWinProb(curH, curA, pGameHome);
  const pFreshSetH = solveTennisSetWinProb(0, 0, pGameHome);

  const pMatchHome =
    snapshot.status === 'finished'
      ? snapshot.homeScore > snapshot.awayScore
        ? 1
        : 0
      : clamp(
          solveTennisMatchWinProb(
            homeSetsWon,
            awaySetsWon,
            setsToWin,
            pCurrentSetH,
            pFreshSetH
          ),
          0.01,
          0.99
        );

  const expectedRemainingSets = Math.max(
    0,
    setsToWin * 2 - 0.65 - (homeSetsWon + awaySetsWon)
  );
  const avgGamesPerSet = 9.6;
  const expectedFinalTotalGames =
    snapshot.status === 'finished'
      ? Math.max(12, totalGamesPlayed)
      : totalGamesPlayed +
        Math.max(0, 9.6 - (curH + curA)) * 0.85 +
        Math.max(0, expectedRemainingSets - 1) * avgGamesPerSet;
  const currentGameMargin = completedGamesHome - completedGamesAway;
  const expectedFinalGameSpread =
    snapshot.status === 'finished'
      ? currentGameMargin
      : currentGameMargin + (pGameHome - 0.5) * 18 * Math.max(0, 1 - p);

  const totalGamesStd = snapshot.status === 'finished' ? 0.01 : 4.2 * Math.sqrt(Math.max(0.05, 1 - p + 0.05));
  const gameSpreadStd = snapshot.status === 'finished' ? 0.01 : 3.6 * Math.sqrt(Math.max(0.05, 1 - p + 0.05));

  const pred: PureFlowPrediction = {
    matchId: snapshot.id,
    sport: 'tennis',
    dataQuality: tier,
    progressPct: p,
    fairProbs: {
      homeWin: pMatchHome,
      awayWin: 1 - pMatchHome,
    },
    expectedRemaining: {
      homeMean: Math.max(0, expectedFinalTotalGames / 2 + expectedFinalGameSpread / 2 - completedGamesHome),
      awayMean: Math.max(0, expectedFinalTotalGames / 2 - expectedFinalGameSpread / 2 - completedGamesAway),
      totalMean: expectedFinalTotalGames,
      spreadMean: expectedFinalGameSpread,
      spreadStd: gameSpreadStd,
      totalStd: totalGamesStd,
    },
    gaussianParams: {
      currentMargin: currentGameMargin,
      currentTotal: totalGamesPlayed,
      expectedFinalMargin: expectedFinalGameSpread,
      marginStd: gameSpreadStd,
      expectedFinalTotal: expectedFinalTotalGames,
      totalStd: totalGamesStd,
    },
    tennisParams: {
      setsToWin,
      homeSets: homeSetsWon,
      awaySets: awaySetsWon,
      currentSetHomeGames: curH,
      currentSetAwayGames: curA,
      pMatchHome,
      expectedTotalGames: expectedFinalTotalGames,
      totalGamesStd,
      expectedGameSpread: expectedFinalGameSpread,
      gameSpreadStd,
    },
    standardLines: { totalLines: [], spreadLines: [] },
    momentumSeries: buildMomentumSeries(snapshot.plays, p, pGameHome, 1 - pGameHome),
    confidence: clamp(0.48 + 0.32 * p + (tier === 'play_by_play_boxscore' ? 0.18 : 0.1), 0.4, 0.96),
    modelNotes: [
      `Markov set win P(current)=${(pCurrentSetH * 100).toFixed(1)}%, P(game)=${(pGameHome * 100).toFixed(1)}%`,
      `Sets: ${homeSetsWon}-${awaySetsWon} (Current games ${curH}-${curA})`,
    ],
  };

  const baseG = Math.round(expectedFinalTotalGames) + 0.5;
  pred.standardLines.totalLines = [-2, 0, 2].map((d) => ({
    line: Math.max(14.5, baseG + d),
    ...evaluateTotalLine(pred, Math.max(14.5, baseG + d)),
  }));
  pred.standardLines.spreadLines = [-3.5, -1.5, 1.5, 3.5].map((line) => ({
    line,
    ...evaluateSpreadLine(pred, line),
  }));

  return pred;
}

/**
 * Stage 1 Entrypoint:
 * Always strips odds internally via stripOddsForFirewall so Stage 1 math
 * can never read bookmaker prices.
 */
export function predictPureFlow(
  match: ScrapedMatch | OddsFreeMatchSnapshot
): PureFlowPrediction {
  const snapshot = stripOddsForFirewall(match);
  switch (snapshot.sport) {
    case 'soccer':
      return predictSoccer(snapshot);
    case 'basketball':
      return predictBasketball(snapshot);
    case 'football':
      return predictFootball(snapshot);
    case 'hockey':
      return predictHockey(snapshot);
    case 'baseball':
      return predictBaseball(snapshot);
    case 'tennis':
      return predictTennis(snapshot);
  }
}
