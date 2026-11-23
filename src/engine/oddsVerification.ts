import type {
  MarketOdds,
  MatchStatus,
  OddsVerification,
  PriceKind,
} from '../types/quant';

export type PriceSide = 'home' | 'away' | 'draw' | 'over' | 'under';

export interface PriceCandidate {
  value?: number;
  kind: PriceKind;
  source?: string;
  capturedAt?: string;
  marketId?: string;
}

export interface VerifyContext {
  matchStatus: MatchStatus;
  now?: Date;
  /** Maximum age for a non-live price. */
  maxAgeSec?: number;
  /** Maximum age for a live price. */
  liveMaxAgeSec?: number;
  expectedMarketId?: string;
}

const DEFAULT_MAX_AGE_SEC = 300;
const DEFAULT_LIVE_MAX_AGE_SEC = 180;
const SYNTHETIC_SENTINEL = 1.91;

function toMs(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function isUsableDecimalPrice(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 1.01 && value < 1000;
}

/**
 * Verification is tied to the *selected* price: its value, source, capture
 * timestamp and market identity. A live odds object existing is not sufficient.
 */
export function verifyOddsPrice(
  candidate: PriceCandidate,
  ctx: VerifyContext
): OddsVerification {
  const reasons: string[] = [];
  const nowMs = (ctx.now ?? new Date()).getTime();

  if (!isUsableDecimalPrice(candidate.value)) {
    reasons.push('missing price: no usable decimal bookmaker price');
  }

  const hasSource = typeof candidate.source === 'string' && candidate.source.trim().length > 0;
  const capturedMs = toMs(candidate.capturedAt);
  const hasMarketId =
    typeof candidate.marketId === 'string' && candidate.marketId.trim().length > 0;

  if (!hasSource) reasons.push('missing source provenance');
  if (capturedMs === null) reasons.push('missing capture timestamp');
  if (!hasMarketId) reasons.push('missing market identity');

  if (
    candidate.value !== undefined &&
    Math.abs(candidate.value - SYNTHETIC_SENTINEL) < 1e-9 &&
    (!hasSource || capturedMs === null || candidate.kind === 'unknown')
  ) {
    reasons.push('synthetic fallback price (unprovenanced 1.91)');
  }

  if (candidate.kind === 'unknown') {
    reasons.push('unverified price provenance (price kind unknown)');
  }

  let ageSec: number | undefined;
  if (capturedMs !== null) {
    ageSec = Math.max(0, Math.round((nowMs - capturedMs) / 1000));
    if (capturedMs - nowMs > 60_000) {
      reasons.push('capture timestamp is in the future');
    } else {
      const maxAge =
        candidate.kind === 'live'
          ? (ctx.liveMaxAgeSec ?? DEFAULT_LIVE_MAX_AGE_SEC)
          : (ctx.maxAgeSec ?? DEFAULT_MAX_AGE_SEC);
      if (ageSec > maxAge) {
        reasons.push(`stale price: ${ageSec}s old (max ${maxAge}s)`);
      }
    }
  }

  if (ctx.expectedMarketId && candidate.marketId !== ctx.expectedMarketId) {
    reasons.push(
      `market identity mismatch: expected ${ctx.expectedMarketId}, got ${candidate.marketId ?? 'none'}`
    );
  }

  const verified = reasons.length === 0;
  const isLiveVerified =
    verified && candidate.kind === 'live' && ctx.matchStatus === 'live';

  return { verified, isLiveVerified, reasons, ageSec };
}

export function verifyMarketOdds(odds: MarketOdds, ctx: VerifyContext): OddsVerification {
  const prices = [
    odds.moneylineHome,
    odds.moneylineDraw,
    odds.moneylineAway,
    odds.spreadHomeOdds,
    odds.spreadAwayOdds,
    odds.overOdds,
    odds.underOdds,
  ].filter((p): p is number => typeof p === 'number' && Number.isFinite(p));

  if (prices.length === 0) {
    return {
      verified: false,
      isLiveVerified: false,
      reasons: ['missing price: no bookmaker prices present'],
    };
  }

  return verifyOddsPrice(
    {
      value: prices[0],
      kind: odds.priceKind ?? 'unknown',
      source: odds.source ?? odds.provider,
      capturedAt: odds.capturedAt ?? odds.lastUpdated,
      marketId: odds.marketId,
    },
    ctx
  );
}

function firstDefined(...values: Array<number | string | undefined | null>): number | string | null {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function sideAmericanOdds(obj: any, side: PriceSide): number | string | null {
  if (!obj || typeof obj !== 'object') return null;
  if (side === 'over' || side === 'under') {
    return (
      firstDefined(
        obj?.total?.[side]?.live?.odds,
        obj?.total?.[side]?.close?.odds,
        obj?.total?.[side]?.open?.odds,
        obj?.[`${side}Odds`]
      ) ?? null
    );
  }
  return (
    firstDefined(
      obj?.moneyline?.[side]?.live?.odds,
      obj?.moneyline?.[side]?.close?.odds,
      obj?.moneyline?.[side]?.open?.odds,
      obj?.[`${side}TeamOdds`]?.moneyLine,
      obj?.[`${side}Odds`]?.moneyLine
    ) ?? null
  );
}

function looksLikeOddsNode(value: any): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value.moneyline || value.pointSpread || value.total || value.homeTeamOdds || value.awayTeamOdds)
  );
}

/**
 * Selects a price from a node, preferring the live subtree. Returns null when
 * the node contains no actual price for that side; it never fabricates one.
 */
export function selectPriceFromNode(
  node: any,
  side: PriceSide,
  opts: { kindHint?: PriceKind; emittedOnly?: boolean } = {}
): { kind: PriceKind; american: number | string } | null {
  if (!node || typeof node !== 'object') return null;

  const liveContainer =
    node?.live?.odds ?? (looksLikeOddsNode(node?.live) ? node.live : null);
  if (liveContainer) {
    const livePrice = sideAmericanOdds(liveContainer, side);
    if (livePrice !== null) return { kind: 'live', american: livePrice };
  }

  if (opts.kindHint === 'live') {
    const direct = sideAmericanOdds(node, side);
    if (direct !== null) return { kind: 'live', american: direct };
  }

  const direct = sideAmericanOdds(node, side);
  if (direct === null) {
    // Explicit pointSpread / spread odds paths (legacy schemas).
    if (side === 'home' || side === 'away') {
      const spreadOdds = firstDefined(
        node?.pointSpread?.[side]?.live?.odds,
        node?.pointSpread?.[side]?.close?.odds,
        node?.pointSpread?.[side]?.open?.odds,
        node?.[`${side}TeamOdds`]?.spreadOdds
      );
      if (spreadOdds !== null && spreadOdds !== undefined) {
        const isLive = Boolean(node?.pointSpread?.[side]?.live?.odds);
        return { kind: isLive ? 'live' : 'prematch', american: spreadOdds };
      }
    }
    return null;
  }

  const livePath = side === 'over' || side === 'under'
    ? node?.total?.[side]?.live?.odds
    : node?.moneyline?.[side]?.live?.odds;
  if (livePath !== undefined && livePath !== null) return { kind: 'live', american: direct };

  const closePath = side === 'over' || side === 'under'
    ? node?.total?.[side]?.close?.odds
    : node?.moneyline?.[side]?.close?.odds;
  if (closePath !== undefined && closePath !== null) return { kind: 'closing', american: direct };

  const openPath = side === 'over' || side === 'under'
    ? node?.total?.[side]?.open?.odds
    : node?.moneyline?.[side]?.open?.odds;
  if (openPath !== undefined && openPath !== null) return { kind: 'prematch', american: direct };

  return { kind: opts.kindHint ?? 'prematch', american: direct };
}

/**
 * Diagnostic helper: reports which subtree a price came from.
 */
export function diagnosePriceKind(
  input: { live?: any; primary?: any; home?: any; away?: any; draw?: any; value?: any },
  side: PriceSide
): PriceKind {
  if (input.live) return 'live';
  const node = input.primary ?? input;
  const m = node?.moneyline?.[side];
  if (m?.live?.odds !== undefined) return 'live';
  if (m?.close?.odds !== undefined) return 'closing';
  if (m?.open?.odds !== undefined) return 'prematch';
  return 'unknown';
}
