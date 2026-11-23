/**
 * Versioned, auditable model parameters. Defaults reproduce the previously
 * shipped priors; the shadow-mode controller may evaluate alternatives without
 * mutating these until out-of-sample promotion criteria are met.
 */
export interface SoccerModelParams {
  homeGoalsPer90: number;
  awayGoalsPer90: number;
  recordTilt: number;
  rho: number; // Dixon-Coles low-score correction (negative lifts draws)
}

export interface BasketballModelParams {
  nbaTeamTotal: number;
  otherTeamTotal: number;
  marginHomeAdv: number;
  otherMarginHomeAdv: number;
  marginRecordTilt: number;
  otherMarginRecordTilt: number;
  marginStdBase: number;
  totalStdBase: number;
}

export interface FootballModelParams {
  totalMean: number;
  marginHomeAdv: number;
  marginRecordTilt: number;
  marginStdBase: number;
  totalStdBase: number;
}

export interface HockeyModelParams {
  homeGoalsPer60: number;
  awayGoalsPer60: number;
  recordTilt: number;
  otShareMin: number;
  otShareMax: number;
  otGoalsPerTie: number;
}

export interface BaseballModelParams {
  homeRunsPer9: number;
  awayRunsPer9: number;
  recordTilt: number;
  extraInningsRunsShare: number;
}

export interface TennisModelParams {
  baseServeHome: number;
  baseServeAway: number;
}

import type { SportType } from '../types/quant';

/**
 * Probability calibration learned out-of-sample by the adaptive controller.
 * Absent by default; only a guarded, explicitly promoted candidate can set it.
 */
export interface CalibrationParams {
  perSport?: Partial<Record<SportType, { gamma: number }>>;
}

export interface ModelParameterSet {
  version: string;
  soccer: SoccerModelParams;
  basketball: BasketballModelParams;
  football: FootballModelParams;
  hockey: HockeyModelParams;
  baseball: BaseballModelParams;
  tennis: TennisModelParams;
  calibration?: CalibrationParams;
}

export const MODEL_VERSION = 'pureflow-2.1.0';

export const DEFAULT_MODEL_PARAMS: ModelParameterSet = {
  version: '2026.11-default-v1',
  soccer: {
    homeGoalsPer90: 1.42,
    awayGoalsPer90: 1.18,
    recordTilt: 1.15,
    rho: -0.13,
  },
  basketball: {
    nbaTeamTotal: 113.5,
    otherTeamTotal: 73.5,
    marginHomeAdv: 2.1,
    otherMarginHomeAdv: 2.8,
    marginRecordTilt: 24,
    otherMarginRecordTilt: 26,
    marginStdBase: 12.2,
    totalStdBase: 15.8,
  },
  football: {
    totalMean: 45.5,
    marginHomeAdv: 1.8,
    marginRecordTilt: 19,
    marginStdBase: 13.8,
    totalStdBase: 14.5,
  },
  hockey: {
    homeGoalsPer60: 3.05,
    awayGoalsPer60: 2.85,
    recordTilt: 1.4,
    otShareMin: 0.35,
    otShareMax: 0.65,
    otGoalsPerTie: 0.6,
  },
  baseball: {
    homeRunsPer9: 4.45,
    awayRunsPer9: 4.25,
    recordTilt: 2.4,
    extraInningsRunsShare: 1.4,
  },
  tennis: {
    baseServeHome: 0.62,
    baseServeAway: 0.6,
  },
};

export type ModelParameterOverrides = {
  [K in keyof ModelParameterSet]?: Partial<ModelParameterSet[K]>;
};

export function resolveModelParams(
  overrides?: ModelParameterOverrides
): ModelParameterSet {
  if (!overrides) return DEFAULT_MODEL_PARAMS;
  return {
    version: DEFAULT_MODEL_PARAMS.version,
    soccer: { ...DEFAULT_MODEL_PARAMS.soccer, ...overrides.soccer },
    basketball: { ...DEFAULT_MODEL_PARAMS.basketball, ...overrides.basketball },
    football: { ...DEFAULT_MODEL_PARAMS.football, ...overrides.football },
    hockey: { ...DEFAULT_MODEL_PARAMS.hockey, ...overrides.hockey },
    baseball: { ...DEFAULT_MODEL_PARAMS.baseball, ...overrides.baseball },
    tennis: { ...DEFAULT_MODEL_PARAMS.tennis, ...overrides.tennis },
    calibration: overrides.calibration,
  };
}
