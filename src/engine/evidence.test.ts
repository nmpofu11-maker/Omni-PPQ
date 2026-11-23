import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidence, inferDataQuality } from './evidence';
import type { OddsFreeMatchSnapshot } from '../types/quant';

function snapshot(overrides: Partial<OddsFreeMatchSnapshot> = {}): OddsFreeMatchSnapshot {
  return {
    id: 'm1',
    sport: 'soccer',
    league: 'eng.1',
    leagueName: 'Premier League',
    sportPath: 'soccer/eng.1',
    status: 'live',
    startTime: '2026-11-23T15:00:00Z',
    clockLabel: "65'",
    period: 2,
    progressPct: 0.72,
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeScore: 1,
    awayScore: 1,
    homeStats: { shots: 14, shotsOnTarget: 6, corners: 7, possessionPct: 61 },
    awayStats: { shots: 7, shotsOnTarget: 2, corners: 3, possessionPct: 39 },
    plays: [
      { id: 'p1', clock: "58'", period: 2, elapsedPct: 0.64, team: 'home', type: 'Shot', text: '', weight: 1.5 },
    ],
    dataQuality: 'record_prior',
    ...overrides,
  };
}

test('two-sided boxscore with timed plays is play-by-play verified', () => {
  const s = snapshot();
  assert.equal(inferDataQuality(s), 'play_by_play_boxscore');
  const e = assessEvidence(s);
  assert.equal(e.homeBox, 'complete');
  assert.equal(e.awayBox, 'complete');
  assert.equal(e.playsTimed, 1);
  assert.equal(e.identityValid, true);
});

test('one-sided team statistics never become box-score verified', () => {
  const s = snapshot({ awayStats: {} });
  assert.notEqual(inferDataQuality(s), 'play_by_play_boxscore');
  assert.equal(inferDataQuality(s), 'record_prior');
  const e = assessEvidence(s);
  assert.equal(e.homeBox, 'complete');
  assert.equal(e.awayBox, 'none');
  assert.match(e.notes.join(' '), /one-sided/i);
});

test('match progress alone does not upgrade evidence quality', () => {
  const s = snapshot({
    homeStats: {},
    awayStats: {},
    plays: [],
    progressPct: 0.9,
  });
  assert.equal(inferDataQuality(s), 'record_prior');
});

test('untimed plays do not count toward play-by-play verification', () => {
  const s = snapshot({
    plays: [
      { id: 'p1', clock: 'x', period: 2, team: 'home', type: 'Shot', text: '', weight: 1 },
      { id: 'p2', clock: 'y', period: 2, team: 'away', type: 'Shot', text: '', weight: 1 },
    ],
  });
  const e = assessEvidence(s);
  assert.equal(e.playsTimed, 0);
  assert.equal(inferDataQuality(s), 'live_boxscore');
});

test('invalid match identity downgrades evidence to record prior', () => {
  const s = snapshot({ homeTeam: 'Chelsea', awayTeam: 'Chelsea' });
  const e = assessEvidence(s);
  assert.equal(e.identityValid, false);
  assert.equal(inferDataQuality(s), 'record_prior');
});

test('upcoming matches with only records are record prior regardless of progress', () => {
  const s = snapshot({
    status: 'upcoming',
    progressPct: 0,
    homeStats: {},
    awayStats: {},
    plays: [],
  });
  assert.equal(inferDataQuality(s), 'record_prior');
});
