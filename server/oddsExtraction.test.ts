import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarketOdds } from './scraper';

test('spread and total lines without quoted prices do not fabricate 1.91 odds', () => {
  const { odds } = extractMarketOdds(
    [{ spread: -1.5, overUnder: 8.5, provider: { name: 'ESPN Bet' } }],
    'upcoming',
    { matchId: 'm1', now: new Date('2026-11-23T18:00:00Z') }
  );
  assert.ok(odds);
  assert.equal(odds?.spreadLine, -1.5);
  assert.equal(odds?.totalLine, 8.5);
  assert.equal(odds?.spreadHomeOdds, undefined);
  assert.equal(odds?.spreadAwayOdds, undefined);
  assert.equal(odds?.overOdds, undefined);
  assert.equal(odds?.underOdds, undefined);
  assert.equal(odds?.isLiveVerified, false);
});

test('live subtree prices are labelled live only when they come from that subtree', () => {
  const { odds } = extractMarketOdds(
    [
      {
        live: {
          odds: {
            moneyline: { home: { close: { odds: '+120' } }, away: { close: { odds: '-140' } } },
          },
        },
        provider: { name: 'ESPN Bet' },
      },
    ],
    'live',
    { matchId: 'm2', now: new Date('2026-11-23T18:00:00Z') }
  );

  assert.ok(odds);
  assert.equal(odds?.priceKind, 'live');
  assert.equal(odds?.isLiveVerified, true);
  assert.equal(odds?.verification?.verified, true);
  assert.equal(odds?.source, 'ESPN Bet');
  assert.equal(odds?.marketId, 'm2:ESPN Bet');
  assert.ok(odds?.capturedAt);
  assert.ok((odds?.moneylineHome ?? 0) > 2.19);
});

test('a live odds object with only primary closing prices is NOT live-verified', () => {
  const { odds } = extractMarketOdds(
    [
      {
        live: { lastUpdated: '2026-11-23T17:59:00Z' },
        moneyline: {
          home: { close: { odds: -150 } },
          away: { close: { odds: '+130' } },
        },
        provider: { name: 'ESPN Bet' },
      },
    ],
    'live',
    { matchId: 'm3', now: new Date('2026-11-23T18:00:00Z') }
  );

  assert.ok(odds);
  assert.equal(odds?.priceKind, 'closing');
  assert.equal(odds?.isLiveVerified, false);
  assert.equal(odds?.verification?.verified, true);
});

test('prices without provider provenance are not verified', () => {
  const { odds } = extractMarketOdds(
    [{ moneyline: { home: { close: { odds: -110 } }, away: { close: { odds: -110 } } } }],
    'upcoming',
    { matchId: 'm4', now: new Date('2026-11-23T18:00:00Z') }
  );
  assert.ok(odds);
  assert.equal(odds?.verification?.verified, false);
  assert.equal(odds?.isLiveVerified, false);
});

test('legacy moneyline schema carries real prices and prematch provenance', () => {
  const { odds } = extractMarketOdds(
    [
      {
        homeTeamOdds: { moneyLine: -150, spreadOdds: '+120' },
        awayTeamOdds: { moneyLine: 130, spreadOdds: '-140' },
        spread: -1.5,
        overUnder: 8.5,
        overOdds: -110,
        underOdds: -110,
        provider: { name: 'ESPN Bet' },
      },
    ],
    'upcoming',
    { matchId: 'm5', now: new Date('2026-11-23T18:00:00Z') }
  );

  assert.ok(odds);
  assert.equal(odds?.isLiveVerified, false);
  assert.ok(odds?.priceKind === 'prematch' || odds?.priceKind === 'closing');
  assert.ok(Math.abs((odds?.moneylineHome ?? 0) - 1.6667) < 0.001);
  assert.equal(odds?.spreadHomeOdds, 2.2);
  assert.ok(Math.abs((odds?.overOdds ?? 0) - 1.9091) < 0.001);
  assert.equal(odds?.verification?.verified, true);
});
