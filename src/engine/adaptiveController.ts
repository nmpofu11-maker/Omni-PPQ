import crypto from 'crypto';
import type { SportType } from '../types/quant';
import { computeResultChecksum, type LedgerRecord } from './ledger';
import { temperatureScaleBinary } from './mathUtils';
import { MODEL_VERSION, type ModelParameterOverrides } from './modelParams';

/**
 * Deterministic, auditable shadow-mode learning. Candidates are estimated from
 * verified settlements only, evaluated chronologically out-of-sample, and can
 * never touch production parameters without an explicit, guarded promotion.
 *
 * Statistical design (each point fixes a defect found in the first version):
 *  - Trainer and server share ONE transform (`temperatureScaleBinary`), so a
 *    gamma learned here means exactly what it means when served.
 *  - Training data are unconditional model-only snapshots, never the
 *    edge-filtered alerts (selection bias / winner's curse).
 *  - Folds split by MATCH, so two snapshots of the same match can never sit on
 *    both sides of a train/holdout boundary.
 *  - All reported scores (Brier AND log loss) are out-of-sample.
 *  - Promotion requires a match-clustered significance test per sport, so a
 *    calibrated model is not "improved" by noise.
 */

export const GAMMA_GRID: readonly number[] = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3];

const CALIBRATED_MARKETS = new Set<string>(['Moneyline (2-Way)', 'Match Winner (1X2)']);

export interface AdaptiveSample {
  key: string;
  predictionId: string;
  /** Cluster identity. Samples sharing a matchId are never split across folds. */
  matchId?: string;
  sport: SportType;
  marketCategory: string;
  /** RAW model probability of the selection (before any promoted calibration). */
  fairProb: number;
  /** Probability the selection loses. Defaults to 1 - fairProb - pushProb. */
  lossProb?: number;
  pushProb?: number;
  progressPct?: number;
  outcome: 0 | 1;
  settledAt: string;
}

export interface ExtractOptions {
  /**
   * Include edge-filtered (priced) alerts. Off by default: they are a
   * selection-biased sample and must not drive calibration.
   */
  includePriced?: boolean;
}

export function extractVerifiedSamples(
  records: LedgerRecord[],
  options: ExtractOptions = {}
): {
  samples: AdaptiveSample[];
  skipped: number;
  excludedPriced: number;
} {
  const predictions = new Map(
    records
      .filter((r) => r.type === 'prediction')
      .map((r) => [r.payload.predictionId, r.payload] as const)
  );
  const samples: AdaptiveSample[] = [];
  let skipped = 0;
  let excludedPriced = 0;

  for (const record of records) {
    if (record.type !== 'settlement') continue;
    const settlement = record.payload;
    if (settlement.status !== 'won' && settlement.status !== 'lost') {
      skipped++;
      continue;
    }
    const prediction = predictions.get(settlement.predictionId);
    if (!prediction) {
      skipped++;
      continue;
    }
    const expected = computeResultChecksum(
      settlement.predictionId,
      settlement.homeScore,
      settlement.awayScore
    );
    if (settlement.resultChecksum !== expected) {
      skipped++;
      continue;
    }
    const kind = prediction.snapshotKind ?? 'priced';
    if (kind !== 'model_only' && !options.includePriced) {
      excludedPriced++;
      continue;
    }
    if (!CALIBRATED_MARKETS.has(prediction.marketCategory)) {
      skipped++;
      continue;
    }
    samples.push({
      key: `${settlement.predictionId}|${settlement.resultChecksum}`,
      predictionId: settlement.predictionId,
      matchId: prediction.matchId,
      sport: prediction.sport,
      marketCategory: prediction.marketCategory,
      fairProb: Math.min(0.999, Math.max(0.001, prediction.probabilities.fairProb)),
      lossProb: prediction.probabilities.lossProb,
      pushProb: prediction.probabilities.pushProb,
      progressPct: (prediction.featureSnapshot as { progressPct?: number } | undefined)?.progressPct,
      outcome: settlement.status === 'won' ? 1 : 0,
      settledAt: settlement.settledAt,
    });
  }

  samples.sort((a, b) =>
    a.settledAt === b.settledAt ? a.key.localeCompare(b.key) : a.settledAt.localeCompare(b.settledAt)
  );
  return { samples, skipped, excludedPriced };
}

/** P(win | not a push): the quantity a binary calibration acts on. */
function conditionalWinProb(s: AdaptiveSample): number {
  const push = s.pushProb ?? 0;
  const loss = s.lossProb ?? Math.max(0, 1 - s.fairProb - push);
  const denom = s.fairProb + loss;
  return denom > 0 ? s.fairProb / denom : 0.5;
}

/** The calibrated probability for a sample under `gamma`, exactly as served. */
export function calibratedSampleProb(s: AdaptiveSample, gamma: number): number {
  return Math.min(0.999, Math.max(0.001, temperatureScaleBinary(conditionalWinProb(s), gamma)));
}

function sqErr(s: AdaptiveSample, gamma: number): number {
  return Math.pow(calibratedSampleProb(s, gamma) - s.outcome, 2);
}

function logErr(s: AdaptiveSample, gamma: number): number {
  const p = calibratedSampleProb(s, gamma);
  return -(s.outcome * Math.log(p) + (1 - s.outcome) * Math.log(1 - p));
}

function meanOf(samples: AdaptiveSample[], f: (s: AdaptiveSample) => number): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += f(s);
  return sum / samples.length;
}

function pickGamma(samples: AdaptiveSample[]): number {
  let best = 1;
  let bestBrier = Infinity;
  for (const gamma of GAMMA_GRID) {
    const score = meanOf(samples, (s) => sqErr(s, gamma));
    if (
      score < bestBrier - 1e-12 ||
      (Math.abs(score - bestBrier) <= 1e-12 && Math.abs(gamma - 1) < Math.abs(best - 1))
    ) {
      best = gamma;
      bestBrier = score;
    }
  }
  return best;
}

export interface AcceptanceCriteria {
  /** Minimum samples PER SPORT before that sport is evaluated at all. */
  minTotalSamples: number;
  /** Minimum out-of-sample samples PER SPORT. */
  minHoldoutSamples: number;
  minBrierImprovement: number;
  maxLogLossRegression: number;
  maxFoldBrierRegression: number;
  folds: number;
  /** Minimum distinct matches per sport (clusters). Default 150. */
  minMatches?: number;
  /** One-sided z threshold for the match-clustered Brier improvement. Default 2. */
  minZ?: number;
}

export const DEFAULT_ACCEPTANCE_CRITERIA: AcceptanceCriteria = {
  minTotalSamples: 300,
  minHoldoutSamples: 100,
  minBrierImprovement: 0.001,
  maxLogLossRegression: 0.005,
  maxFoldBrierRegression: 0.02,
  folds: 4,
  minMatches: 150,
  minZ: 2,
};

export interface FoldEvaluation {
  sport: SportType;
  gamma: number;
  holdoutSamples: number;
  baselineBrier: number;
  candidateBrier: number;
}

export interface SportReport {
  sport: SportType;
  samples: number;
  matches: number;
  holdoutSamples: number;
  holdoutMatches: number;
  selectedGamma: number;
  /** Mean out-of-sample Brier improvement (baseline - candidate). */
  brierImprovement: number;
  /** Match-clustered standard error of that improvement. */
  standardError: number;
  zScore: number;
  logLossRegression: number;
  passes: boolean;
  reasons: string[];
}

export interface AdaptiveCandidate {
  candidateId: string;
  createdAt: string;
  trainedThrough: string;
  fingerprint: string;
  perSportGammas: Partial<Record<SportType, number>>;
  holdoutSamples: number;
  baselineBrier: number;
  candidateBrier: number;
  baselineLogLoss: number;
  candidateLogLoss: number;
  folds: FoldEvaluation[];
  sportReports?: SportReport[];
  accepted: boolean;
  rejectionReasons: string[];
  status: 'eligible' | 'rejected';
  parameterVersion: string;
}

function fingerprintOf(samples: AdaptiveSample[]): string {
  return crypto
    .createHash('sha256')
    .update(samples.map((s) => s.key).sort().join('|'))
    .digest('hex');
}

interface Cluster {
  id: string;
  at: string;
  samples: AdaptiveSample[];
}

/** Groups snapshots by match; ordered by when the match was last settled. */
export function groupClusters(samples: AdaptiveSample[]): Cluster[] {
  const byId = new Map<string, Cluster>();
  for (const s of samples) {
    const id = s.matchId ?? s.key;
    const existing = byId.get(id);
    if (existing) {
      existing.samples.push(s);
      if (s.settledAt > existing.at) existing.at = s.settledAt;
    } else {
      byId.set(id, { id, at: s.settledAt, samples: [s] });
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)
  );
}

/**
 * Ratio-estimator mean and cluster-robust standard error. Snapshots of one
 * match are strongly dependent, so the unit of independence is the match.
 */
export function clusteredMean(
  items: Array<{ cluster: string; d: number }>
): { mean: number; se: number; z: number; clusters: number } {
  const n = items.length;
  if (n === 0) return { mean: 0, se: 0, z: 0, clusters: 0 };
  let total = 0;
  for (const it of items) total += it.d;
  const mean = total / n;
  const byCluster = new Map<string, number>();
  for (const it of items) {
    byCluster.set(it.cluster, (byCluster.get(it.cluster) ?? 0) + (it.d - mean));
  }
  const c = byCluster.size;
  if (c < 2) return { mean, se: 0, z: 0, clusters: c };
  let ss = 0;
  for (const r of byCluster.values()) ss += r * r;
  const variance = (c / (c - 1)) * (ss / (n * n));
  const se = Math.sqrt(Math.max(0, variance));
  const z = se > 1e-12 ? mean / se : mean > 1e-12 ? 99 : 0;
  return { mean, se, z, clusters: c };
}

interface SportEvaluation {
  report: SportReport;
  folds: FoldEvaluation[];
  baseBrierSum: number;
  candBrierSum: number;
  baseLogSum: number;
  candLogSum: number;
  holdout: number;
}

function evaluateSport(
  sport: SportType,
  sportSamples: AdaptiveSample[],
  c: Required<AcceptanceCriteria>
): SportEvaluation {
  const clusters = groupClusters(sportSamples);
  const reasons: string[] = [];
  const emptyReport = (): SportReport => ({
    sport,
    samples: sportSamples.length,
    matches: clusters.length,
    holdoutSamples: 0,
    holdoutMatches: 0,
    selectedGamma: 1,
    brierImprovement: 0,
    standardError: 0,
    zScore: 0,
    logLossRegression: 0,
    passes: false,
    reasons,
  });
  const none = (): SportEvaluation => ({
    report: emptyReport(),
    folds: [],
    baseBrierSum: 0,
    candBrierSum: 0,
    baseLogSum: 0,
    candLogSum: 0,
    holdout: 0,
  });

  if (sportSamples.length < c.minTotalSamples) {
    reasons.push(
      `insufficient chronological samples for ${sport}: ${sportSamples.length} < ${c.minTotalSamples}`
    );
  }
  if (clusters.length < c.minMatches) {
    reasons.push(`insufficient distinct matches for ${sport}: ${clusters.length} < ${c.minMatches}`);
  }
  if (reasons.length > 0) return none();

  const foldCount = Math.max(2, c.folds);
  const folds: FoldEvaluation[] = [];
  const diffs: Array<{ cluster: string; d: number }> = [];
  let baseBrierSum = 0;
  let candBrierSum = 0;
  let baseLogSum = 0;
  let candLogSum = 0;
  let holdout = 0;
  let holdoutMatches = 0;
  let worstFold = -Infinity;

  for (let i = 1; i < foldCount; i++) {
    const start = Math.floor((clusters.length * i) / foldCount);
    const end = Math.floor((clusters.length * (i + 1)) / foldCount);
    const train = clusters.slice(0, start).flatMap((cl) => cl.samples);
    const holdClusters = clusters.slice(start, end);
    const hold = holdClusters.flatMap((cl) => cl.samples);
    if (train.length === 0 || hold.length === 0) continue;

    const gamma = pickGamma(train);
    let fb = 0;
    let fc = 0;
    for (const cl of holdClusters) {
      for (const s of cl.samples) {
        const b = sqErr(s, 1);
        const k = sqErr(s, gamma);
        fb += b;
        fc += k;
        baseLogSum += logErr(s, 1);
        candLogSum += logErr(s, gamma);
        diffs.push({ cluster: cl.id, d: b - k });
      }
    }
    baseBrierSum += fb;
    candBrierSum += fc;
    holdout += hold.length;
    holdoutMatches += holdClusters.length;
    const foldBase = fb / hold.length;
    const foldCand = fc / hold.length;
    worstFold = Math.max(worstFold, foldCand - foldBase);
    folds.push({
      sport,
      gamma,
      holdoutSamples: hold.length,
      baselineBrier: foldBase,
      candidateBrier: foldCand,
    });
  }

  if (holdout === 0) {
    reasons.push(`no usable walk-forward folds for ${sport}`);
    return none();
  }

  const stat = clusteredMean(diffs);
  const selectedGamma = pickGamma(sportSamples);
  const logRegression = (candLogSum - baseLogSum) / holdout;
  const agreeing = folds.filter((f) => (f.gamma - 1) * (selectedGamma - 1) > 0).length;

  if (Math.abs(selectedGamma - 1) < 1e-9) {
    reasons.push(`no non-identity calibration candidate for ${sport}`);
  }
  if (holdout < c.minHoldoutSamples) {
    reasons.push(`holdout samples ${holdout} below minimum ${c.minHoldoutSamples} for ${sport}`);
  }
  if (stat.mean < c.minBrierImprovement) {
    reasons.push(
      `out-of-sample Brier improvement ${stat.mean.toFixed(4)} below ${c.minBrierImprovement} for ${sport}`
    );
  }
  if (stat.z < c.minZ) {
    reasons.push(
      `improvement not significant for ${sport}: match-clustered z=${stat.z.toFixed(2)} < ${c.minZ}`
    );
  }
  if (logRegression > c.maxLogLossRegression + 1e-12) {
    reasons.push(
      `out-of-sample log-loss regression ${logRegression.toFixed(4)} exceeds ${c.maxLogLossRegression} for ${sport}`
    );
  }
  if (worstFold > c.maxFoldBrierRegression + 1e-12) {
    reasons.push(
      `fold regression for ${sport}: ${worstFold.toFixed(4)} exceeds ${c.maxFoldBrierRegression}`
    );
  }
  if (folds.length > 0 && agreeing / folds.length < 0.5) {
    reasons.push(`unstable calibration direction across folds for ${sport}`);
  }

  return {
    report: {
      sport,
      samples: sportSamples.length,
      matches: clusters.length,
      holdoutSamples: holdout,
      holdoutMatches,
      selectedGamma,
      brierImprovement: stat.mean,
      standardError: stat.se,
      zScore: stat.z,
      logLossRegression: logRegression,
      passes: reasons.length === 0,
      reasons,
    },
    folds,
    baseBrierSum,
    candBrierSum,
    baseLogSum,
    candLogSum,
    holdout,
  };
}

/**
 * Expanding-window walk-forward over MATCHES: every fold's gamma is chosen on
 * matches strictly earlier than its holdout, so no future outcome informs an
 * earlier decision and no match straddles the boundary. Each sport is judged
 * and promoted independently; a sport that fails never rides along with one
 * that passes.
 */
export function evaluateAdaptiveCandidate(
  samples: AdaptiveSample[],
  criteria: AcceptanceCriteria = DEFAULT_ACCEPTANCE_CRITERIA,
  nowIso = new Date().toISOString()
): AdaptiveCandidate {
  const c: Required<AcceptanceCriteria> = {
    minMatches: DEFAULT_ACCEPTANCE_CRITERIA.minMatches as number,
    minZ: DEFAULT_ACCEPTANCE_CRITERIA.minZ as number,
    ...criteria,
  };
  const sorted = [...samples].sort((a, b) =>
    a.settledAt === b.settledAt ? a.key.localeCompare(b.key) : a.settledAt.localeCompare(b.settledAt)
  );
  const bySport = new Map<SportType, AdaptiveSample[]>();
  for (const s of sorted) {
    const list = bySport.get(s.sport) ?? [];
    list.push(s);
    bySport.set(s.sport, list);
  }

  const perSportGammas: Partial<Record<SportType, number>> = {};
  const folds: FoldEvaluation[] = [];
  const sportReports: SportReport[] = [];
  const rejectionReasons: string[] = [];
  let holdoutSamples = 0;
  let baseBrierSum = 0;
  let candBrierSum = 0;
  let baseLogSum = 0;
  let candLogSum = 0;

  for (const sport of [...bySport.keys()].sort()) {
    const ev = evaluateSport(sport, bySport.get(sport) as AdaptiveSample[], c);
    sportReports.push(ev.report);
    folds.push(...ev.folds);
    holdoutSamples += ev.holdout;
    baseBrierSum += ev.baseBrierSum;
    candBrierSum += ev.candBrierSum;
    baseLogSum += ev.baseLogSum;
    candLogSum += ev.candLogSum;
    if (ev.report.passes) {
      perSportGammas[sport] = ev.report.selectedGamma;
    } else {
      rejectionReasons.push(...ev.report.reasons);
    }
  }

  const accepted = Object.keys(perSportGammas).length > 0;
  if (!accepted && rejectionReasons.length === 0) {
    rejectionReasons.push('no sport produced a non-identity calibration candidate');
  }

  const fingerprint = fingerprintOf(sorted);
  const gammaSignature = Object.keys(perSportGammas)
    .sort()
    .map((k) => `${k}:${perSportGammas[k as SportType]}`)
    .join(',');
  const parameterVersion = `shadow-cal-${gammaSignature || 'none'}-${fingerprint.slice(0, 8)}`;
  const candidateId = crypto
    .createHash('sha256')
    .update(`${parameterVersion}|${fingerprint}`)
    .digest('hex')
    .slice(0, 16);

  return {
    candidateId,
    createdAt: nowIso,
    trainedThrough: sorted.length > 0 ? sorted[sorted.length - 1].settledAt : nowIso,
    fingerprint,
    perSportGammas,
    holdoutSamples,
    baselineBrier: holdoutSamples ? baseBrierSum / holdoutSamples : 0,
    candidateBrier: holdoutSamples ? candBrierSum / holdoutSamples : 0,
    baselineLogLoss: holdoutSamples ? baseLogSum / holdoutSamples : 0,
    candidateLogLoss: holdoutSamples ? candLogSum / holdoutSamples : 0,
    folds,
    sportReports,
    accepted,
    rejectionReasons,
    status: accepted ? 'eligible' : 'rejected',
    parameterVersion,
  };
}

export interface AdaptiveProduction {
  parameterVersion: string;
  modelVersion: string;
  calibration: Partial<Record<SportType, { gamma: number }>>;
  activatedAt?: string;
  activatedBy?: string;
}

export interface AdaptiveState {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  processedSampleKeys: string[];
  candidates: AdaptiveCandidate[];
  production: AdaptiveProduction;
  productionHistory: AdaptiveProduction[];
  history: Array<{ at: string; action: 'learn' | 'promote' | 'rollback'; detail: string }>;
}

export const DEFAULT_PRODUCTION_VERSION = '2026.11-default-v1';

export function createAdaptiveState(nowIso = new Date().toISOString()): AdaptiveState {
  return {
    schemaVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    processedSampleKeys: [],
    candidates: [],
    production: {
      parameterVersion: DEFAULT_PRODUCTION_VERSION,
      modelVersion: MODEL_VERSION,
      calibration: {},
    },
    productionHistory: [],
    history: [],
  };
}

export interface LearnResult {
  state: AdaptiveState;
  changed: boolean;
  candidate?: AdaptiveCandidate;
  reason?: string;
}

export function learnInShadow(
  state: AdaptiveState,
  records: LedgerRecord[],
  options: { criteria?: AcceptanceCriteria; now?: string } = {}
): LearnResult {
  const now = options.now ?? new Date().toISOString();
  const { samples, excludedPriced } = extractVerifiedSamples(records);
  const processed = new Set(state.processedSampleKeys);
  const fresh = samples.filter((s) => !processed.has(s.key));

  if (fresh.length === 0) {
    return {
      state,
      changed: false,
      reason:
        samples.length === 0 && excludedPriced > 0
          ? 'only selection-biased priced predictions are settled; no unbiased model-only snapshots to learn from'
          : 'no new verified settlements',
    };
  }

  const candidate = evaluateAdaptiveCandidate(
    samples,
    options.criteria ?? DEFAULT_ACCEPTANCE_CRITERIA,
    now
  );
  const duplicate = state.candidates.find((c) => c.candidateId === candidate.candidateId);
  const processedKeys = [...new Set([...state.processedSampleKeys, ...samples.map((s) => s.key)])].sort();

  const nextState: AdaptiveState = {
    ...state,
    updatedAt: now,
    processedSampleKeys: processedKeys,
    candidates: duplicate ? state.candidates : [...state.candidates, candidate],
    history: [
      ...state.history,
      {
        at: now,
        action: 'learn',
        detail: duplicate
          ? `duplicate candidate ${candidate.candidateId} ignored`
          : `candidate ${candidate.candidateId} ${candidate.status}`,
      },
    ],
  };

  return {
    state: nextState,
    changed: true,
    candidate: duplicate ?? candidate,
    reason: duplicate ? 'candidate already evaluated' : undefined,
  };
}

export interface PromoteOptions {
  enabled: boolean;
  actor: string;
  now?: string;
}

export type AdaptiveGuardCode =
  | 'promotion-disabled'
  | 'unknown-candidate'
  | 'ineligible-candidate'
  | 'nothing-to-roll-back';

export class AdaptiveGuardError extends Error {
  constructor(readonly code: AdaptiveGuardCode, message: string) {
    super(message);
    this.name = 'AdaptiveGuardError';
  }
}

export function promoteCandidate(
  state: AdaptiveState,
  candidateId: string,
  options: PromoteOptions
): { state: AdaptiveState; production: AdaptiveProduction } {
  if (!options.enabled) {
    throw new AdaptiveGuardError(
      'promotion-disabled',
      'Adaptive promotion is disabled; set ADAPTIVE_PROMOTION_ENABLED=true for an explicit operator promotion'
    );
  }
  const candidate = state.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    throw new AdaptiveGuardError('unknown-candidate', 'Unknown adaptive candidate');
  }
  if (!candidate.accepted || candidate.status !== 'eligible') {
    throw new AdaptiveGuardError(
      'ineligible-candidate',
      'Candidate has not passed out-of-sample acceptance criteria'
    );
  }
  const now = options.now ?? new Date().toISOString();
  const calibration: Partial<Record<SportType, { gamma: number }>> = {};
  for (const [sport, gamma] of Object.entries(candidate.perSportGammas)) {
    calibration[sport as SportType] = { gamma: gamma as number };
  }
  const production: AdaptiveProduction = {
    parameterVersion: candidate.parameterVersion,
    modelVersion: MODEL_VERSION,
    calibration,
    activatedAt: now,
    activatedBy: options.actor,
  };
  return {
    state: {
      ...state,
      updatedAt: now,
      production,
      productionHistory: [...state.productionHistory, state.production],
      history: [
        ...state.history,
        { at: now, action: 'promote', detail: `${candidateId} promoted by ${options.actor}` },
      ],
    },
    production,
  };
}

export function rollbackProduction(
  state: AdaptiveState,
  options: { actor: string; now?: string }
): { state: AdaptiveState; production: AdaptiveProduction } {
  if (state.productionHistory.length === 0) {
    throw new AdaptiveGuardError(
      'nothing-to-roll-back',
      'No previous production parameters to roll back to'
    );
  }
  const now = options.now ?? new Date().toISOString();
  const previous = state.productionHistory[state.productionHistory.length - 1];
  return {
    state: {
      ...state,
      updatedAt: now,
      production: previous,
      productionHistory: state.productionHistory.slice(0, -1),
      history: [
        ...state.history,
        { at: now, action: 'rollback', detail: `${options.actor} restored ${previous.parameterVersion}` },
      ],
    },
    production: previous,
  };
}

/**
 * Only a promoted production version may feed the engines; the default yields
 * an empty override so shipped behaviour is unchanged.
 */
export function productionModelOverrides(state: AdaptiveState): ModelParameterOverrides {
  const calibration = state.production.calibration;
  return Object.keys(calibration).length > 0 ? { calibration: { perSport: calibration } } : {};
}
