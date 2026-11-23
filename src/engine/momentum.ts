import type { PlayEvent, PureFlowPrediction } from '../types/quant';

function timedFraction(play: PlayEvent, scaleMinutes: number): number | null {
  if (Number.isFinite(play.elapsedPct)) return Math.max(0, Math.min(1, play.elapsedPct as number));
  if (Number.isFinite(play.elapsedMinutes)) {
    return Math.max(0, Math.min(1, (play.elapsedMinutes as number) / scaleMinutes));
  }
  return null;
}

/**
 * Momentum buckets are built only from plays with a real source time. Untimed
 * plays are excluded rather than placed by array index.
 */
export function buildMomentumSeries(
  plays: PlayEvent[],
  progressPct: number,
  homeBase: number,
  awayBase: number,
  scaleMinutes = 90
): PureFlowPrediction['momentumSeries'] {
  const buckets = 8;
  const timed = plays
    .map((p) => ({ play: p, t: timedFraction(p, scaleMinutes) }))
    .filter((x): x is { play: PlayEvent; t: number } => x.t !== null);

  if (timed.length === 0) return [];

  const maxPct = Math.max(0.1, progressPct);
  const series: PureFlowPrediction['momentumSeries'] = [];

  for (let i = 1; i <= buckets; i++) {
    const bucketEnd = (i / buckets) * maxPct;
    const bucketStart = ((i - 1) / buckets) * maxPct;
    let homeSignal = 0;
    let awaySignal = 0;

    for (const { play, t } of timed) {
      if (t >= bucketStart && t <= bucketEnd) {
        if (play.team === 'home') homeSignal += play.weight;
        else if (play.team === 'away') awaySignal += play.weight;
      }
    }

    const total = homeSignal + awaySignal;
    const homeMomentum =
      total > 0
        ? Math.max(0.1, Math.min(0.95, 0.25 + 0.75 * (homeSignal / total)))
        : Math.max(0.2, Math.min(0.8, homeBase / Math.max(0.1, homeBase + awayBase)));
    const awayMomentum = Math.max(0.05, Math.min(0.9, 1 - homeMomentum));

    series.push({
      pct: Math.round(bucketEnd * 100),
      label: `${Math.round(bucketEnd * 100)}%`,
      homeMomentum: Math.round(homeMomentum * 100) / 100,
      awayMomentum: Math.round(awayMomentum * 100) / 100,
    });
  }

  return series;
}

export interface RecencyOptions {
  currentElapsedMinutes: number;
  scaleMinutes: number;
  decayRate: number;
}

export function computeRecencyFlowScore(
  plays: PlayEvent[],
  opts: RecencyOptions
): { homeFlow: number; awayFlow: number; count: number } {
  let homeFlow = 0;
  let awayFlow = 0;
  let count = 0;
  const { currentElapsedMinutes, scaleMinutes, decayRate } = opts;

  for (const p of plays) {
    let deltaMin: number | null = null;
    if (Number.isFinite(p.elapsedMinutes)) {
      deltaMin = currentElapsedMinutes - (p.elapsedMinutes as number);
    } else if (Number.isFinite(p.elapsedPct)) {
      const currentPct = scaleMinutes > 0 ? currentElapsedMinutes / scaleMinutes : 1;
      deltaMin = (currentPct - (p.elapsedPct as number)) * scaleMinutes;
    }
    if (deltaMin === null) continue;
    // Ignore events that claim to happen in the future by more than a minute.
    if (deltaMin < -1) continue;
    deltaMin = Math.max(0, deltaMin);

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
