/**
 * Clamp into [min, max]. A non-finite input (NaN/Infinity from bad upstream
 * data) maps to the midpoint of the range, i.e. a neutral value, rather than
 * silently to `min` (which would turn a missing probability into 1% and a
 * missing rate into the floor). Money paths must guard non-finite inputs
 * themselves and return 0 instead of relying on this.
 */
export function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}

/**
 * Standard normal cumulative distribution function Phi(z)
 * Abramowitz & Stegun 7.1.26 approximation (error < 1.5e-7)
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  return 0.5 * (1.0 + erf(z / Math.SQRT2));
}

export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  const safeLambda = Math.max(0.0001, lambda);
  let logFact = 0;
  for (let i = 2; i <= k; i++) {
    logFact += Math.log(i);
  }
  return Math.exp(k * Math.log(safeLambda) - safeLambda - logFact);
}

export function poissonCdf(kMax: number, lambda: number): number {
  let sum = 0;
  const upper = Math.floor(kMax);
  for (let k = 0; k <= upper; k++) {
    sum += poissonPmf(k, lambda);
  }
  return clamp(sum, 0, 1);
}

/**
 * Record layouts differ by sport:
 *  - soccer: W-D-L (the middle number is DRAWS, not losses)
 *  - hockey: W-L-OTL (third number is overtime losses, which are losses)
 *  - everything else: W-L or W-L-T (third number is ties, worth half a win)
 */
export type RecordFormat = 'wlt' | 'wdl' | 'wlotl';

export function recordFormatForSport(sport?: string): RecordFormat {
  if (sport === 'soccer') return 'wdl';
  if (sport === 'hockey') return 'wlotl';
  return 'wlt';
}

export function parseRecordWinPct(record?: string, format: RecordFormat = 'wlt'): {
  wins: number;
  losses: number;
  ties: number;
  winPct: number;
  games: number;
} | null {
  if (!record || typeof record !== 'string') return null;
  const match = record.trim().match(/^(\d+)-(\d+)(?:-(\d+))?/);
  if (!match) return null;
  const a = Number.parseInt(match[1], 10);
  const b = Number.parseInt(match[2], 10);
  const c = match[3] ? Number.parseInt(match[3], 10) : 0;
  let wins = a;
  let losses = b;
  let ties = c;
  if (format === 'wdl' && match[3] !== undefined) {
    wins = a;
    ties = b; // draws
    losses = c;
  } else if (format === 'wlotl') {
    losses = b + c; // OT losses are losses
    ties = 0;
  }
  const games = wins + losses + ties;
  if (games <= 0) return null;
  // Bayesian Laplace smoothing towards 0.50 with pseudo-count 4 games
  const winPct = (wins + 0.5 * ties + 2) / (games + 4);
  return { wins, losses, ties, winPct: clamp(winPct, 0.12, 0.88), games };
}

export function americanToDecimalOdds(american: number | string | null | undefined): number | null {
  if (american === null || american === undefined || american === '') return null;
  const num = typeof american === 'string' ? Number.parseFloat(american) : american;
  if (!Number.isFinite(num) || num === 0) return null;
  // If already decimal-like (e.g., 1.01 to 50) when not +/-100 scale?
  // ESPN American odds are typically >= 100 or <= -100 (or EVEN = 100).
  if (num > -100 && num < 100) {
    if (num >= 1.01) return num;
    return null;
  }
  if (num >= 100) {
    return 1 + num / 100;
  }
  return 1 + 100 / Math.abs(num);
}

export function decimalToImpliedProb(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1.001) return 1;
  return clamp(1 / decimalOdds, 0.001, 0.999);
}

export function probToDecimalOdds(prob: number, pushProb = 0): number {
  const safe = clamp(prob, 0.01, 0.99);
  const push = clamp(pushProb, 0, 0.98);
  // Fair decimal odds when a push returns the stake: (1 - push) / winProb.
  const payout = Math.max(0.01, 1 - push);
  return Math.round((payout / safe) * 100) / 100;
}

/**
 * Exact Kelly fraction for win/loss/push markets. A push returns the stake,
 * so it contributes zero net profit and is already excluded from both legs.
 */
export function kellyFraction(
  winProb: number,
  lossProb: number,
  decimalOdds: number
): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1.01) return 0;
  if (!Number.isFinite(winProb) || !Number.isFinite(lossProb)) return 0;
  const b = decimalOdds - 1;
  const ev = winProb * b - lossProb;
  if (!(ev > 0)) return 0;
  return clamp(ev / b, 0, 1);
}

/**
 * Binary temperature scaling: sigma(gamma * logit(q)) = q^g / (q^g + (1-q)^g).
 *
 * This is the single calibration transform shared by the trainer
 * (adaptiveController) and the serving path (predictionEngine). Keeping one
 * implementation guarantees that a gamma chosen offline means exactly the same
 * thing when it is applied to live probabilities. gamma > 1 sharpens, gamma < 1
 * flattens toward 0.5; q = 0.5 is a fixed point and the transform is
 * antisymmetric, so complementary outcomes always sum to 1.
 */
export function temperatureScaleBinary(q: number, gamma: number): number {
  const p = clamp(Number.isFinite(q) ? q : 0.5, 0, 1);
  if (!Number.isFinite(gamma) || gamma <= 0 || Math.abs(gamma - 1) < 1e-12) return p;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const a = Math.pow(p, gamma);
  const b = Math.pow(1 - p, gamma);
  return a / (a + b);
}
