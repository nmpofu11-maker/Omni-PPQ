export type SportType =
  | 'soccer'
  | 'basketball'
  | 'football'
  | 'hockey'
  | 'baseball'
  | 'tennis';

export type SportFilter = 'all' | SportType;

export type MatchStatus = 'live' | 'upcoming' | 'finished';

export type DataQualityTier =
  | 'play_by_play_boxscore'
  | 'live_boxscore'
  | 'record_prior';

export type PriceKind = 'live' | 'prematch' | 'closing' | 'unknown';

export interface OddsVerification {
  verified: boolean;
  isLiveVerified: boolean;
  reasons: string[];
  ageSec?: number;
}

export type MarketCategory =
  | 'Moneyline (2-Way)'
  | 'Point Spread'
  | 'Run Line'
  | 'Puck Line'
  | 'Over / Under Total'
  | 'Match Winner (1X2)'
  | 'Over / Under Goals'
  | 'Asian Handicap / Spread'
  | 'Double Chance';

export interface PlayEvent {
  id: string;
  clock: string;
  period: number;
  /** Fraction of regulation elapsed, derived only from a real source clock. */
  elapsedPct?: number;
  /** Absolute elapsed match minutes, derived only from a real source clock. */
  elapsedMinutes?: number;
  clockSource?: 'scoreboard_clock' | 'period_only' | 'unknown';
  team: 'home' | 'away' | 'neutral';
  type: string;
  text: string;
  weight: number;
  scoreValue?: number;
}

export interface TeamTelemetry {
  // Soccer
  shots?: number;
  shotsOnTarget?: number;
  corners?: number;
  possessionPct?: number;
  redCards?: number;
  yellowCards?: number;
  foulsCommitted?: number;
  // Basketball
  fieldGoalPct?: number;
  threePointPct?: number;
  freeThrowPct?: number;
  rebounds?: number;
  offensiveRebounds?: number;
  assists?: number;
  turnovers?: number;
  steals?: number;
  blocks?: number;
  fouls?: number;
  // American Football
  totalYards?: number;
  passingYards?: number;
  rushingYards?: number;
  firstDowns?: number;
  thirdDownPct?: number;
  timeOfPossessionSec?: number;
  sacks?: number;
  // Ice Hockey
  powerPlayPct?: number;
  powerPlayGoals?: number;
  powerPlayOpportunities?: number;
  faceoffPct?: number;
  hits?: number;
  blockedShots?: number;
  giveaways?: number;
  takeaways?: number;
  saves?: number;
  penaltyMinutes?: number;
  // Baseball
  baseballHits?: number;
  battingAvg?: number;
  era?: number;
  errors?: number;
  strikeoutsPitching?: number;
  walksAllowed?: number;
  onBasePct?: number;
  // Tennis
  aces?: number;
  doubleFaults?: number;
  firstServePct?: number;
  breakPointsWon?: number;
  breakPointsTotal?: number;
  // Linescores (sets in tennis, innings in baseball, quarters/periods)
  linescores?: number[];
  // Raw key-value pairs for display in inspector
  raw?: Record<string, string | number>;
}

export interface MarketOdds {
  moneylineHome?: number;
  moneylineDraw?: number;
  moneylineAway?: number;
  spreadLine?: number; // Home team spread (e.g. -5.5 means home favored by 5.5)
  spreadHomeOdds?: number;
  spreadAwayOdds?: number;
  totalLine?: number;
  overOdds?: number;
  underOdds?: number;
  provider?: string;
  /** Provenance of the prices above; required for any recommendation. */
  priceKind?: PriceKind;
  source?: string;
  capturedAt?: string;
  marketId?: string;
  verification?: OddsVerification;
  isLiveVerified: boolean;
  lastUpdated?: string;
}

/**
 * STAGE 1 FIREWALL INPUT:
 * Strictly excludes any bookmaker odds, implied probabilities, or market lines.
 */
export interface OddsFreeMatchSnapshot {
  id: string;
  sport: SportType;
  league: string;
  leagueName: string;
  sportPath: string;
  status: MatchStatus;
  startTime: string;
  clockLabel: string;
  period: number;
  progressPct: number; // [0, 1]
  regulationMinutes?: number;
  bestOfSets?: 3 | 5;
  homeTeam: string;
  awayTeam: string;
  homeAbbrev?: string;
  awayAbbrev?: string;
  homeScore: number;
  awayScore: number;
  homeRecord?: string;
  awayRecord?: string;
  homeStats: TeamTelemetry;
  awayStats: TeamTelemetry;
  plays: PlayEvent[];
  dataQuality: DataQualityTier;
  /** Baseball only: live base-out state, when the feed provides it. */
  baseState?: { outs: number; first: boolean; second: boolean; third: boolean; half: 'top' | 'bottom' };
  /** Optional pre-game team strength ratings (Elo-style, 1500 = average). */
  homeRating?: number;
  awayRating?: number;
  homeRatingGames?: number;
  awayRatingGames?: number;
  bbcVerifiedScore?: {
    homeScore: number;
    awayScore: number;
    clock?: string;
  };
}

export interface ScrapedMatch extends OddsFreeMatchSnapshot {
  odds?: MarketOdds;
  hasLiveOddsNode?: boolean;
}

export interface PureFlowPrediction {
  matchId: string;
  sport: SportType;
  dataQuality: DataQualityTier;
  modelVersion: string;
  parameterVersion: string;
  evidence: EvidenceSummary;
  progressPct: number;
  /**
   * Present only when a promoted calibration was applied: the raw model
   * probabilities BEFORE calibration. The learner must train on these, never on
   * `fairProbs`, or a promoted calibration would be re-fitted on top of itself.
   */
  uncalibratedFairProbs?: {
    homeWin: number;
    draw?: number;
    awayWin: number;
  };
  fairProbs: {
    homeWin: number;
    draw?: number;
    awayWin: number;
    nextGoalHome?: number;
    nextGoalAway?: number;
    dnbHome?: number;
    dnbAway?: number;
  };
  expectedRemaining: {
    homeMean: number;
    awayMean: number;
    totalMean: number;
    spreadMean: number;
    spreadStd?: number;
    totalStd?: number;
  };
  poissonLambdas?: {
    homeLambda: number;
    awayLambda: number;
    currentHome: number;
    currentAway: number;
    otHomeShare?: number; // For NHL overtime tie-break
    extraInningHomeShare?: number; // For MLB extra innings
  };
  gaussianParams?: {
    currentMargin: number; // home - away
    currentTotal: number;
    expectedFinalMargin: number; // home - away
    marginStd: number;
    expectedFinalTotal: number;
    totalStd: number;
  };
  tennisParams?: {
    setsToWin: 2 | 3;
    homeSets: number;
    awaySets: number;
    currentSetHomeGames: number;
    currentSetAwayGames: number;
    pMatchHome: number;
    expectedTotalGames: number;
    totalGamesStd: number;
    expectedGameSpread: number;
    gameSpreadStd: number;
  };
  standardLines: {
    totalLines: Array<{ line: number; overProb: number; underProb: number; pushProb: number }>;
    spreadLines: Array<{ line: number; homeCoverProb: number; awayCoverProb: number; pushProb: number }>;
  };
  momentumSeries: Array<{
    pct: number;
    label: string;
    homeMomentum: number;
    awayMomentum: number;
  }>;
  /** Extra expected goals awarded after regulation (OT, extra innings). */
  expectedAdditionalGoals?: number;
  confidence: number;
  modelNotes: string[];
}

export interface EvidenceSummary {
  tier: DataQualityTier;
  homeBox: 'complete' | 'partial' | 'none';
  awayBox: 'complete' | 'partial' | 'none';
  playsTimed: number;
  playsTotal: number;
  identityValid: boolean;
  notes: string[];
}

export interface ValueAlert {
  id: string;
  matchId: string;
  sport: SportType;
  sportPath: string;
  league: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  clockLabel: string;
  status: MatchStatus;
  marketCategory: MarketCategory;
  selection: string;
  side: 'home' | 'away' | 'draw' | 'over' | 'under' | 'home_draw' | 'away_draw';
  line?: number;
  fairProb: number;
  fairOdds: number;
  /** Probability the selection loses / pushes, used for EV and scoring. */
  lossProb: number;
  pushProb: number;
  bookmakerOdds: number;
  impliedProb: number;
  evPct: number;
  kellyQuarterStakePct: number;
  oddsVerifiedLive: boolean;
  oddsLabel: 'Verified Live' | 'Pre-Match / Closing';
  priceVerified: boolean;
  priceKind: PriceKind;
  priceSource?: string;
  priceCapturedAt?: string;
  provider?: string;
  dataQuality: DataQualityTier;
  progressPct: number;
  // Separated score components (never conflated into one opaque number).
  modelProbability: number;
  dataQualityScore: number;
  uncertaintyScore: number;
  calibrationScore: number;
  convictionScore: number;
  rankingScore: number;
}

export interface PaperBet {
  id: string;
  matchId: string;
  sport: SportType;
  sportPath: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  marketCategory: MarketCategory;
  selection: string;
  side: 'home' | 'away' | 'draw' | 'over' | 'under' | 'home_draw' | 'away_draw';
  line?: number;
  stakeAmount: number;
  bookmakerOdds: number;
  fairProbAtPlacement: number;
  evPctAtPlacement: number;
  convictionAtPlacement: number;
  oddsVerifiedLive: boolean;
  placedAt: string;
  status: 'pending' | 'won' | 'lost' | 'push';
  pnl: number;
  settledAt?: string;
  finalScore?: string;
}

export interface CalibrationMetrics {
  totalSettled: number;
  brierScore: number;
  logLoss: number;
  totalStaked: number;
  totalPnl: number;
  roiPct: number;
  winRatePct: number;
}

export interface LeagueInfo {
  slug: string;
  name: string;
  sport: SportType;
  sportPath: string;
  country?: string;
  priority?: number;
}

export interface MatchesApiResponse {
  timestamp: string;
  sportCounts: Record<SportFilter, number>;
  liveCounts: Record<SportFilter, number>;
  matches: ScrapedMatch[];
  predictions: Record<string, PureFlowPrediction>;
  alerts: ValueAlert[];
  bestBet: ValueAlert | null;
  verifiedLiveOnly: boolean;
}
