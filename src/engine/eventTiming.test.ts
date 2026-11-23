import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSportClock } from './eventTime';
import { buildMomentumSeries, computeRecencyFlowScore } from './momentum';
import type { PlayEvent } from '../types/quant';

test('soccer clock parses real match minutes including stoppage time', () => {
  const normal = parseSportClock({ sport: 'soccer', clock: "58'", period: 2 });
  assert.ok(normal);
  assert.equal(normal?.elapsedMinutes, 58);
  assert.ok(Math.abs((normal?.elapsedPct ?? 0) - 58 / 90) < 1e-6);
  assert.equal(normal?.quality, 'clock');

  const stoppage = parseSportClock({ sport: 'soccer', clock: "45+2'", period: 1 });
  assert.equal(stoppage?.elapsedMinutes, 47);

  const halfTime = parseSportClock({ sport: 'soccer', clock: 'HT', period: 2 });
  assert.equal(halfTime?.elapsedMinutes, 45);
  assert.equal(halfTime?.quality, 'period');
});

test('basketball period clock converts remaining time to elapsed regulation time', () => {
  const q3 = parseSportClock({
    sport: 'basketball',
    clock: '04:12',
    period: 3,
    periodLenMin: 12,
    regPeriods: 4,
  });
  assert.ok(q3);
  // 2 full quarters = 24 min, plus 12 - 4.2 = 7.8 elapsed.
  assert.ok(Math.abs((q3?.elapsedMinutes ?? 0) - 31.8) < 1e-6);
  assert.ok(Math.abs((q3?.elapsedPct ?? 0) - 31.8 / 48) < 1e-6);

  const ot = parseSportClock({
    sport: 'basketball',
    clock: '02:00',
    period: 5,
    periodLenMin: 12,
    regPeriods: 4,
  });
  assert.ok(Math.abs((ot?.elapsedMinutes ?? 0) - 58) < 1e-6);
  assert.equal(ot?.elapsedPct, 1);
});

test('hockey and football clocks use sport-specific period lengths', () => {
  const hockey = parseSportClock({
    sport: 'hockey',
    clock: '11:20',
    period: 2,
    periodLenMin: 20,
    regPeriods: 3,
  });
  assert.ok(Math.abs((hockey?.elapsedMinutes ?? 0) - (20 + 20 - 11 - 20 / 60)) < 1e-6);

  const nfl = parseSportClock({
    sport: 'football',
    clock: '07:30',
    period: 3,
    periodLenMin: 15,
    regPeriods: 4,
  });
  assert.ok(Math.abs((nfl?.elapsedMinutes ?? 0) - (30 + 15 - 7.5)) < 1e-6);
});

test('baseball half-innings map to a regulation fraction, not an array index', () => {
  const top6 = parseSportClock({ sport: 'baseball', clock: 'Top 6th', period: 6 });
  assert.ok(top6);
  assert.equal(top6?.quality, 'clock');
  assert.ok(Math.abs((top6?.elapsedPct ?? 0) - (5 + 0.15) / 9) < 1e-6);
});

test('missing or unparseable clocks return null instead of inventing a time', () => {
  assert.equal(parseSportClock({ sport: 'tennis', clock: 'Set 2', period: 2 }), null);
  assert.equal(parseSportClock({ sport: 'soccer', clock: '', period: 1 }), null);
  assert.equal(
    parseSportClock({ sport: 'basketball', clock: 'not-a-clock', period: 2 }),
    null
  );
});

test('halftime is a trustworthy period mark, not invented time', () => {
  const ht = parseSportClock({
    sport: 'basketball',
    clock: 'HT',
    period: 2,
    periodLenMin: 12,
    regPeriods: 4,
  });
  assert.equal(ht?.elapsedMinutes, 24);
  assert.equal(ht?.elapsedPct, 0.5);
  assert.equal(ht?.quality, 'period');
});

function play(overrides: Partial<PlayEvent>): PlayEvent {
  return {
    id: 'p',
    clock: "50'",
    period: 2,
    team: 'home',
    type: 'Shot',
    text: 'x',
    weight: 1,
    ...overrides,
  };
}

test('momentum buckets use real event times and ignore untimed events', () => {
  const timed = [
    play({ id: 'h', team: 'home', elapsedPct: 0.5, weight: 2 }),
    play({ id: 'a', team: 'away', elapsedPct: 0.52, weight: 1 }),
    play({ id: 'u', team: 'home', weight: 99 }),
  ];
  const series = buildMomentumSeries(timed, 0.6, 1, 1);
  assert.equal(series.length, 8);
  const bucket = series[6]; // bucket ending at 52.5% contains the 50-52% plays
  assert.ok(bucket.homeMomentum > bucket.awayMomentum);

  const untimedOnly = [play({ id: 'u1', weight: 50 }), play({ id: 'u2', weight: 50 })];
  assert.deepEqual(buildMomentumSeries(untimedOnly, 0.5, 1, 1), []);
});

test('recency decay is computed from elapsed minutes, not array position', () => {
  const plays = [
    play({ id: 'recent', team: 'home', elapsedMinutes: 85, weight: 1 }),
    play({ id: 'old', team: 'home', elapsedMinutes: 20, weight: 1 }),
    play({ id: 'untimed', team: 'home', weight: 1 }),
  ];
  const flow = computeRecencyFlowScore(plays, {
    currentElapsedMinutes: 90,
    scaleMinutes: 90,
    decayRate: 0.08,
  });
  assert.equal(flow.count, 2);
  const expected = Math.exp(-0.08 * 5) + Math.exp(-0.08 * 70);
  assert.ok(Math.abs(flow.homeFlow - expected) < 1e-6);
});
