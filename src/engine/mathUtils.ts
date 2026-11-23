export function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
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

export function parseRecordWinPct(record?: string): {
  wins: number;
  losses: number;
  ties: number;
  winPct: number;
  games: number;
} | null {
  if (!record || typeof record !== 'string') return null;
  const match = record.trim().match(/^(\d+)-(\d+)(?:-(\d+))?/);
  if (!match) return null;
  const wins = Number.parseInt(match[1], 10);
  const losses = Number.parseInt(match[2], 10);
  const ties = match[3] ? Number.parseInt(match[3], 10) : 0;
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

export function probToDecimalOdds(prob: number): number {
  const safe = clamp(prob, 0.01, 0.99);
  return Math.round((1 / safe) * 100) / 100;
}
