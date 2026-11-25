/**
 * American football final margins are lumpy: scores come in 3s and 7s, so a
 * handful of "key numbers" (3, 7, 6, 10, 14 ...) carry far more probability
 * than a smooth Gaussian assigns. That matters a lot for integer spreads and
 * pushes (a -3 line is NOT a coin-flip around the Gaussian density at 3).
 *
 * We discretise the Gaussian final-margin distribution onto integers and
 * reweight each integer by an empirical key-number multiplier, then restore
 * the original mean with an exponential tilt so the point forecast is unchanged.
 * The lumpiness is applied pre-game at full strength and fades as the game is
 * played, because late in a game the margin is dominated by the current score.
 */
const KEY_MULTIPLIER: Record<number, number> = {
  0: 0.55,
  1: 1.1,
  2: 0.92,
  3: 2.3,
  4: 1.25,
  5: 0.95,
  6: 1.5,
  7: 1.9,
  8: 1.0,
  9: 0.9,
  10: 1.4,
  11: 0.85,
  12: 0.9,
  13: 0.9,
  14: 1.35,
  17: 1.15,
  21: 1.1,
};
const DEFAULT_MULTIPLIER = 0.95;

export function keyNumberMultiplier(absMargin: number): number {
  return KEY_MULTIPLIER[absMargin] ?? DEFAULT_MULTIPLIER;
}

function normalCdfLocal(z: number): number {
  // Abramowitz-Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-z * z) / 2);
  return 0.5 * (1 + (z >= 0 ? y : -y));
}

/** Integer-margin pmf over [lo, lo + probs.length - 1]. */
export function footballMarginPmf(
  mean: number,
  std: number,
  lumpStrength: number
): { lo: number; probs: number[] } {
  const sd = Math.max(0.5, std);
  const lam = Math.max(0, Math.min(1, lumpStrength));
  const lo = Math.round(mean) - Math.ceil(6 * sd) - 2;
  const hi = Math.round(mean) + Math.ceil(6 * sd) + 2;
  const n = hi - lo + 1;
  const base: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = lo + i;
    base[i] = Math.max(0, normalCdfLocal((m + 0.5 - mean) / sd) - normalCdfLocal((m - 0.5 - mean) / sd));
  }
  const weights = base.map((b, i) => b * (1 + (keyNumberMultiplier(Math.abs(lo + i)) - 1) * lam));

  const normalise = (w: number[]) => {
    const s = w.reduce((a, b) => a + b, 0);
    return s > 0 ? w.map((x) => x / s) : w;
  };
  const meanOf = (p: number[]) => p.reduce((a, b, i) => a + b * (lo + i), 0);

  // Exponential tilt exp(theta*(m - mean)) so the reweighted mean equals `mean`.
  let theta = 0;
  if (lam > 0) {
    let a = -0.5;
    let b = 0.5;
    for (let it = 0; it < 40; it++) {
      theta = (a + b) / 2;
      const tilted = normalise(weights.map((w, i) => w * Math.exp(theta * (lo + i - mean))));
      if (meanOf(tilted) > mean) b = theta;
      else a = theta;
    }
  }
  const probs = normalise(weights.map((w, i) => w * Math.exp(theta * (lo + i - mean))));
  return { lo, probs };
}

/** P(final margin > t), P(final margin < t), P(== t) for integer or half-point t. */
export function footballMarginTail(
  mean: number,
  std: number,
  lumpStrength: number,
  target: number
): { above: number; below: number; equal: number } {
  const { lo, probs } = footballMarginPmf(mean, std, lumpStrength);
  let above = 0;
  let below = 0;
  let equal = 0;
  for (let i = 0; i < probs.length; i++) {
    const m = lo + i;
    if (Math.abs(m - target) < 1e-9) equal += probs[i];
    else if (m > target) above += probs[i];
    else below += probs[i];
  }
  return { above, below, equal };
}
