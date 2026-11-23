import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnosePriceKind,
  selectPriceFromNode,
  verifyOddsPrice,
  verifyMarketOdds,
} from './oddsVerification';
import type { MarketOdds } from '../types/quant';

const NOW = new Date('2026-11-23T18:00:00.000Z');
const liveCtx = { matchStatus: 'live' as const, now: NOW, maxAgeSec: 180 };

function price(overrides: Partial<Parameters<typeof verifyOddsPrice>[0]> = {}) {
  return {
    value: 2.1,
    kind: 'live' as const,
    source: 'ESPN Bet via ESPN scoreboard API',
    capturedAt: '2026-11-23T17:59:30.000Z',
    marketId: '401800001:moneyline:home',
    ...overrides,
  };
}

test('missing bookmaker price is rejected, never defaulted', () => {
  const verdict = verifyOddsPrice(price({ value: undefined }), liveCtx);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.isLiveVerified, false);
  assert.match(verdict.reasons.join(' '), /missing price/i);
});

test('stale price fails freshness validation even when sourced and timed', () => {
  const stale = price({ capturedAt: '2026-11-23T17:30:00.000Z' });
  const verdict = verifyOddsPrice(stale, liveCtx);
  assert.equal(verdict.verified, false);
  assert.match(verdict.reasons.join(' '), /stale/i);

  const fresh = verifyOddsPrice(price(), liveCtx);
  assert.equal(fresh.verified, true);
});

test('live price requires a live match; closing price is never labelled live-verified', () => {
  const live = verifyOddsPrice(price(), liveCtx);
  assert.equal(live.isLiveVerified, true);

  const closing = verifyOddsPrice(price({ kind: 'closing' }), liveCtx);
  assert.equal(closing.verified, true);
  assert.equal(closing.isLiveVerified, false);

  const liveButUpcoming = verifyOddsPrice(price(), {
    matchStatus: 'upcoming',
    now: NOW,
  });
  assert.equal(liveButUpcoming.isLiveVerified, false);
});

test('synthetic 1.91 fallback without provenance is rejected', () => {
  const verdict = verifyOddsPrice(
    {
      value: 1.91,
      kind: 'unknown',
      source: undefined,
      capturedAt: undefined,
      marketId: undefined,
    },
    liveCtx
  );
  assert.equal(verdict.verified, false);
  assert.match(verdict.reasons.join(' '), /synthetic|unverified|provenance/i);

  // A real 1.91 price with full provenance is legitimate.
  const real = verifyOddsPrice(price({ value: 1.91 }), liveCtx);
  assert.equal(real.verified, true);
});

test('market identity is required to verify a price', () => {
  const verdict = verifyOddsPrice(price({ marketId: '' }), liveCtx);
  assert.equal(verdict.verified, false);
  assert.match(verdict.reasons.join(' '), /market identity/i);
});

test('price kind is diagnosed from the subtree the price actually came from', () => {
  const liveNode = {
    live: {
      odds: {
        moneyline: { home: { close: { odds: -120 } } },
      },
      lastUpdated: '2026-11-23T17:59:00.000Z',
    },
  };
  assert.equal(
    diagnosePriceKind({ live: liveNode.live, home: -120 }, 'home'),
    'live'
  );

  const preMatch = { moneyline: { home: { close: { odds: -130 } } } };
  assert.equal(
    diagnosePriceKind({ primary: preMatch, home: -130 }, 'home'),
    'closing'
  );

  const openOnly = { moneyline: { home: { open: { odds: -140 } } } };
  assert.equal(
    diagnosePriceKind({ primary: openOnly, home: -140 }, 'home'),
    'prematch'
  );
});

test('selectPriceFromNode prefers live subtree and never fabricates values', () => {
  const node = {
    live: { odds: { moneyline: { home: { close: { odds: '+110' } } } } },
  };
  assert.deepEqual(selectPriceFromNode(node, 'home'), { kind: 'live', american: '+110' });

  const noLive = { moneyline: { home: { close: { odds: '-105' } } } };
  assert.deepEqual(selectPriceFromNode(noLive, 'home'), { kind: 'closing', american: '-105' });

  const empty = { spread: -1.5 };
  assert.equal(selectPriceFromNode(empty, 'home'), null);
});

test('verifyMarketOdds fails closed when no usable price or provenance exists', () => {
  const bare: MarketOdds = {
    moneylineHome: 1.91,
    isLiveVerified: true,
  };
  const verdict = verifyMarketOdds(bare, { matchStatus: 'live', now: NOW });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.isLiveVerified, false);

  const sourced: MarketOdds = {
    moneylineHome: 1.91,
    isLiveVerified: true,
    priceKind: 'live',
    capturedAt: '2026-11-23T17:59:30.000Z',
    source: 'ESPN Bet',
    marketId: 'm1:moneyline:home',
  };
  const ok = verifyMarketOdds(sourced, { matchStatus: 'live', now: NOW });
  assert.equal(ok.verified, true);
  assert.equal(ok.isLiveVerified, true);
});

test('only a real price for the intended market is accepted', () => {
  const wrongMarket = verifyOddsPrice(
    price({ marketId: 'm1:total:over' }),
    { ...liveCtx, expectedMarketId: 'm1:moneyline:home' }
  );
  assert.equal(wrongMarket.verified, false);
  assert.match(wrongMarket.reasons.join(' '), /market identity/i);
});
