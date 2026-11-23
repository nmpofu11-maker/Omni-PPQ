import express, { type Express } from 'express';
import {
  MatchesApiResponse,
  PaperBet,
  PureFlowPrediction,
  ScrapedMatch,
  SportFilter,
  ValueAlert,
} from '../src/types/quant';
import {
  predictPureFlow,
  stripOddsForFirewall,
} from '../src/engine/predictionEngine';
import {
  evaluateBettingValue,
  rankBestBets,
  type MatchValueMeta,
} from '../src/engine/valueEngine';
import {
  computeCalibrationMetrics,
  settlePaperBet,
} from '../src/engine/settlementEngine';
import {
  appendPrediction,
  buildPredictionPayload,
  calibrateLedger,
  settleLedgerForMatch,
  verifyLedger,
  type LedgerCalibration,
  type LedgerPredictionPayload,
  type LedgerRecord,
  type LedgerVerification,
} from '../src/engine/ledger';
import {
  fetchMatchSummary,
  getCatalogWithDiscovered,
  scrapeMatches,
} from './scraper';
import { loadStore, saveStore, type PersistedStore } from './store';
import { FileLedger, LedgerCorruptionError } from './ledgerStore';
import { AdaptiveStore } from './adaptiveStore';
import {
  AdaptiveGuardError,
  learnInShadow,
  productionModelOverrides,
  promoteCandidate,
  rollbackProduction,
  type AdaptiveProduction,
  type AdaptiveState,
  type LearnResult,
} from '../src/engine/adaptiveController';
import type { ModelParameterOverrides } from '../src/engine/modelParams';
import {
  addPushSubscription,
  dispatchBestBetPush,
  getSubscriptionCount,
  getVapidPublicKey,
  sendTestPush,
} from './pushService';
import {
  mutationRateLimit,
  requireCsrf,
  requireSession,
  resolveSecurityConfig,
  sessionMiddleware,
  type SecurityConfig,
} from './security';

const VALID_SPORTS: Set<string> = new Set([
  'all',
  'soccer',
  'basketball',
  'football',
  'hockey',
  'baseball',
  'tennis',
]);

const VALID_SIDES: Set<string> = new Set(['home', 'away', 'draw', 'over', 'under']);
const MATCH_ID_RE = /^[a-zA-Z0-9_-]+$/;
const BET_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface PushAdapter {
  getPublicKey(): string;
  subscriptionCount(): number;
  addSubscription(subscription: unknown): void;
  dispatchBestBet(bestBet: ValueAlert | null): Promise<{ sent: number; skipped: boolean }>;
  sendTest(): Promise<{ sent: number }>;
}

export interface StoreAdapter {
  load(): PersistedStore;
  save(store: PersistedStore): void;
}

export interface LedgerAdapter {
  recordPredictions(payloads: LedgerPredictionPayload[]): number;
  settleMatch(match: ScrapedMatch): number;
  snapshot(): {
    entries: LedgerRecord[];
    verification: LedgerVerification;
    calibration: LedgerCalibration;
  };
}

export interface AdaptiveAdapter {
  status(): AdaptiveState;
  learn(records: LedgerRecord[], nowIso: string): LearnResult;
  promote(
    candidateId: string,
    options: { enabled: boolean; actor: string; now: string }
  ): { state: AdaptiveState; production: AdaptiveProduction };
  rollback(options: { actor: string; now: string }): {
    state: AdaptiveState;
    production: AdaptiveProduction;
  };
  predictionOverrides(): ModelParameterOverrides;
}

export interface AppServices {
  scrapeMatches: (sport: SportFilter, leagueSlug?: string) => Promise<ScrapedMatch[]>;
  fetchMatchSummary: (matchId: string) => Promise<ScrapedMatch>;
  getCatalog: (sport: SportFilter) => unknown[];
  store: StoreAdapter;
  ledger: LedgerAdapter;
  push: PushAdapter;
  adaptive: AdaptiveAdapter;
}

export interface CreateAppOptions {
  security?: Partial<SecurityConfig>;
  services?: Partial<AppServices>;
  now?: () => Date;
}

function defaultAdaptiveAdapter(): AdaptiveAdapter {
  const store = new AdaptiveStore();
  let state: AdaptiveState | null = null;
  let warned = false;

  const current = (): AdaptiveState => {
    if (!state) state = store.load();
    return state;
  };
  const commit = (next: AdaptiveState): AdaptiveState => {
    store.save(next);
    state = next;
    return next;
  };

  return {
    status: current,
    learn: (records, nowIso) => {
      const result = learnInShadow(current(), records, { now: nowIso });
      if (result.changed) commit(result.state);
      return result;
    },
    promote: (candidateId, options) => {
      const result = promoteCandidate(current(), candidateId, options);
      commit(result.state);
      return result;
    },
    rollback: (options) => {
      const result = rollbackProduction(current(), options);
      commit(result.state);
      return result;
    },
    predictionOverrides: () => {
      // A corrupt controller file must not take predictions down; predictions
      // fall back to shipped defaults until the corruption is surfaced/fixed.
      try {
        return productionModelOverrides(current());
      } catch (err) {
        if (!warned) {
          console.warn('[adaptive] production overrides unavailable; using shipped defaults:', err);
          warned = true;
        }
        return {};
      }
    },
  };
}

function defaultServices(): AppServices {
  const ledger = new FileLedger();
  return {
    scrapeMatches: (sport, league) => scrapeMatches(sport, league),
    fetchMatchSummary: (id) => fetchMatchSummary(id),
    getCatalog: (sport) => getCatalogWithDiscovered(sport),
    store: { load: loadStore, save: saveStore },
    ledger: {
      recordPredictions: (payloads) =>
        ledger.appendRecords((existing) =>
          payloads.reduce(
            (records, payload) => appendPrediction(records, payload).records,
            existing
          )
        ),
      settleMatch: (match) =>
        ledger.appendRecords((existing) => settleLedgerForMatch(existing, match).records),
      snapshot: () => {
        const entries = ledger.read();
        return {
          entries,
          verification: verifyLedger(entries),
          calibration: calibrateLedger(entries),
        };
      },
    },
    push: {
      getPublicKey: getVapidPublicKey,
      subscriptionCount: getSubscriptionCount,
      addSubscription: addPushSubscription,
      dispatchBestBet: dispatchBestBetPush,
      sendTest: sendTestPush,
    },
    adaptive: defaultAdaptiveAdapter(),
  };
}

function buildSportCounts(matches: ScrapedMatch[]): {
  sportCounts: Record<SportFilter, number>;
  liveCounts: Record<SportFilter, number>;
} {
  const sportCounts: Record<SportFilter, number> = {
    all: matches.length,
    soccer: 0,
    basketball: 0,
    football: 0,
    hockey: 0,
    baseball: 0,
    tennis: 0,
  };
  const liveCounts: Record<SportFilter, number> = {
    all: 0,
    soccer: 0,
    basketball: 0,
    football: 0,
    hockey: 0,
    baseball: 0,
    tennis: 0,
  };

  for (const m of matches) {
    sportCounts[m.sport] = (sportCounts[m.sport] ?? 0) + 1;
    if (m.status === 'live') {
      liveCounts[m.sport] = (liveCounts[m.sport] ?? 0) + 1;
      liveCounts.all++;
    }
  }

  return { sportCounts, liveCounts };
}

function metaFor(match: ScrapedMatch): MatchValueMeta {
  return {
    id: match.id,
    sport: match.sport,
    sportPath: match.sportPath,
    league: match.league,
    leagueName: match.leagueName,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    clockLabel: match.clockLabel,
    status: match.status,
    dataQuality: match.dataQuality,
    progressPct: match.progressPct,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameLine(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) < 1e-9;
}

function parseSportFilter(raw: unknown): SportFilter {
  const value = String(raw ?? 'all').toLowerCase();
  return VALID_SPORTS.has(value) ? (value as SportFilter) : 'all';
}

/** Reads a boolean query flag, defaulting to `fallback` when absent. */
function parseFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function logFailure(scope: string, err: unknown): void {
  console.error(`[api] ${scope} failed:`, err);
}

export function createApp(options: CreateAppOptions = {}): Express {
  const now = options.now ?? (() => new Date());
  const security: SecurityConfig = {
    ...resolveSecurityConfig(process.env, (msg) => console.warn(`[security] ${msg}`)),
    ...options.security,
  };
  const services: AppServices = { ...defaultServices(), ...options.services };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', sessionMiddleware(security, () => now().getTime()));

  const mutationGuard = [requireSession(), requireCsrf(), mutationRateLimit(security)];

  // STRICT STAGE 1 FIREWALL: odds are stripped before prediction, and only
  // explicitly promoted production parameters may reach the engines.
  const predictFor = (match: ScrapedMatch): PureFlowPrediction =>
    predictPureFlow(stripOddsForFirewall(match), {
      params: services.adaptive.predictionOverrides(),
    });

  const autoSettleAgainstMatches = (matches: ScrapedMatch[]): boolean => {
    if (matches.length === 0) return false;
    const matchMap = new Map(matches.map((m) => [m.id, m]));
    const store = services.store.load();
    let changed = false;

    store.bets = store.bets.map((bet) => {
      if (bet.status !== 'pending') return bet;
      const m = matchMap.get(bet.matchId);
      if (!m || m.status !== 'finished') return bet;

      const settled = settlePaperBet(bet, {
        status: m.status,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        homeLinescores: m.homeStats.linescores,
        awayLinescores: m.awayStats.linescores,
      });
      if (settled.status !== 'pending') {
        changed = true;
        store.bankroll = round2(store.bankroll + settled.stakeAmount + settled.pnl);
      }
      return settled;
    });

    if (changed) {
      services.store.save(store);
    }

    // Mirror finished results into the immutable prediction ledger once.
    for (const m of matches) {
      if (m.status !== 'finished') continue;
      try {
        services.ledger.settleMatch(m);
      } catch (err) {
        logFailure('ledger settle', err);
      }
    }
    return changed;
  };

  const recordEligiblePredictions = (
    matches: ScrapedMatch[],
    alerts: ValueAlert[],
    predictions: Record<string, PureFlowPrediction>
  ): void => {
    const matchById = new Map(matches.map((m) => [m.id, m]));
    const recordedAt = now().toISOString();
    const payloads: LedgerPredictionPayload[] = [];
    for (const alert of alerts) {
      if (!alert.priceVerified) continue;
      const match = matchById.get(alert.matchId);
      const prediction = predictions[alert.matchId];
      if (!match || !prediction) continue;
      payloads.push(buildPredictionPayload(alert, prediction, match, recordedAt));
    }
    if (payloads.length === 0) return;
    try {
      services.ledger.recordPredictions(payloads);
    } catch (err) {
      logFailure('ledger record', err);
    }
  };

  // 1. Multi-sport live & scheduled matches + Stage 1 & Stage 2 pipeline
  app.get('/api/matches', async (req, res) => {
    try {
      const sportFilter = parseSportFilter(req.query.sport);
      const leagueParam = req.query.league ? String(req.query.league) : undefined;
      const verifiedLiveOnly = parseFlag(req.query.verifiedLiveOnly, true);

      const allMatches =
        leagueParam && leagueParam !== 'all'
          ? await services.scrapeMatches(sportFilter, leagueParam)
          : await services.scrapeMatches('all');

      autoSettleAgainstMatches(allMatches);

      const { sportCounts, liveCounts } = buildSportCounts(allMatches);

      const filteredMatches = allMatches.filter((m) => {
        if (sportFilter !== 'all' && m.sport !== sportFilter) return false;
        if (leagueParam && leagueParam !== 'all' && m.league !== leagueParam) return false;
        return true;
      });

      const predictions: Record<string, PureFlowPrediction> = {};
      const allAlerts: ValueAlert[] = [];

      for (const match of filteredMatches) {
        const pred = predictFor(match);
        predictions[match.id] = pred;

        // STAGE 2: evaluate betting value against scraped market odds
        const matchAlerts = evaluateBettingValue(
          pred,
          match.odds,
          metaFor(match),
          {
            verifiedLiveOnly: false, // gather all, then filter/rank cleanly
            minEvPct: 1.5,
            now: now(),
          }
        );
        allAlerts.push(...matchAlerts);
      }

      const liveVerifiedAlerts = allAlerts.filter((a) => a.oddsVerifiedLive);
      const effectiveAlerts =
        verifiedLiveOnly && liveVerifiedAlerts.length > 0
          ? liveVerifiedAlerts
          : verifiedLiveOnly
            ? []
            : allAlerts;

      const rankedAlerts = rankBestBets(effectiveAlerts);
      const bestBet = rankedAlerts[0] ?? null;

      // Every eligible (verified-price) prediction is logged once per price
      // snapshot, whether or not the user ever places a bet.
      recordEligiblePredictions(filteredMatches, allAlerts, predictions);

      // Dispatch background Web Push for #1 Best Bet if qualified
      if (bestBet && bestBet.oddsVerifiedLive) {
        services.push.dispatchBestBet(bestBet).catch(() => {});
      }

      const response: MatchesApiResponse = {
        timestamp: now().toISOString(),
        sportCounts,
        liveCounts,
        matches: filteredMatches,
        predictions,
        alerts: rankedAlerts,
        bestBet,
        verifiedLiveOnly,
      };

      res.json(response);
    } catch (err) {
      logFailure('matches', err);
      res.status(500).json({ error: 'Failed to fetch live matches' });
    }
  });

  // 2. Deep Match Inspector via sportPath registry
  app.get('/api/matches/:id', async (req, res) => {
    try {
      const matchId = String(req.params.id);
      if (!MATCH_ID_RE.test(matchId)) {
        res.status(400).json({ error: 'Invalid match ID format' });
        return;
      }

      const match = await services.fetchMatchSummary(matchId);
      const prediction = predictFor(match);

      const alerts = rankBestBets(
        evaluateBettingValue(
          prediction,
          match.odds,
          metaFor(match),
          { verifiedLiveOnly: false, minEvPct: -100, includeFinished: true, now: now() }
        )
      );

      res.json({ match, prediction, alerts });
    } catch (err) {
      logFailure('match summary', err);
      res.status(404).json({ error: 'Match not found' });
    }
  });

  // 3. Full multi-sport league catalog (including 220+ soccer slugs)
  app.get('/api/leagues', (req, res) => {
    const sportFilter = parseSportFilter(req.query.sport);
    const leagues = services.getCatalog(sportFilter);
    res.json({ count: leagues.length, leagues });
  });

  // 4. Ranked Best Bet endpoint
  app.get('/api/best-bet', async (req, res) => {
    try {
      const verifiedLiveOnly = parseFlag(req.query.verifiedLiveOnly, true);
      const matches = await services.scrapeMatches('all');
      const allAlerts: ValueAlert[] = [];
      const predictions: Record<string, PureFlowPrediction> = {};

      for (const m of matches) {
        const pred = predictFor(m);
        predictions[m.id] = pred;
        const alerts = evaluateBettingValue(pred, m.odds, metaFor(m), {
          verifiedLiveOnly,
          minEvPct: 1.5,
          now: now(),
        });
        allAlerts.push(...alerts);
      }

      recordEligiblePredictions(matches, allAlerts, predictions);
      const ranked = rankBestBets(allAlerts);
      res.json({ bestBet: ranked[0] ?? null, alerts: ranked, verifiedLiveOnly });
    } catch (err) {
      logFailure('best-bet', err);
      res.status(500).json({ error: 'Failed to compute best bet' });
    }
  });

  // 5. Immutable prediction ledger (read-only, hash-chain verified)
  app.get('/api/ledger', (_req, res) => {
    try {
      res.json(services.ledger.snapshot());
    } catch (err) {
      logFailure('ledger read', err);
      if (err instanceof LedgerCorruptionError) {
        res.status(500).json({
          error: 'Prediction ledger is corrupted; manual recovery required',
        });
        return;
      }
      res.status(500).json({ error: 'Failed to read prediction ledger' });
    }
  });

  // 6. Adaptive Prediction Controller (shadow-first; promotion is operator-gated)
  app.get('/api/adaptive/status', (_req, res) => {
    try {
      res.json(services.adaptive.status());
    } catch (err) {
      logFailure('adaptive status', err);
      res.status(500).json({
        error: 'Adaptive controller state is corrupted; manual recovery required',
      });
    }
  });

  app.post('/api/adaptive/learn', ...mutationGuard, (_req, res) => {
    try {
      const { entries } = services.ledger.snapshot();
      const result = services.adaptive.learn(entries, now().toISOString());
      res.json({
        changed: result.changed,
        reason: result.reason,
        candidate: result.candidate,
        state: result.state,
      });
    } catch (err) {
      logFailure('adaptive learn', err);
      if (err instanceof LedgerCorruptionError) {
        res.status(500).json({ error: 'Prediction ledger is corrupted; learning refused' });
        return;
      }
      res.status(500).json({ error: 'Adaptive learning failed' });
    }
  });

  app.post('/api/adaptive/promote', ...mutationGuard, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
    if (!/^[a-f0-9]{16}$/.test(candidateId)) {
      res.status(400).json({ error: 'Invalid candidate ID' });
      return;
    }
    // Promotion is never automatic: an operator must explicitly enable it.
    const enabled = process.env.ADAPTIVE_PROMOTION_ENABLED === 'true';
    try {
      const result = services.adaptive.promote(candidateId, {
        enabled,
        actor: 'operator',
        now: now().toISOString(),
      });
      res.json(result);
    } catch (err) {
      if (err instanceof AdaptiveGuardError) {
        const status =
          err.code === 'unknown-candidate'
            ? 404
            : err.code === 'ineligible-candidate'
              ? 409
              : 403;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      logFailure('adaptive promote', err);
      res.status(500).json({ error: 'Adaptive promotion failed' });
    }
  });

  app.post('/api/adaptive/rollback', ...mutationGuard, (_req, res) => {
    try {
      const result = services.adaptive.rollback({
        actor: 'operator',
        now: now().toISOString(),
      });
      res.json(result);
    } catch (err) {
      if (err instanceof AdaptiveGuardError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      logFailure('adaptive rollback', err);
      res.status(500).json({ error: 'Adaptive rollback failed' });
    }
  });

  // 7. Paper Betting & Calibration Endpoints
  app.get('/api/bets', (_req, res) => {
    const store = services.store.load();
    const calibration = computeCalibrationMetrics(store.bets);
    res.json({
      bankroll: store.bankroll,
      initialBankroll: store.initialBankroll,
      bets: store.bets,
      calibration,
      firestoreConfig: store.firestoreConfig,
    });
  });

  app.post('/api/bets', ...mutationGuard, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const matchId = typeof body.matchId === 'string' ? body.matchId.trim() : '';
      const marketCategory =
        typeof body.marketCategory === 'string' ? body.marketCategory : '';
      const side = typeof body.side === 'string' ? body.side : '';
      const stakeAmount = Number(body.stakeAmount);
      const submittedOdds = Number(body.bookmakerOdds);
      const line =
        body.line === undefined || body.line === null ? undefined : Number(body.line);

      if (!MATCH_ID_RE.test(matchId)) {
        res.status(400).json({ error: 'Invalid match ID format' });
        return;
      }
      if (
        !marketCategory ||
        !VALID_SIDES.has(side) ||
        !Number.isFinite(stakeAmount) ||
        stakeAmount <= 0 ||
        !Number.isFinite(submittedOdds) ||
        submittedOdds <= 1.01 ||
        (line !== undefined && !Number.isFinite(line))
      ) {
        res.status(400).json({ error: 'Invalid paper bet payload' });
        return;
      }

      const store = services.store.load();
      if (stakeAmount > store.bankroll) {
        res.status(400).json({ error: 'Insufficient paper bankroll for stake' });
        return;
      }

      let match: ScrapedMatch;
      try {
        match = await services.fetchMatchSummary(matchId);
      } catch {
        res.status(404).json({ error: 'Match not found' });
        return;
      }
      if (match.status === 'finished') {
        res.status(409).json({ error: 'Match has already finished' });
        return;
      }

      // Rebuild every probability and price claim from the match snapshot; the
      // client can only choose the market and stake.
      const prediction = predictFor(match);
      const alerts = evaluateBettingValue(prediction, match.odds, metaFor(match), {
        verifiedLiveOnly: false,
        minEvPct: -100,
        includeFinished: false,
        requireVerifiedPrice: true,
        now: now(),
      });
      const candidate = alerts.find(
        (a) =>
          a.marketCategory === marketCategory &&
          a.side === (side as ValueAlert['side']) &&
          sameLine(a.line, line)
      );

      if (!candidate) {
        res.status(409).json({
          error: 'This market is not available at a verified price',
        });
        return;
      }
      if (Math.abs(candidate.bookmakerOdds - submittedOdds) > 0.005) {
        res.status(409).json({
          error: 'Price has changed; refresh the market before placing',
          currentPrice: candidate.bookmakerOdds,
        });
        return;
      }

      const bet: PaperBet = {
        id: `bet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        matchId: match.id,
        sport: match.sport,
        sportPath: match.sportPath,
        leagueName: match.leagueName,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        marketCategory: candidate.marketCategory,
        selection: candidate.selection,
        side: candidate.side,
        line: candidate.line,
        stakeAmount: round2(stakeAmount),
        bookmakerOdds: candidate.bookmakerOdds,
        fairProbAtPlacement: candidate.fairProb,
        evPctAtPlacement: candidate.evPct,
        convictionAtPlacement: candidate.convictionScore,
        oddsVerifiedLive: candidate.oddsVerifiedLive,
        placedAt: now().toISOString(),
        status: 'pending',
        pnl: 0,
      };

      store.bankroll = round2(store.bankroll - bet.stakeAmount);
      store.bets.unshift(bet);
      services.store.save(store);

      res.status(201).json({
        bet,
        bankroll: store.bankroll,
        bets: store.bets,
        calibration: computeCalibrationMetrics(store.bets),
      });
    } catch (err) {
      logFailure('place bet', err);
      res.status(500).json({ error: 'Failed to place paper bet' });
    }
  });

  app.post('/api/bets/settle', ...mutationGuard, async (_req, res) => {
    try {
      const store = services.store.load();
      const pendingBets = store.bets.filter((b) => b.status === 'pending');
      let settledCount = 0;

      for (let i = 0; i < store.bets.length; i++) {
        const bet = store.bets[i];
        if (bet.status !== 'pending') continue;
        try {
          const m = await services.fetchMatchSummary(bet.matchId);
          if (m.status !== 'finished') continue;
          try {
            services.ledger.settleMatch(m);
          } catch (err) {
            logFailure('ledger settle', err);
          }
          const settled = settlePaperBet(bet, {
            status: m.status,
            homeScore: m.homeScore,
            awayScore: m.awayScore,
            homeLinescores: m.homeStats.linescores,
            awayLinescores: m.awayStats.linescores,
          });
          if (settled.status !== 'pending') {
            store.bets[i] = settled;
            store.bankroll = round2(store.bankroll + settled.stakeAmount + settled.pnl);
            settledCount++;
          }
        } catch {
          // Skip matches unavailable on the upstream summary feed.
        }
      }

      if (settledCount > 0) {
        services.store.save(store);
      }

      res.json({
        checked: pendingBets.length,
        settledCount,
        bankroll: store.bankroll,
        bets: store.bets,
        calibration: computeCalibrationMetrics(store.bets),
      });
    } catch (err) {
      logFailure('settle bets', err);
      res.status(500).json({ error: 'Settlement failed' });
    }
  });

  app.post('/api/bets/reset', ...mutationGuard, (_req, res) => {
    const store = services.store.load();
    store.bankroll = 10000;
    store.initialBankroll = 10000;
    store.bets = [];
    services.store.save(store);
    res.json({
      bankroll: store.bankroll,
      initialBankroll: store.initialBankroll,
      bets: [],
      calibration: computeCalibrationMetrics([]),
    });
  });

  app.delete('/api/bets/:id', ...mutationGuard, (req, res) => {
    const betId = String(req.params.id);
    if (!BET_ID_RE.test(betId)) {
      res.status(400).json({ error: 'Invalid bet ID format' });
      return;
    }
    const store = services.store.load();
    const target = store.bets.find((b) => b.id === betId);
    if (!target) {
      res.status(404).json({ error: 'Bet not found' });
      return;
    }
    if (target.status === 'pending') {
      store.bankroll = round2(store.bankroll + target.stakeAmount);
    }
    store.bets = store.bets.filter((b) => b.id !== betId);
    services.store.save(store);
    res.json({
      bankroll: store.bankroll,
      bets: store.bets,
      calibration: computeCalibrationMetrics(store.bets),
    });
  });

  // 6. Web Push VAPID Endpoints
  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({
      publicKey: services.push.getPublicKey(),
      subscribers: services.push.subscriptionCount(),
    });
  });

  app.post('/api/push/subscribe', ...mutationGuard, (req, res) => {
    const sub = req.body as
      | { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
      | undefined;
    if (
      !sub ||
      typeof sub.endpoint !== 'string' ||
      !/^https:\/\//.test(sub.endpoint) ||
      !sub.keys ||
      typeof sub.keys.p256dh !== 'string' ||
      typeof sub.keys.auth !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid push subscription' });
      return;
    }
    services.push.addSubscription(sub);
    res.json({ ok: true, subscribers: services.push.subscriptionCount() });
  });

  app.post('/api/push/test', ...mutationGuard, async (_req, res) => {
    try {
      const result = await services.push.sendTest();
      res.json(result);
    } catch (err) {
      logFailure('push test', err);
      res.status(500).json({ error: 'Push test failed' });
    }
  });

  return app;
}
