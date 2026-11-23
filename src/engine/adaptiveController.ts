import crypto from 'crypto';
import type { SportType } from '../types/quant';
import { computeResultChecksum, type LedgerRecord } from './ledger';
import { MODEL_VERSION, type ModelParameterOverrides } from './modelParams';

/**
 * Deterministic, auditable shadow-mode learning. Candidates are estimated from
 * verified settlements only, evaluated chronologically out-of-sample, and can
 * never touch production parameters without an explicit, guarded promotion.
 */

export const GAMMA_GRID: readonly number[] = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3];

export interface AdaptiveSample {
  key: string;
  predictionId: string;
  sport: SportType;
  marketCategory: string;
  fairProb: number;
  outcome: 0 | 1;
  settledAt: string;
}

export function extractVerifiedSamples(records: LedgerRecord[]): {
  samples: AdaptiveSample[];
  skipped: number;
} {
  const predictions = new Map(
    records
      .filter((r) => r.type === 'prediction')
      .map((r) => [r.payload.predictionId, r.payload] as const)
  );
  const samples: AdaptiveSample[] = [];
  let skipped = 0;

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
    samples.push({
      key: `${settlement.predictionId}|${settlement.resultChecksum}`,
      predictionId: settlement.predictionId,
      sport: prediction.sport,
      marketCategory: prediction.marketCategory,
      fairProb: Math.min(0.999, Math.max(0.001, prediction.probabilities.fairProb)),
      outcome: settlement.status === 'won' ? 1 : 0,
      settledAt: settlement.settledAt,
    });
  }

  samples.sort((a, b) =>
    a.settledAt === b.settledAt ? a.key.localeCompare(b.key) : a.settledAt.localeCompare(b.settledAt)
  );
  return { samples, skipped };
}

function calibratedProb(p: number, gamma: number): number {
  return Math.min(0.999, Math.max(0.001, Math.pow(p, gamma)));
}

function brierScore(samples: AdaptiveSample[], gamma: number): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += Math.pow(calibratedProb(s.fairProb, gamma) - s.outcome, 2);
  return sum / samples.length;
}

function logLoss(samples: AdaptiveSample[], gamma: number): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const p = calibratedProb(s.fairProb, gamma);
    sum += -(s.outcome * Math.log(p) + (1 - s.outcome) * Math.log(1 - p));
  }
  return sum / samples.length;
}

function pickGamma(samples: AdaptiveSample[]): number {
  let best = 1;
  let bestBrier = Infinity;
  for (const gamma of GAMMA_GRID) {
    const score = brierScore(samples, gamma);
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
  minTotalSamples: number;
  minHoldoutSamples: number;
  minBrierImprovement: number;
  maxLogLossRegression: number;
  maxFoldBrierRegression: number;
  folds: number;
}

export const DEFAULT_ACCEPTANCE_CRITERIA: AcceptanceCriteria = {
  minTotalSamples: 30,
  minHoldoutSamples: 10,
  minBrierImprovement: 0.001,
  maxLogLossRegression: 0.005,
  maxFoldBrierRegression: 0.02,
  folds: 4,
};

export interface FoldEvaluation {
  sport: SportType;
  gamma: number;
  holdoutSamples: number;
  baselineBrier: number;
  candidateBrier: number;
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

/**
 * Expanding-window walk-forward: every fold's gamma is chosen on data strictly
 * earlier than its holdout, so no future outcome informs an earlier decision.
 */
export function evaluateAdaptiveCandidate(
  samples: AdaptiveSample[],
  criteria: AcceptanceCriteria = DEFAULT_ACCEPTANCE_CRITERIA,
  nowIso = new Date().toISOString()
): AdaptiveCandidate {
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
  const rejectionReasons: string[] = [];
  let holdoutSamples = 0;

  for (const [sport, sportSamples] of bySport) {
    if (sportSamples.length < criteria.minTotalSamples) {
      rejectionReasons.push(`insufficient chronological samples for ${sport}`);
      continue;
    }
    const foldCount = Math.max(2, criteria.folds);
    const foldGammaCounts = new Map<number, number>();
    let sportHoldoutBrier = 0;
    let sportBaselineBrier = 0;
    let sportHoldout = 0;

    for (let i = 1; i < foldCount; i++) {
      const start = Math.floor((sportSamples.length * i) / foldCount);
      const end = Math.floor((sportSamples.length * (i + 1)) / foldCount);
      const train = sportSamples.slice(0, start);
      const holdout = sportSamples.slice(start, end);
      if (train.length === 0 || holdout.length === 0) continue;

      const gamma = pickGamma(train);
      const base = brierScore(holdout, 1);
      const candidate = brierScore(holdout, gamma);
      folds.push({
        sport,
        gamma,
        holdoutSamples: holdout.length,
        baselineBrier: base,
        candidateBrier: candidate,
      });
      foldGammaCounts.set(gamma, (foldGammaCounts.get(gamma) ?? 0) + 1);
      if (candidate - base > criteria.maxFoldBrierRegression + 1e-12) {
        rejectionReasons.push(
          `fold regression for ${sport}: ${(candidate - base).toFixed(4)} exceeds ${criteria.maxFoldBrierRegression}`
        );
      }
      sportHoldoutBrier += candidate * holdout.length;
      sportBaselineBrier += base * holdout.length;
      sportHoldout += holdout.length;
    }

    if (sportHoldout === 0) {
      rejectionReasons.push(`no usable walk-forward folds for ${sport}`);
      continue;
    }
    holdoutSamples += sportHoldout;

    let selected = 1;
    let bestCount = -1;
    for (const gamma of GAMMA_GRID) {
      const count = foldGammaCounts.get(gamma) ?? 0;
      if (
        count > bestCount ||
        (count === bestCount && Math.abs(gamma - 1) < Math.abs(selected - 1))
      ) {
        selected = gamma;
        bestCount = count;
      }
    }
    if (Math.abs(selected - 1) > 1e-9) {
      perSportGammas[sport] = selected;
    }
  }

  const pooledBase = folds.length
    ? folds.reduce((acc, f) => acc + f.baselineBrier * f.holdoutSamples, 0) /
      folds.reduce((acc, f) => acc + f.holdoutSamples, 0)
    : 0;
  const pooledCandidate = folds.length
    ? folds.reduce((acc, f) => acc + f.candidateBrier * f.holdoutSamples, 0) /
      folds.reduce((acc, f) => acc + f.holdoutSamples, 0)
    : 0;
  const baseLogLoss = folds.length
    ? sorted.reduce((acc, s) => acc + logLoss([s], 1), 0) / sorted.length
    : 0;
  const candidateLogLoss = folds.length
    ? sorted.reduce((acc, s) => {
        const gamma = perSportGammas[s.sport] ?? 1;
        return acc + logLoss([s], gamma);
      }, 0) / sorted.length
    : 0;

  if (Object.keys(perSportGammas).length === 0) {
    rejectionReasons.push('no sport produced a non-identity calibration candidate');
  }
  if (holdoutSamples < criteria.minHoldoutSamples) {
    rejectionReasons.push(
      `holdout samples ${holdoutSamples} below minimum ${criteria.minHoldoutSamples}`
    );
  }
  if (pooledBase - pooledCandidate < criteria.minBrierImprovement) {
    rejectionReasons.push(
      `out-of-sample Brier improvement ${(pooledBase - pooledCandidate).toFixed(4)} below ${criteria.minBrierImprovement}`
    );
  }
  if (candidateLogLoss - baseLogLoss > criteria.maxLogLossRegression + 1e-12) {
    rejectionReasons.push(
      `log-loss regression ${(candidateLogLoss - baseLogLoss).toFixed(4)} exceeds ${criteria.maxLogLossRegression}`
    );
  }

  const accepted = rejectionReasons.length === 0;
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
    baselineBrier: pooledBase,
    candidateBrier: pooledCandidate,
    baselineLogLoss: baseLogLoss,
    candidateLogLoss,
    folds,
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
  const { samples } = extractVerifiedSamples(records);
  const processed = new Set(state.processedSampleKeys);
  const fresh = samples.filter((s) => !processed.has(s.key));

  if (fresh.length === 0) {
    return { state, changed: false, reason: 'no new verified settlements' };
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
