import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMarketOdds,
  extractTeamTelemetry,
  normalizeClockAndProgress,
  parseEspnScoreboardEvent,
  parseEspnSummary,
} from './scraper';
import { FULL_LEAGUE_CATALOG } from './leaguesCatalog';
import { LeagueInfo } from '../src/types/quant';

test('League catalog includes 220+ ESPN soccer slugs', () => {
  const soccerLeagues = FULL_LEAGUE_CATALOG.filter((l) => l.sport === 'soccer');
  assert.ok(
    soccerLeagues.length >= 220,
    `Expected >= 220 soccer slugs, got ${soccerLeagues.length}`
  );
});

test('Tennis groupings[].competitions[] and athlete/linescores parse cleanly', () => {
  const atpLeague: LeagueInfo = {
    slug: 'atp',
    name: 'ATP Tour',
    sport: 'tennis',
    sportPath: 'tennis/atp',
  };

  const mockTennisEvent = {
    id: '401800001',
    date: '2026-11-23T14:00:00Z',
    groupings: [
      {
        grouping: { displayName: "Men's Singles" },
        competitions: [
          {
            id: '401800002',
            format: { regulation: { periods: 3 } },
            status: {
              period: 2,
              type: { state: 'in', completed: false, shortDetail: 'Set 2' },
            },
            competitors: [
              {
                homeAway: 'home',
                athlete: { displayName: 'Jannik Sinner', shortName: 'J. Sinner' },
                records: [{ summary: '52-6' }],
                linescores: [{ value: 6 }, { value: 4 }],
              },
              {
                homeAway: 'away',
                roster: { athletes: [{ displayName: 'Alexander Zverev', shortName: 'A. Zverev' }] },
                records: [{ summary: '48-14' }],
                linescores: [{ value: 4 }, { value: 3 }],
              },
            ],
            odds: [
              {
                live: {
                  odds: {
                    moneyline: {
                      home: { close: { odds: '-250' } },
                      away: { close: { odds: '+200' } },
                    },
                  },
                },
                provider: { name: 'ESPN Bet' },
              },
            ],
          },
        ],
      },
    ],
  };

  const parsed = parseEspnScoreboardEvent(mockTennisEvent, atpLeague);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].homeTeam, 'Jannik Sinner');
  assert.equal(parsed[0].awayTeam, 'Alexander Zverev');
  assert.equal(parsed[0].homeRecord, '52-6');
  assert.equal(parsed[0].awayRecord, '48-14');
  assert.deepEqual(parsed[0].homeStats.linescores, [6, 4]);
  assert.deepEqual(parsed[0].awayStats.linescores, [4, 3]);
  assert.equal(parsed[0].odds?.isLiveVerified, true);
  assert.equal(parsed[0].odds?.moneylineHome, 1.4);
  assert.equal(parsed[0].odds?.moneylineAway, 3.0);
});

test('Clock and progressPct normalize cleanly across NBA, NCAAM, WNBA, NFL, NHL, MLB', () => {
  const nba = normalizeClockAndProgress('basketball', 'nba', {
    period: 3,
    displayClock: '06:00',
    type: { state: 'in', completed: false },
  });
  // NBA 4x12m -> Q3 6:00 remaining = 24 + 6 = 30 / 48 = 0.625
  assert.equal(nba.clockLabel, 'Q3 06:00');
  assert.ok(Math.abs(nba.progressPct - 0.625) < 1e-6);

  const ncaam = normalizeClockAndProgress('basketball', 'mens-college-basketball', {
    period: 2,
    displayClock: '10:00',
    type: { state: 'in', completed: false },
  });
  // NCAAM 2x20m -> 2nd 10:00 remaining = 20 + 10 = 30 / 40 = 0.75
  assert.equal(ncaam.clockLabel, '2nd 10:00');
  assert.ok(Math.abs(ncaam.progressPct - 0.75) < 1e-6);

  const wnba = normalizeClockAndProgress('basketball', 'wnba', {
    period: 2,
    displayClock: '05:00',
    type: { state: 'in', completed: false },
  });
  // WNBA 4x10m -> Q2 05:00 remaining = 10 + 5 = 15 / 40 = 0.375
  assert.equal(wnba.clockLabel, 'Q2 05:00');
  assert.ok(Math.abs(wnba.progressPct - 0.375) < 1e-6);

  const nhl = normalizeClockAndProgress('hockey', 'nhl', {
    period: 2,
    displayClock: '10:00',
    type: { state: 'in', completed: false },
  });
  assert.equal(nhl.clockLabel, '2nd 10:00');
  assert.ok(Math.abs(nhl.progressPct - 0.5) < 1e-6);
});

test('MLB nested batting/pitching boxscore and pickcenter summary odds parse accurately', () => {
  const mlbStats = extractTeamTelemetry('baseball', [
    {
      name: 'batting',
      stats: [
        { name: 'hits', value: 8, displayValue: '8' },
        { name: 'avg', value: 0.276, displayValue: '.276' },
      ],
    },
    {
      name: 'pitching',
      stats: [
        { name: 'ERA', value: 3.12, displayValue: '3.12' },
        { name: 'strikeouts', value: 7, displayValue: '7' },
      ],
    },
  ]);

  assert.equal(mlbStats.baseballHits, 8);
  assert.equal(mlbStats.battingAvg, 0.276);
  assert.equal(mlbStats.era, 3.12);
  assert.equal(mlbStats.strikeoutsPitching, 7);

  const preMatchOdds = extractMarketOdds(
    [
      {
        spread: -1.5,
        overUnder: 8.5,
        homeTeamOdds: { moneyLine: -150, spreadOdds: '+120' },
        awayTeamOdds: { moneyLine: 130, spreadOdds: '-140' },
        overOdds: -110,
        underOdds: -110,
      },
    ],
    'live'
  );
  assert.equal(preMatchOdds.hasLiveOddsNode, false);
  assert.equal(preMatchOdds.odds?.isLiveVerified, false);
  assert.equal(preMatchOdds.odds?.spreadLine, -1.5);
  assert.equal(preMatchOdds.odds?.totalLine, 8.5);

  const baseMatch = parseEspnScoreboardEvent(
    {
      id: '999',
      competitions: [
        {
          id: '999',
          status: { period: 6, type: { state: 'in', shortDetail: 'Top 6th' } },
          competitors: [
            { homeAway: 'home', team: { displayName: 'Yankees' }, score: '3' },
            { homeAway: 'away', team: { displayName: 'Red Sox' }, score: '2' },
          ],
        },
      ],
    },
    { slug: 'mlb', name: 'MLB', sport: 'baseball', sportPath: 'baseball/mlb' }
  )[0];

  const enriched = parseEspnSummary(
    {
      plays: [{ id: 'pl1', period: { number: 6 }, clock: { displayValue: 'Top 6th' }, text: 'Double to left field' }],
      pickcenter: [
        {
          live: {
            odds: {
              moneyline: { home: { close: { odds: -180 } }, away: { close: { odds: 155 } } },
              total: { over: { close: { line: 'o8.5', odds: -105 } }, under: { close: { odds: -115 } } },
            },
          },
        },
      ],
    },
    baseMatch
  );

  assert.equal(enriched.plays.length, 1);
  assert.equal(enriched.odds?.isLiveVerified, true);
  assert.equal(enriched.odds?.totalLine, 8.5);
});
