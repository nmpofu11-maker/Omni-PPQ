/**
 * Baseball base-out state. A progress fraction alone cannot tell "bases loaded,
 * nobody out" from "bases empty, two out", yet their expected runs for the rest
 * of the half-inning differ by ~3x. This module converts the current base-out
 * state into expected remaining runs using a run-expectancy (RE24) table.
 */
export interface BaseballBaseState {
  outs: number; // 0-2
  first: boolean;
  second: boolean;
  third: boolean;
  half: 'top' | 'bottom';
}

// Expected runs from this state to the end of the half-inning (league-average
// run environment ~4.45 runs / 9 innings). Rows: bases (empty,1,2,12,3,13,23,123); cols: 0,1,2 outs.
const RE24: number[][] = [
  [0.461, 0.243, 0.095],
  [0.831, 0.489, 0.214],
  [1.068, 0.644, 0.305],
  [1.373, 0.908, 0.343],
  [1.426, 0.865, 0.413],
  [1.798, 1.14, 0.471],
  [1.92, 1.352, 0.57],
  [2.282, 1.52, 0.736],
];

export const LEAGUE_RUNS_PER_9 = 4.45;

export function runExpectancy(state: Pick<BaseballBaseState, 'outs' | 'first' | 'second' | 'third'>): number {
  const outs = Math.max(0, Math.min(2, Math.floor(state.outs)));
  const idx = (state.first ? 1 : 0) + (state.second ? 2 : 0) + (state.third ? 4 : 0);
  // Table rows are ordered by the bit pattern first=1, second=2, third=4.
  return RE24[idx][outs];
}

/**
 * Parse ESPN-style situation + status text. Returns null when the state is not
 * reliably available (we then fall back to the progress-only model).
 */
export function parseBaseballSituation(situation: any, statusText?: string): BaseballBaseState | null {
  if (!situation || typeof situation !== 'object') return null;
  const outsRaw = Number(situation.outs);
  if (!Number.isFinite(outsRaw) || outsRaw < 0 || outsRaw > 3) return null;
  const text = (statusText ?? '').toLowerCase();
  let half: 'top' | 'bottom' | null = null;
  if (/\b(top|top of)\b/.test(text)) half = 'top';
  else if (/\b(bot|bottom)\b/.test(text)) half = 'bottom';
  if (!half) return null;
  if (outsRaw >= 3) return null; // between half-innings
  return {
    outs: outsRaw,
    first: Boolean(situation.onFirst),
    second: Boolean(situation.onSecond),
    third: Boolean(situation.onThird),
    half,
  };
}

/**
 * Expected runs for each side over the rest of a 9-inning game given the
 * current inning and base-out state. Returns null if the state does not apply
 * (extra innings, between innings, etc).
 */
export function baseballRemainingRuns(args: {
  inning: number; // 1-based
  state: BaseballBaseState;
  homeRate9: number;
  awayRate9: number;
}): { homeLambda: number; awayLambda: number } | null {
  const { inning, state, homeRate9, awayRate9 } = args;
  if (!Number.isInteger(inning) || inning < 1 || inning > 9) return null;
  const idx = (inning - 1) * 2 + (state.half === 'bottom' ? 1 : 0); // 0..17
  let futureHome = 0;
  let futureAway = 0;
  for (let i = idx + 1; i <= 17; i++) {
    if (i % 2 === 1) futureHome++;
    else futureAway++;
  }
  const battingIsHome = state.half === 'bottom';
  const battingRate = battingIsHome ? homeRate9 : awayRate9;
  const scale = Math.max(0.3, battingRate / LEAGUE_RUNS_PER_9);
  const currentHalfRuns = runExpectancy(state) * scale;
  return {
    homeLambda: (homeRate9 / 9) * futureHome + (battingIsHome ? currentHalfRuns : 0),
    awayLambda: (awayRate9 / 9) * futureAway + (battingIsHome ? 0 : currentHalfRuns),
  };
}
