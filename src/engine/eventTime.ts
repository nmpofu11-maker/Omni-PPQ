import type { SportType } from '../types/quant';

export interface SportClockInput {
  sport: SportType;
  clock?: string;
  period: number;
  periodLenMin?: number;
  regPeriods?: number;
  regulationMinutes?: number;
}

export interface ParsedSportClock {
  elapsedMinutes: number;
  elapsedPct: number;
  period: number;
  quality: 'clock' | 'period';
}

const DEFAULT_REG_MIN: Record<SportType, number> = {
  soccer: 90,
  basketball: 48,
  football: 60,
  hockey: 60,
  baseball: 162,
  tennis: 150,
};

function parseMinutesSeconds(clock: string): number | null {
  const m = clock.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 60;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Converts a source scoreboard clock into absolute elapsed match time.
 * Returns null when the source provides no trustworthy timing; callers must
 * not substitute an array index or period guess for a missing clock.
 */
export function parseSportClock(input: SportClockInput): ParsedSportClock | null {
  const clock = (input.clock ?? '').trim();
  const period = Math.max(1, Number(input.period) || 1);

  if (input.sport === 'soccer') {
    if (!clock) return null;
    if (/^(ht|half|half-?time)$/i.test(clock)) {
      return { elapsedMinutes: 45, elapsedPct: 45 / 90, period: 2, quality: 'period' };
    }
    const stoppage = clock.match(/^(\d+)\s*\+\s*(\d+)/);
    if (stoppage) {
      const mins = Number(stoppage[1]) + Number(stoppage[2]);
      return {
        elapsedMinutes: mins,
        elapsedPct: clamp01(mins / 90),
        period,
        quality: 'clock',
      };
    }
    const mmss = parseMinutesSeconds(clock);
    if (mmss !== null) {
      return {
        elapsedMinutes: mmss,
        elapsedPct: clamp01(mmss / 90),
        period,
        quality: 'clock',
      };
    }
    const mins = clock.match(/^(\d{1,3})\s*'?$/);
    if (!mins) return null;
    const value = Number(mins[1]);
    return {
      elapsedMinutes: value,
      elapsedPct: clamp01(value / 90),
      period,
      quality: 'clock',
    };
  }

  if (input.sport === 'basketball' || input.sport === 'football' || input.sport === 'hockey') {
    if (!clock) return null;
    const regPeriods =
      input.regPeriods ?? (input.sport === 'hockey' ? 3 : input.sport === 'football' ? 4 : 4);
    const periodLen =
      input.periodLenMin ?? (input.sport === 'hockey' ? 20 : input.sport === 'football' ? 15 : 12);
    const regTotal = regPeriods * periodLen;

    if (/^(ht|half|halftime|half-?time)$/i.test(clock)) {
      const elapsed = regTotal / 2;
      return {
        elapsedMinutes: elapsed,
        elapsedPct: clamp01(elapsed / regTotal),
        period: Math.min(period, regPeriods),
        quality: 'period',
      };
    }

    const remaining = parseMinutesSeconds(clock);
    if (remaining === null) return null;
    if (remaining > periodLen + 0.01) return null;

    const elapsed =
      period <= regPeriods
        ? (period - 1) * periodLen + (periodLen - remaining)
        : regTotal + (period - regPeriods - 1) * periodLen + (periodLen - remaining);
    return {
      elapsedMinutes: Math.max(0, elapsed),
      elapsedPct: clamp01(elapsed / regTotal),
      period,
      quality: 'clock',
    };
  }

  if (input.sport === 'baseball') {
    if (!clock) return null;
    const m = clock.match(/^(top|bot|bottom|mid|middle|end)\s*(\d+)/i);
    let half: 'top' | 'bottom' | 'mid' | 'end';
    let inning: number;
    if (m) {
      const label = m[1].toLowerCase();
      half = label.startsWith('top')
        ? 'top'
        : label.startsWith('bot')
          ? 'bottom'
          : label.startsWith('mid')
            ? 'mid'
            : 'end';
      inning = Number(m[2]);
    } else {
      const alt = clock.match(/^(\d+)(?:st|nd|rd|th)?\s*(top|bot|bottom|mid|middle|end)/i);
      if (!alt) return null;
      inning = Number(alt[1]);
      const label = alt[2].toLowerCase();
      half = label.startsWith('top')
        ? 'top'
        : label.startsWith('bot')
          ? 'bottom'
          : label.startsWith('mid')
            ? 'mid'
            : 'end';
    }
    const offset = half === 'top' ? 0.15 : half === 'bottom' ? 0.55 : half === 'mid' ? 0.5 : 0.95;
    const pct = clamp01((inning - 1 + offset) / 9);
    return {
      elapsedMinutes: pct * 9,
      elapsedPct: pct,
      period: inning,
      quality: 'clock',
    };
  }

  return null;
}

export function regulationMinutesFor(
  sport: SportType,
  periodLenMin?: number,
  regPeriods?: number
): number {
  if (sport === 'basketball') return (periodLenMin ?? 12) * (regPeriods ?? 4);
  return DEFAULT_REG_MIN[sport];
}
