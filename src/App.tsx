import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import {
  CalibrationMetrics,
  LeagueInfo,
  MatchesApiResponse,
  PaperBet,
  PureFlowPrediction,
  ScrapedMatch,
  SportFilter,
  ValueAlert,
} from './types/quant';
import { BestBetSpotlight } from './components/BestBetSpotlight';
import { SportFilterBar } from './components/SportFilterBar';
import { MatchRadarTable } from './components/MatchRadarTable';
import { MatchInspector } from './components/MatchInspector';
import { ValueAlertsView } from './components/ValueAlertsView';
import { PortfolioView } from './components/PortfolioView';
import {
  enableBrowserAndPushAlerts,
  playQuantChime,
  triggerOsNotification,
} from './utils/notifications';

type WorkspaceTab = 'radar' | 'alerts' | 'portfolio';

interface ToastMessage {
  id: string;
  title: string;
  body: string;
  tone: 'emerald' | 'sky' | 'rose';
}

const EMPTY_COUNTS: Record<SportFilter, number> = {
  all: 0,
  soccer: 0,
  basketball: 0,
  football: 0,
  hockey: 0,
  baseball: 0,
  tennis: 0,
};

const EMPTY_CALIBRATION: CalibrationMetrics = {
  totalSettled: 0,
  brierScore: 0,
  logLoss: 0,
  totalStaked: 0,
  totalPnl: 0,
  roiPct: 0,
  winRatePct: 0,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('radar');
  const [sportFilter, setSportFilter] = useState<SportFilter>('all');
  const [selectedLeague, setSelectedLeague] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'upcoming' | 'finished'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [verifiedLiveOnly, setVerifiedLiveOnly] = useState<boolean>(true);

  const [matches, setMatches] = useState<ScrapedMatch[]>([]);
  const [predictions, setPredictions] = useState<Record<string, PureFlowPrediction>>({});
  const [alerts, setAlerts] = useState<ValueAlert[]>([]);
  const [bestBet, setBestBet] = useState<ValueAlert | null>(null);
  const [sportCounts, setSportCounts] = useState<Record<SportFilter, number>>(EMPTY_COUNTS);
  const [liveCounts, setLiveCounts] = useState<Record<SportFilter, number>>(EMPTY_COUNTS);
  const [leagues, setLeagues] = useState<LeagueInfo[]>([]);

  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [detailedMatch, setDetailedMatch] = useState<ScrapedMatch | null>(null);
  const [detailedPrediction, setDetailedPrediction] = useState<PureFlowPrediction | null>(null);
  const [detailedAlerts, setDetailedAlerts] = useState<ValueAlert[]>([]);
  const [loadingDetails, setLoadingDetails] = useState<boolean>(false);

  const [loadingMatches, setLoadingMatches] = useState<boolean>(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [bankroll, setBankroll] = useState<number>(10000);
  const [initialBankroll, setInitialBankroll] = useState<number>(10000);
  const [bets, setBets] = useState<PaperBet[]>([]);
  const [calibration, setCalibration] = useState<CalibrationMetrics>(EMPTY_CALIBRATION);
  const [settling, setSettling] = useState<boolean>(false);

  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const lastBestBetKeyRef = useRef<string | null>(null);

  const pushToast = useCallback(
    (title: string, body: string, tone: ToastMessage['tone'] = 'emerald') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [{ id, title, body, tone }, ...prev].slice(0, 3));
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 6500);
    },
    []
  );

  // Load league catalog once
  useEffect(() => {
    fetch('/api/leagues')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.leagues) setLeagues(data.leagues);
      })
      .catch(() => {});
  }, []);

  // Load paper portfolio
  const loadBets = useCallback(async () => {
    try {
      const res = await fetch('/api/bets');
      if (!res.ok) return;
      const data = await res.json();
      setBankroll(data.bankroll ?? 10000);
      setInitialBankroll(data.initialBankroll ?? 10000);
      setBets(data.bets ?? []);
      setCalibration(data.calibration ?? EMPTY_CALIBRATION);
    } catch {
      // Ignore transient failure
    }
  }, []);

  useEffect(() => {
    loadBets();
  }, [loadBets]);

  // Fetch live matches & run Stage 1 / Stage 2 backend pipeline
  const loadMatches = useCallback(
    async (silent = false) => {
      if (!silent) setLoadingMatches(true);
      try {
        const params = new URLSearchParams();
        params.set('sport', sportFilter);
        if (selectedLeague !== 'all') params.set('league', selectedLeague);
        params.set('verifiedLiveOnly', String(verifiedLiveOnly));

        const res = await fetch(`/api/matches?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`Scoreboard returned HTTP ${res.status}`);
        }
        const data: MatchesApiResponse = await res.json();

        setMatches(data.matches ?? []);
        setPredictions(data.predictions ?? {});
        setAlerts(data.alerts ?? []);
        setBestBet(data.bestBet ?? null);
        setSportCounts(data.sportCounts ?? EMPTY_COUNTS);
        setLiveCounts(data.liveCounts ?? EMPTY_COUNTS);
        setErrorBanner(null);

        // Select first match if none selected or current selection missing
        setSelectedMatchId((prev) => {
          const urlId = new URLSearchParams(window.location.search).get('matchId');
          if (urlId && data.matches.some((m) => m.id === urlId)) return urlId;
          if (prev && data.matches.some((m) => m.id === prev)) return prev;
          return data.matches[0]?.id ?? null;
        });

        // Notify if a high-conviction Best Bet changed
        if (data.bestBet && data.bestBet.convictionScore >= 55) {
          const key = `${data.bestBet.matchId}:${data.bestBet.selection}`;
          if (lastBestBetKeyRef.current !== key) {
            lastBestBetKeyRef.current = key;
            const title = `#1 Best Bet · +${data.bestBet.evPct.toFixed(1)}% EV`;
            const body = `${data.bestBet.selection} @ ${data.bestBet.bookmakerOdds.toFixed(2)} (${data.bestBet.convictionScore}/100)`;
            pushToast(title, body, 'emerald');
            if (alertsEnabled) {
              playQuantChime();
              triggerOsNotification(title, body);
            }
          }
        }
      } catch (err: any) {
        setErrorBanner(err?.message || 'Failed to sync ESPN live feeds');
      } finally {
        setLoadingMatches(false);
      }
    },
    [sportFilter, selectedLeague, verifiedLiveOnly, alertsEnabled, pushToast]
  );

  useEffect(() => {
    loadMatches(false);
    const interval = setInterval(() => loadMatches(true), 20_000);
    return () => clearInterval(interval);
  }, [loadMatches]);

  // Deep Match Summary lookup when user selects a match
  const inspectMatchById = useCallback(async (matchId: string) => {
    setSelectedMatchId(matchId);
    setLoadingDetails(true);
    try {
      const res = await fetch(`/api/matches/${encodeURIComponent(matchId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.match) {
        setDetailedMatch(data.match);
        setDetailedPrediction(data.prediction ?? null);
        setDetailedAlerts(data.alerts ?? []);
      }
    } catch {
      // Keep scoreboard fallback data
    } finally {
      setLoadingDetails(false);
    }
  }, []);

  useEffect(() => {
    if (selectedMatchId) {
      inspectMatchById(selectedMatchId);
    } else {
      setDetailedMatch(null);
      setDetailedPrediction(null);
      setDetailedAlerts([]);
    }
  }, [selectedMatchId, inspectMatchById]);

  const handleSportChange = (nextSport: SportFilter) => {
    setSportFilter(nextSport);
    setSelectedLeague('all');
  };

  const handleInspectFromAlert = (matchId: string) => {
    setActiveTab('radar');
    setSelectedMatchId(matchId);
    inspectMatchById(matchId);
  };

  const handlePlacePaperBet = async (alert: ValueAlert, customStake?: number) => {
    const defaultStake = Math.max(
      10,
      Math.round(bankroll * (alert.kellyQuarterStakePct / 100) * 100) / 100
    );
    const stakeAmount = customStake && customStake > 0 ? customStake : defaultStake;

    try {
      const res = await fetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: alert.matchId,
          sport: alert.sport,
          sportPath: alert.sportPath,
          leagueName: alert.leagueName,
          homeTeam: alert.homeTeam,
          awayTeam: alert.awayTeam,
          marketCategory: alert.marketCategory,
          selection: alert.selection,
          side: alert.side,
          line: alert.line,
          stakeAmount,
          bookmakerOdds: alert.bookmakerOdds,
          fairProbAtPlacement: alert.fairProb,
          evPctAtPlacement: alert.evPct,
          convictionAtPlacement: alert.convictionScore,
          oddsVerifiedLive: alert.oddsVerifiedLive,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        pushToast('Bet Rejected', data.error || 'Could not place paper bet', 'rose');
        return;
      }
      setBankroll(data.bankroll);
      setBets(data.bets);
      setCalibration(data.calibration);
      pushToast(
        'Paper Bet Placed',
        `${alert.selection} · $${stakeAmount.toFixed(2)} @ ${alert.bookmakerOdds.toFixed(2)}`,
        'sky'
      );
    } catch {
      pushToast('Network Error', 'Unable to reach paper bet ledger', 'rose');
    }
  };

  const handleSettleAll = async () => {
    setSettling(true);
    try {
      const res = await fetch('/api/bets/settle', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setBankroll(data.bankroll);
        setBets(data.bets);
        setCalibration(data.calibration);
        pushToast(
          'Settlement Complete',
          `${data.settledCount} finished bet(s) settled.`,
          'emerald'
        );
      }
    } finally {
      setSettling(false);
    }
  };

  const handleDeleteBet = async (betId: string) => {
    const res = await fetch(`/api/bets/${encodeURIComponent(betId)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const data = await res.json();
      setBankroll(data.bankroll);
      setBets(data.bets);
      setCalibration(data.calibration);
    }
  };

  const handleResetPortfolio = async () => {
    const res = await fetch('/api/bets/reset', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      setBankroll(data.bankroll);
      setInitialBankroll(data.initialBankroll);
      setBets(data.bets);
      setCalibration(data.calibration);
      pushToast('Portfolio Reset', 'Bankroll restored to $10,000.00.', 'sky');
    }
  };

  const handleEnableAlerts = async () => {
    const res = await enableBrowserAndPushAlerts();
    setAlertsEnabled(res.permission === 'granted');
    pushToast(
      res.permission === 'granted' ? 'Alerts Armed' : 'Alerts Info',
      res.message,
      res.permission === 'granted' ? 'emerald' : 'sky'
    );
  };

  // Client-side status & search refinement
  const visibleMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return matches.filter((m) => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (!q) return true;
      return (
        m.homeTeam.toLowerCase().includes(q) ||
        m.awayTeam.toLowerCase().includes(q) ||
        m.leagueName.toLowerCase().includes(q)
      );
    });
  }, [matches, statusFilter, searchQuery]);

  const alertsByMatch = useMemo(() => {
    const grouped: Record<string, ValueAlert[]> = {};
    for (const a of alerts) {
      if (!grouped[a.matchId]) grouped[a.matchId] = [];
      grouped[a.matchId].push(a);
    }
    return grouped;
  }, [alerts]);

  const activeInspectorMatch = useMemo(() => {
    if (detailedMatch && detailedMatch.id === selectedMatchId) return detailedMatch;
    return matches.find((m) => m.id === selectedMatchId) ?? null;
  }, [detailedMatch, matches, selectedMatchId]);

  const activeInspectorPrediction = useMemo(() => {
    if (detailedMatch && detailedMatch.id === selectedMatchId && detailedPrediction) {
      return detailedPrediction;
    }
    return selectedMatchId ? predictions[selectedMatchId] ?? null : null;
  }, [detailedMatch, detailedPrediction, predictions, selectedMatchId]);

  const activeInspectorAlerts = useMemo(() => {
    if (detailedMatch && detailedMatch.id === selectedMatchId && detailedAlerts.length > 0) {
      return detailedAlerts;
    }
    return selectedMatchId ? alertsByMatch[selectedMatchId] ?? [] : [];
  }, [detailedMatch, detailedAlerts, alertsByMatch, selectedMatchId]);

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 on desktop, clean wrap on <768px */}
      <header className="border-b border-slate-800 bg-[#0D131F]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-8 gap-y-2">
          <a
            href="/"
            className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
          >
            OmniPulse Quant
          </a>

          <nav
            aria-label="Primary Navigation"
            className="order-3 md:order-2 w-full md:w-auto flex items-center gap-5 sm:gap-6 text-xs sm:text-sm font-medium overflow-x-auto"
          >
            <button
              type="button"
              onClick={() => setActiveTab('radar')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'radar'
                  ? 'border-emerald-400 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Radar
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('alerts')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'alerts'
                  ? 'border-emerald-400 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Value Alerts ({alerts.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('portfolio')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'portfolio'
                  ? 'border-emerald-400 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Portfolio &amp; Calibration
            </button>
          </nav>

          <div className="order-2 md:order-3 flex items-center shrink-0">
            <button
              type="button"
              onClick={() => loadMatches(false)}
              disabled={loadingMatches}
              className="inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loadingMatches ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh Live
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1440px] w-full mx-auto px-6 py-6 space-y-5 flex-1">
        {errorBanner && (
          <div
            role="alert"
            className="border border-rose-500/40 bg-rose-500/10 text-rose-200 rounded-lg px-4 py-3 text-xs flex items-center justify-between"
          >
            <span>{errorBanner}</span>
            <button
              type="button"
              onClick={() => loadMatches(false)}
              className="underline font-medium cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {/* Top-Level #1 Best Bet Now Spotlight on Radar and Value Alerts */}
        {(activeTab === 'radar' || activeTab === 'alerts') && (
          <BestBetSpotlight
            bestBet={bestBet}
            verifiedLiveOnly={verifiedLiveOnly}
            onInspectMatch={handleInspectFromAlert}
            onPlaceBet={(al) => handlePlacePaperBet(al)}
            onToggleVerifiedOnly={() => setVerifiedLiveOnly((v) => !v)}
            loading={loadingMatches}
          />
        )}

        {/* Sport Selector + Scoped League Filter on Radar and Value Alerts */}
        {(activeTab === 'radar' || activeTab === 'alerts') && (
          <SportFilterBar
            sportFilter={sportFilter}
            onSportChange={handleSportChange}
            sportCounts={sportCounts}
            liveCounts={liveCounts}
            leagues={leagues}
            selectedLeague={selectedLeague}
            onLeagueChange={setSelectedLeague}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            verifiedLiveOnly={verifiedLiveOnly}
            onToggleVerifiedLiveOnly={() => setVerifiedLiveOnly((v) => !v)}
            alertsEnabled={alertsEnabled}
            onEnableAlerts={handleEnableAlerts}
          />
        )}

        {activeTab === 'radar' && (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
            <div className="xl:col-span-7">
              <MatchRadarTable
                matches={visibleMatches}
                predictions={predictions}
                alertsByMatch={alertsByMatch}
                selectedMatchId={selectedMatchId}
                onSelectMatch={(id) => setSelectedMatchId(id)}
                loading={loadingMatches}
              />
            </div>

            <div className="xl:col-span-5">
              <MatchInspector
                match={activeInspectorMatch}
                prediction={activeInspectorPrediction}
                alerts={activeInspectorAlerts}
                bankroll={bankroll}
                loadingDetails={loadingDetails}
                onPlaceBet={handlePlacePaperBet}
              />
            </div>
          </div>
        )}

        {activeTab === 'alerts' && (
          <ValueAlertsView
            alerts={alerts}
            verifiedLiveOnly={verifiedLiveOnly}
            onToggleVerifiedOnly={() => setVerifiedLiveOnly((v) => !v)}
            onInspectMatch={handleInspectFromAlert}
            onPlaceBet={(al) => handlePlacePaperBet(al)}
          />
        )}

        {activeTab === 'portfolio' && (
          <PortfolioView
            bankroll={bankroll}
            initialBankroll={initialBankroll}
            bets={bets}
            calibration={calibration}
            settling={settling}
            onSettleAll={handleSettleAll}
            onDeleteBet={handleDeleteBet}
            onResetPortfolio={handleResetPortfolio}
          />
        )}
      </main>

      {/* In-App Toast Stack */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 space-y-2 w-80 max-w-[calc(100vw-2rem)]"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className="border border-slate-700 bg-[#111827] rounded-lg px-4 py-3 shadow-lg flex items-start justify-between gap-3"
            >
              <div>
                <div
                  className={`text-xs font-semibold ${
                    t.tone === 'emerald'
                      ? 'text-emerald-400'
                      : t.tone === 'rose'
                        ? 'text-rose-400'
                        : 'text-sky-400'
                  }`}
                >
                  {t.title}
                </div>
                <div className="mt-0.5 text-xs text-slate-200">{t.body}</div>
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() =>
                  setToasts((prev) => prev.filter((item) => item.id !== t.id))
                }
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
