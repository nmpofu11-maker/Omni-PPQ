import crypto from 'crypto';
import type {
  DataQualityTier,
  EvidenceSummary,
  MarketCategory,
  MatchStatus,
  PaperBet,
  PriceKind,
  PureFlowPrediction,
  ScrapedMatch,
  SportType,
  ValueAlert,
} from '../types/quant';
import { settlePaperBet } from './settlementEngine';

export const GENESIS_HASH = '0'.repeat(64);

export interface LedgerPredictionPayload {
  /** Deduplication identity for one observed price snapshot of one prediction. */
  snapshotKey: string;
  /**
   * 'priced' (default, also for legacy records): an alert that passed the edge
   * filter against a verified price. 'model_only': an unconditional snapshot of
   * the model's own outcome probability, recorded regardless of price or edge.
   * Only model_only snapshots are an unbiased sample for calibration learning.
   */
  snapshotKind?: 'priced' | 'model_only';
  /** model_only: progress decile (0-9), or -1 before kickoff. */
  progressBucket?: number;
  predictionId: string;
  matchId: string;
  sport: SportType;
  sportPath: string;
  league: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  clockLabel: string;
  status: MatchStatus;
  marketCategory: MarketCategory;
  selection: string;
  side: ValueAlert['side'];
  line?: number;
  recordedAt: string;
  probabilities: {
    /**
     * priced: the served (possibly calibrated) probability.
     * model_only: the RAW model probability before any promoted calibration.
     */
    fairProb: number;
    lossProb: number;
    pushProb: number;
    fairOdds: number;
    modelProbability: number;
    impliedProb: number;
  };
  pricing: {
    bookmakerOdds: number;
    evPct: number;
    kellyQuarterStakePct: number;
    oddsVerifiedLive: boolean;
    priceVerified: boolean;
    priceKind: PriceKind;
    priceSource?: string;
    priceCapturedAt?: string;
  };
  evidence: {
    dataQuality: DataQualityTier;
    dataQualityScore: number;
    uncertaintyScore: number;
    calibrationScore: number;
    convictionScore: number;
    rankingScore: number;
    evidence: EvidenceSummary;
  };
  model: {
    modelVersion: string;
    parameterVersion: string;
  };
  /** Odds-free Stage 1 inputs; never contains bookmaker prices. */
  featureSnapshot: Record<string, unknown>;
}

export type LedgerSettlementStatus = 'won' | 'lost' | 'push' | 'void';

export interface LedgerSettlementPayload {
  predictionId: string;
  matchId: string;
  settledAt: string;
  status: LedgerSettlementStatus;
  homeScore: number;
  awayScore: number;
  resultChecksum: string;
  error?: string;
}

/** Callers may omit matchId; it is always taken from the original prediction. */
export type LedgerSettlementInput = Omit<LedgerSettlementPayload, 'matchId'> & {
  matchId?: string;
};

interface LedgerRecordBase {
  seq: number;
  recordedAt: string;
  prevHash: string;
  hash: string;
}

export interface LedgerPredictionRecord extends LedgerRecordBase {
  type: 'prediction';
  payload: LedgerPredictionPayload;
}

export interface LedgerSettlementRecord extends LedgerRecordBase {
  type: 'settlement';
  payload: LedgerSettlementPayload;
}

export type LedgerRecord = LedgerPredictionRecord | LedgerSettlementRecord;

export function buildPredictionPayload(
  alert: ValueAlert,
  prediction: PureFlowPrediction,
  match: ScrapedMatch,
  recordedAt: string
): LedgerPredictionPayload {
  const snapshotKey = `${alert.id}|${alert.priceCapturedAt ?? alert.priceKind}|${alert.bookmakerOdds}`;
  return {
    snapshotKey,
    predictionId: alert.id,
    matchId: alert.matchId,
    sport: alert.sport,
    sportPath: alert.sportPath,
    league: alert.league,
    leagueName: alert.leagueName,
    homeTeam: alert.homeTeam,
    awayTeam: alert.awayTeam,
    clockLabel: alert.clockLabel,
    status: alert.status,
    marketCategory: alert.marketCategory,
    selection: alert.selection,
    side: alert.side,
    line: alert.line,
    recordedAt,
    probabilities: {
      fairProb: alert.fairProb,
      lossProb: alert.lossProb,
      pushProb: alert.pushProb,
      fairOdds: alert.fairOdds,
      modelProbability: alert.modelProbability,
      impliedProb: alert.impliedProb,
    },
    pricing: {
      bookmakerOdds: alert.bookmakerOdds,
      evPct: alert.evPct,
      kellyQuarterStakePct: alert.kellyQuarterStakePct,
      oddsVerifiedLive: alert.oddsVerifiedLive,
      priceVerified: alert.priceVerified,
      priceKind: alert.priceKind,
      priceSource: alert.priceSource,
      priceCapturedAt: alert.priceCapturedAt,
    },
    evidence: {
      dataQuality: alert.dataQuality,
      dataQualityScore: alert.dataQualityScore,
      uncertaintyScore: alert.uncertaintyScore,
      calibrationScore: alert.calibrationScore,
      convictionScore: alert.convictionScore,
      rankingScore: alert.rankingScore,
      evidence: prediction.evidence,
    },
    model: {
      modelVersion: prediction.modelVersion,
      parameterVersion: prediction.parameterVersion,
    },
    featureSnapshot: {
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      period: match.period,
      progressPct: match.progressPct,
      regulationMinutes: match.regulationMinutes,
      clockLabel: match.clockLabel,
      homeRecord: match.homeRecord,
      awayRecord: match.awayRecord,
      homeStats: { ...match.homeStats },
      awayStats: { ...match.awayStats },
      dataQuality: match.dataQuality,
    },
  };
}

const MODEL_ONLY_MIN_PROB = 0.001;

export function progressBucketOf(status: MatchStatus, progressPct: number): number {
  if (status === 'upcoming') return -1;
  const p = Number.isFinite(progressPct) ? Math.max(0, Math.min(1, progressPct)) : 0;
  return Math.min(9, Math.floor(p * 10));
}

/**
 * Unconditional model snapshots for calibration learning. They are written for
 * every live/upcoming match regardless of price or edge, so the learner sees
 * the model's whole prediction distribution instead of only the cases where it
 * disagreed with the market (a selection-biased, winner's-curse sample).
 *
 * Two-way sports record only the home outcome: the away outcome is its exact
 * complement and adds no information under a symmetric calibration. Soccer
 * records home/draw/away.
 */
export function buildModelOnlyPayloads(
  prediction: PureFlowPrediction,
  match: ScrapedMatch,
  recordedAt: string
): LedgerPredictionPayload[] {
  if (match.status === 'finished') return [];
  if (prediction.evidence && prediction.evidence.identityValid === false) return [];

  const raw = prediction.uncalibratedFairProbs ?? prediction.fairProbs;
  const served = prediction.fairProbs;
  const bucket = progressBucketOf(match.status, match.progressPct);
  const isSoccer = match.sport === 'soccer';
  const marketCategory: MarketCategory = isSoccer ? 'Match Winner (1X2)' : 'Moneyline (2-Way)';

  const outcomes: Array<{ side: 'home' | 'draw' | 'away'; selection: string; key: 'homeWin' | 'draw' | 'awayWin' }> =
    isSoccer
      ? [
          { side: 'home', selection: `${match.homeTeam} Win`, key: 'homeWin' },
          { side: 'draw', selection: 'Draw', key: 'draw' },
          { side: 'away', selection: `${match.awayTeam} Win`, key: 'awayWin' },
        ]
      : [{ side: 'home', selection: `${match.homeTeam} ML`, key: 'homeWin' }];

  const payloads: LedgerPredictionPayload[] = [];
  for (const o of outcomes) {
    const p = raw[o.key];
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    const win = Math.min(1 - MODEL_ONLY_MIN_PROB, Math.max(MODEL_ONLY_MIN_PROB, p));
    const predictionId = `${match.id}::model::${marketCategory}::${o.side}::b${bucket}`;
    const servedP = served[o.key];
    payloads.push({
      snapshotKey: `${predictionId}|model_only`,
      snapshotKind: 'model_only',
      progressBucket: bucket,
      predictionId,
      matchId: match.id,
      sport: match.sport,
      sportPath: match.sportPath,
      league: match.league,
      leagueName: match.leagueName,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      clockLabel: match.clockLabel,
      status: match.status,
      marketCategory,
      selection: o.selection,
      side: o.side,
      recordedAt,
      probabilities: {
        fairProb: Math.round(win * 10000) / 10000,
        lossProb: Math.round((1 - win) * 10000) / 10000,
        pushProb: 0,
        fairOdds: Math.round((1 / win) * 100) / 100,
        modelProbability:
          typeof servedP === 'number' && Number.isFinite(servedP)
            ? Math.round(servedP * 10000) / 10000
            : Math.round(win * 10000) / 10000,
        impliedProb: 0,
      },
      pricing: {
        bookmakerOdds: 0,
        evPct: 0,
        kellyQuarterStakePct: 0,
        oddsVerifiedLive: false,
        priceVerified: false,
        priceKind: 'unknown',
      },
      evidence: {
        dataQuality: prediction.dataQuality,
        dataQualityScore: 0,
        uncertaintyScore: Math.round((1 - prediction.confidence) * 10000) / 10000,
        calibrationScore: 1,
        convictionScore: 0,
        rankingScore: 0,
        evidence: prediction.evidence,
      },
      model: {
        modelVersion: prediction.modelVersion,
        parameterVersion: prediction.parameterVersion,
      },
      featureSnapshot: {
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        period: match.period,
        progressPct: match.progressPct,
        regulationMinutes: match.regulationMinutes,
        clockLabel: match.clockLabel,
        homeRecord: match.homeRecord,
        awayRecord: match.awayRecord,
        homeStats: { ...match.homeStats },
        awayStats: { ...match.awayStats },
        dataQuality: match.dataQuality,
      },
    });
  }
  return payloads;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    );
  return `{${entries.join(',')}}`;
}

/** Canonical form of exactly what JSON.stringify persists (so hashes survive reload). */
export function stableStringify(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : canonicalJson(JSON.parse(json));
}

export function computeRecordHash(
  prevHash: string,
  seq: number,
  recordedAt: string,
  type: LedgerRecord['type'],
  payload: unknown
): string {
  return crypto
    .createHash('sha256')
    .update(`${prevHash}|${seq}|${recordedAt}|${type}|${stableStringify(payload)}`)
    .digest('hex');
}

export function computeResultChecksum(
  predictionId: string,
  homeScore: number,
  awayScore: number
): string {
  return crypto
    .createHash('sha256')
    .update(`${predictionId}|${homeScore}|${awayScore}`)
    .digest('hex');
}

function lastHash(records: LedgerRecord[]): string {
  return records.length > 0 ? records[records.length - 1].hash : GENESIS_HASH;
}

function withRecord(
  records: LedgerRecord[],
  record: Omit<LedgerPredictionRecord, 'seq' | 'prevHash' | 'hash'>
    | Omit<LedgerSettlementRecord, 'seq' | 'prevHash' | 'hash'>
): LedgerRecord[] {
  const seq = records.length + 1;
  const prevHash = lastHash(records);
  const hash = computeRecordHash(prevHash, seq, record.recordedAt, record.type, record.payload);
  return [...records, { ...record, seq, prevHash, hash } as LedgerRecord];
}

export function appendPrediction(
  records: LedgerRecord[],
  payload: LedgerPredictionPayload,
  recordedAt = payload.recordedAt
): { records: LedgerRecord[]; appended: boolean } {
  const existing = records.find(
    (r): r is LedgerPredictionRecord =>
      r.type === 'prediction' && r.payload.snapshotKey === payload.snapshotKey
  );
  if (existing) return { records, appended: false };
  return {
    records: withRecord(records, { type: 'prediction', recordedAt, payload }),
    appended: true,
  };
}

/**
 * Appends many predictions in one pass. Equivalent to folding appendPrediction
 * but O(n + m) instead of O(n * m) with an array copy per record.
 */
export function appendPredictionsBatch(
  records: LedgerRecord[],
  payloads: LedgerPredictionPayload[]
): { records: LedgerRecord[]; appended: number } {
  const known = new Set<string>();
  for (const r of records) {
    if (r.type === 'prediction') known.add(r.payload.snapshotKey);
  }
  let out: LedgerRecord[] | null = null;
  let prevHash = lastHash(records);
  let seq = records.length;
  let appended = 0;
  for (const payload of payloads) {
    if (known.has(payload.snapshotKey)) continue;
    known.add(payload.snapshotKey);
    if (!out) out = records.slice();
    seq += 1;
    const recordedAt = payload.recordedAt;
    const hash = computeRecordHash(prevHash, seq, recordedAt, 'prediction', payload);
    out.push({ seq, recordedAt, prevHash, hash, type: 'prediction', payload } as LedgerRecord);
    prevHash = hash;
    appended++;
  }
  return { records: out ?? records, appended };
}

export function appendSettlement(
  records: LedgerRecord[],
  settlement: LedgerSettlementInput,
  recordedAt = settlement.settledAt
): { records: LedgerRecord[]; appended: boolean; error?: string } {
  const prediction = records.find(
    (r): r is LedgerPredictionRecord =>
      r.type === 'prediction' && r.payload.predictionId === settlement.predictionId
  );
  if (!prediction) {
    return { records, appended: false, error: 'unknown prediction' };
  }
  const already = records.some(
    (r) => r.type === 'settlement' && r.payload.predictionId === settlement.predictionId
  );
  if (already) {
    return { records, appended: false, error: 'already settled' };
  }
  const checksum = computeResultChecksum(
    settlement.predictionId,
    settlement.homeScore,
    settlement.awayScore
  );
  if (settlement.resultChecksum !== checksum) {
    return { records, appended: false, error: 'result checksum mismatch' };
  }
  const payload: LedgerSettlementPayload = {
    ...settlement,
    matchId: settlement.matchId ?? prediction.payload.matchId,
  };
  return {
    records: withRecord(records, { type: 'settlement', recordedAt, payload }),
    appended: true,
  };
}

const SUPPORTED_MARKETS = new Set<string>([
  'Moneyline (2-Way)',
  'Match Winner (1X2)',
  'Double Chance',
  'Point Spread',
  'Run Line',
  'Puck Line',
  'Asian Handicap / Spread',
  'Over / Under Total',
  'Over / Under Goals',
]);

/**
 * Settles every still-pending ledger prediction for a finished match against
 * the verified final score. One settlement per prediction, ever.
 */
export function settleLedgerForMatch(
  records: LedgerRecord[],
  match: ScrapedMatch
): { records: LedgerRecord[]; appended: number } {
  if (match.status !== 'finished') return { records, appended: 0 };

  const settledIds = new Set(
    records
      .filter((r): r is LedgerSettlementRecord => r.type === 'settlement')
      .map((r) => r.payload.predictionId)
  );
  const pending = records.filter(
    (r): r is LedgerPredictionRecord =>
      r.type === 'prediction' &&
      r.payload.matchId === match.id &&
      !settledIds.has(r.payload.predictionId)
  );

  let next = records;
  let appended = 0;

  for (const record of pending) {
    const p = record.payload;
    const settledAt = new Date().toISOString();
    const resultChecksum = computeResultChecksum(p.predictionId, match.homeScore, match.awayScore);

    if (!SUPPORTED_MARKETS.has(p.marketCategory)) {
      const outcome = appendSettlement(next, {
        predictionId: p.predictionId,
        matchId: p.matchId,
        settledAt,
        status: 'void',
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        resultChecksum,
        error: `unsupported market category: ${p.marketCategory}`,
      });
      if (outcome.appended) appended++;
      next = outcome.records;
      continue;
    }

    const bet: PaperBet = {
      id: p.predictionId,
      matchId: p.matchId,
      sport: p.sport,
      sportPath: p.sportPath,
      leagueName: p.leagueName,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      marketCategory: p.marketCategory,
      selection: p.selection,
      side: p.side,
      line: p.line,
      stakeAmount: 0,
      bookmakerOdds: 0,
      fairProbAtPlacement: p.probabilities.fairProb,
      evPctAtPlacement: p.pricing.evPct,
      convictionAtPlacement: p.evidence.convictionScore,
      oddsVerifiedLive: p.pricing.oddsVerifiedLive,
      placedAt: p.recordedAt,
      status: 'pending',
      pnl: 0,
    };
    const settled = settlePaperBet(bet, {
      status: match.status,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      homeLinescores: match.homeStats.linescores,
      awayLinescores: match.awayStats.linescores,
    });
    if (settled.status === 'pending') continue;

    const outcome = appendSettlement(next, {
      predictionId: p.predictionId,
      matchId: p.matchId,
      settledAt,
      status: settled.status,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      resultChecksum,
    });
    if (outcome.appended) appended++;
    next = outcome.records;
  }

  return { records: next, appended };
}

export interface LedgerVerification {
  valid: boolean;
  brokenAt?: number;
  reason?: string;
}

export function verifyLedger(records: LedgerRecord[]): LedgerVerification {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.seq !== i + 1) {
      return { valid: false, brokenAt: i + 1, reason: `sequence mismatch at record ${i + 1}` };
    }
    if (record.prevHash !== prevHash) {
      return { valid: false, brokenAt: i + 1, reason: `previous hash mismatch at record ${i + 1}` };
    }
    const expected = computeRecordHash(
      record.prevHash,
      record.seq,
      record.recordedAt,
      record.type,
      record.payload
    );
    if (record.hash !== expected) {
      return { valid: false, brokenAt: i + 1, reason: `hash mismatch at record ${i + 1}` };
    }
    prevHash = record.hash;
  }
  return { valid: true };
}

export interface LedgerCalibration {
  predictions: number;
  settled: number;
  decisive: number;
  pushes: number;
  brierScore: number;
  logLoss: number;
}

/**
 * Push/void outcomes carry no directional information, so they are excluded
 * from Brier and log-loss scoring while still counted as settled.
 */
export function calibrateLedger(
  records: LedgerRecord[],
  kind: 'priced' | 'model_only' = 'priced'
): LedgerCalibration {
  const predictions = records.filter(
    (r): r is LedgerPredictionRecord =>
      r.type === 'prediction' && (r.payload.snapshotKind ?? 'priced') === kind
  );
  const byId = new Map(predictions.map((r) => [r.payload.predictionId, r.payload]));
  const settlements = records.filter(
    (r): r is LedgerSettlementRecord =>
      r.type === 'settlement' && byId.has(r.payload.predictionId)
  );

  let decisive = 0;
  let pushes = 0;
  let brierSum = 0;
  let logLossSum = 0;

  for (const s of settlements) {
    if (s.payload.status === 'push' || s.payload.status === 'void') {
      pushes++;
      continue;
    }
    const prediction = byId.get(s.payload.predictionId);
    if (!prediction) continue;
    const p = Math.min(0.999, Math.max(0.001, prediction.probabilities.fairProb));
    const y = s.payload.status === 'won' ? 1 : 0;
    brierSum += Math.pow(p - y, 2);
    logLossSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    decisive++;
  }

  return {
    predictions: predictions.length,
    settled: settlements.length,
    decisive,
    pushes,
    brierScore: decisive > 0 ? brierSum / decisive : 0,
    logLoss: decisive > 0 ? logLossSum / decisive : 0,
  };
}
