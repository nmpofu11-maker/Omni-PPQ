import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  MatchesApiResponse,
  PaperBet,
  PureFlowPrediction,
  ScrapedMatch,
  SportFilter,
  ValueAlert,
} from './src/types/quant';
import {
  predictPureFlow,
  stripOddsForFirewall,
} from './src/engine/predictionEngine';
import { evaluateBettingValue, rankBestBets } from './src/engine/valueEngine';
import {
  computeCalibrationMetrics,
  settlePaperBet,
} from './src/engine/settlementEngine';
import {
  fetchMatchSummary,
  getCatalogWithDiscovered,
  scrapeMatches,
} from './server/scraper';
import { loadStore, saveStore } from './server/store';
import {
  addPushSubscription,
  dispatchBestBetPush,
  getSubscriptionCount,
  getVapidPublicKey,
  initPushService,
  sendTestPush,
} from './server/pushService';

const VALID_SPORTS: Set<string> = new Set([
  'all',
  'soccer',
  'basketball',
  'football',
  'hockey',
  'baseball',
  'tennis',
]);

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

function autoSettleAgainstMatches(matches: ScrapedMatch[]): boolean {
  if (matches.length === 0) return false;
  const matchMap = new Map(matches.map((m) => [m.id, m]));
  const store = loadStore();
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
      store.bankroll = Math.round((store.bankroll + settled.stakeAmount + settled.pnl) * 100) / 100;
    }
    return settled;
  });

  if (changed) {
    saveStore(store);
  }
  return changed;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '1mb' }));
  initPushService();

  // 1. Multi-sport live & scheduled matches + Stage 1 & Stage 2 pipeline
  app.get('/api/matches', async (req, res) => {
    try {
      const rawSport = String(req.query.sport || 'all').toLowerCase();
      const sportFilter: SportFilter = VALID_SPORTS.has(rawSport)
        ? (rawSport as SportFilter)
        : 'all';
      const leagueParam = req.query.league ? String(req.query.league) : undefined;
      const verifiedLiveOnly =
        req.query.verifiedLiveOnly === undefined
          ? true
          : req.query.verifiedLiveOnly === 'true';

      // Fetch all core sports when computing global counts unless a specific extra league is chosen
      const allMatches =
        leagueParam && leagueParam !== 'all'
          ? await scrapeMatches(sportFilter, leagueParam)
          : await scrapeMatches('all');

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
        // STRICT STAGE 1 FIREWALL: strip all odds before predicting
        const oddsFree = stripOddsForFirewall(match);
        const pred = predictPureFlow(oddsFree);
        predictions[match.id] = pred;

        // STAGE 2: evaluate betting value against scraped market odds
        const matchAlerts = evaluateBettingValue(pred, match.odds, {
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
        }, {
          verifiedLiveOnly: false, // gather all, then filter/rank cleanly
          minEvPct: 1.5,
        });
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

      // Dispatch background Web Push for #1 Best Bet if qualified
      if (bestBet && bestBet.oddsVerifiedLive) {
        dispatchBestBetPush(bestBet).catch(() => {});
      }

      const response: MatchesApiResponse = {
        timestamp: new Date().toISOString(),
        sportCounts,
        liveCounts,
        matches: filteredMatches,
        predictions,
        alerts: rankedAlerts,
        bestBet,
        verifiedLiveOnly,
      };

      res.json(response);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to fetch live matches' });
    }
  });

  // 2. Deep Match Inspector via sportPath registry
  app.get('/api/matches/:id', async (req, res) => {
    try {
      const matchId = String(req.params.id);
      if (!/^[a-zA-Z0-9_-]+$/.test(matchId)) {
        res.status(400).json({ error: 'Invalid match ID format' });
        return;
      }

      const match = await fetchMatchSummary(matchId);
      const oddsFree = stripOddsForFirewall(match);
      const prediction = predictPureFlow(oddsFree);

      const alerts = rankBestBets(
        evaluateBettingValue(
          prediction,
          match.odds,
          {
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
          },
          { verifiedLiveOnly: false, minEvPct: -100, includeFinished: true }
        )
      );

      res.json({
        match,
        prediction,
        alerts,
      });
    } catch (err: any) {
      res.status(404).json({ error: err?.message || 'Match not found' });
    }
  });

  // 3. Full multi-sport league catalog (including 220+ soccer slugs)
  app.get('/api/leagues', (req, res) => {
    const rawSport = String(req.query.sport || 'all').toLowerCase();
    const sportFilter: SportFilter = VALID_SPORTS.has(rawSport)
      ? (rawSport as SportFilter)
      : 'all';
    const leagues = getCatalogWithDiscovered(sportFilter);
    res.json({
      count: leagues.length,
      leagues,
    });
  });

  // 4. Ranked Best Bet endpoint
  app.get('/api/best-bet', async (req, res) => {
    try {
      const verifiedLiveOnly =
        req.query.verifiedLiveOnly === undefined
          ? true
          : req.query.verifiedLiveOnly === 'true';

      const matches = await scrapeMatches('all');
      const allAlerts: ValueAlert[] = [];

      for (const m of matches) {
        const pred = predictPureFlow(stripOddsForFirewall(m));
        const alerts = evaluateBettingValue(
          pred,
          m.odds,
          {
            id: m.id,
            sport: m.sport,
            sportPath: m.sportPath,
            league: m.league,
            leagueName: m.leagueName,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            clockLabel: m.clockLabel,
            status: m.status,
            dataQuality: m.dataQuality,
            progressPct: m.progressPct,
          },
          { verifiedLiveOnly, minEvPct: 1.5 }
        );
        allAlerts.push(...alerts);
      }

      const ranked = rankBestBets(allAlerts);
      res.json({
        bestBet: ranked[0] ?? null,
        alerts: ranked,
        verifiedLiveOnly,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to compute best bet' });
    }
  });

  // 5. Paper Betting & Calibration Endpoints
  app.get('/api/bets', (_req, res) => {
    const store = loadStore();
    const calibration = computeCalibrationMetrics(store.bets);
    res.json({
      bankroll: store.bankroll,
      initialBankroll: store.initialBankroll,
      bets: store.bets,
      calibration,
      firestoreConfig: store.firestoreConfig,
    });
  });

  app.post('/api/bets', (req, res) => {
    const body = req.body ?? {};
    const stakeAmount = Number(body.stakeAmount);
    const bookmakerOdds = Number(body.bookmakerOdds);
    const fairProbAtPlacement = Number(body.fairProbAtPlacement);

    if (
      !body.matchId ||
      !body.selection ||
      !body.marketCategory ||
      !Number.isFinite(stakeAmount) ||
      stakeAmount <= 0 ||
      !Number.isFinite(bookmakerOdds) ||
      bookmakerOdds <= 1.01
    ) {
      res.status(400).json({ error: 'Invalid paper bet payload' });
      return;
    }

    const store = loadStore();
    if (stakeAmount > store.bankroll) {
      res.status(400).json({ error: 'Insufficient paper bankroll for stake' });
      return;
    }

    const bet: PaperBet = {
      id: `bet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      matchId: String(body.matchId),
      sport: body.sport || 'soccer',
      sportPath: String(body.sportPath || 'soccer/eng.1'),
      leagueName: String(body.leagueName || 'League'),
      homeTeam: String(body.homeTeam || 'Home'),
      awayTeam: String(body.awayTeam || 'Away'),
      marketCategory: body.marketCategory,
      selection: String(body.selection),
      side: body.side || 'home',
      line: body.line !== undefined ? Number(body.line) : undefined,
      stakeAmount: Math.round(stakeAmount * 100) / 100,
      bookmakerOdds: Math.round(bookmakerOdds * 100) / 100,
      fairProbAtPlacement: Number.isFinite(fairProbAtPlacement)
        ? fairProbAtPlacement
        : 0.5,
      evPctAtPlacement: Number(body.evPctAtPlacement) || 0,
      convictionAtPlacement: Number(body.convictionAtPlacement) || 50,
      oddsVerifiedLive: Boolean(body.oddsVerifiedLive),
      placedAt: new Date().toISOString(),
      status: 'pending',
      pnl: 0,
    };

    store.bankroll = Math.round((store.bankroll - bet.stakeAmount) * 100) / 100;
    store.bets.unshift(bet);
    saveStore(store);

    res.status(201).json({
      bet,
      bankroll: store.bankroll,
      bets: store.bets,
      calibration: computeCalibrationMetrics(store.bets),
    });
  });

  app.post('/api/bets/settle', async (_req, res) => {
    try {
      const store = loadStore();
      const pendingBets = store.bets.filter((b) => b.status === 'pending');
      let settledCount = 0;

      for (let i = 0; i < store.bets.length; i++) {
        const bet = store.bets[i];
        if (bet.status !== 'pending') continue;
        try {
          const m = await fetchMatchSummary(bet.matchId);
          if (m.status === 'finished') {
            const settled = settlePaperBet(bet, {
              status: m.status,
              homeScore: m.homeScore,
              awayScore: m.awayScore,
              homeLinescores: m.homeStats.linescores,
              awayLinescores: m.awayStats.linescores,
            });
            if (settled.status !== 'pending') {
              store.bets[i] = settled;
              store.bankroll =
                Math.round((store.bankroll + settled.stakeAmount + settled.pnl) * 100) / 100;
              settledCount++;
            }
          }
        } catch {
          // Skip matches unavailable on ESPN summary
        }
      }

      if (settledCount > 0) {
        saveStore(store);
      }

      res.json({
        checked: pendingBets.length,
        settledCount,
        bankroll: store.bankroll,
        bets: store.bets,
        calibration: computeCalibrationMetrics(store.bets),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Settlement failed' });
    }
  });

  app.post('/api/bets/reset', (_req, res) => {
    const store = loadStore();
    store.bankroll = 10000;
    store.initialBankroll = 10000;
    store.bets = [];
    saveStore(store);
    res.json({
      bankroll: store.bankroll,
      initialBankroll: store.initialBankroll,
      bets: [],
      calibration: computeCalibrationMetrics([]),
    });
  });

  app.delete('/api/bets/:id', (req, res) => {
    const betId = String(req.params.id);
    const store = loadStore();
    const target = store.bets.find((b) => b.id === betId);
    if (!target) {
      res.status(404).json({ error: 'Bet not found' });
      return;
    }
    if (target.status === 'pending') {
      store.bankroll = Math.round((store.bankroll + target.stakeAmount) * 100) / 100;
    }
    store.bets = store.bets.filter((b) => b.id !== betId);
    saveStore(store);
    res.json({
      bankroll: store.bankroll,
      bets: store.bets,
      calibration: computeCalibrationMetrics(store.bets),
    });
  });

  // 6. Web Push VAPID Endpoints
  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({
      publicKey: getVapidPublicKey(),
      subscribers: getSubscriptionCount(),
    });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const sub = req.body;
    if (!sub || typeof sub.endpoint !== 'string') {
      res.status(400).json({ error: 'Invalid push subscription' });
      return;
    }
    addPushSubscription(sub);
    res.json({ ok: true, subscribers: getSubscriptionCount() });
  });

  app.post('/api/push/test', async (_req, res) => {
    const result = await sendTestPush();
    res.json(result);
  });

  // Vite middleware in dev, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OmniPulse Quant server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
