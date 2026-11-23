import React from 'react';
import { ArrowUpRight, ShieldCheck, TrendingUp } from 'lucide-react';
import { ValueAlert } from '../types/quant';

interface BestBetSpotlightProps {
  bestBet: ValueAlert | null;
  verifiedLiveOnly: boolean;
  onInspectMatch: (matchId: string) => void;
  onPlaceBet: (alert: ValueAlert) => void;
  onToggleVerifiedOnly: () => void;
  loading?: boolean;
}

const QUALITY_LABELS: Record<ValueAlert['dataQuality'], string> = {
  play_by_play_boxscore: 'Play-by-Play + Boxscore',
  live_boxscore: 'Live Boxscore',
  record_prior: 'Record Prior',
};

export const BestBetSpotlight: React.FC<BestBetSpotlightProps> = ({
  bestBet,
  verifiedLiveOnly,
  onInspectMatch,
  onPlaceBet,
  onToggleVerifiedOnly,
  loading,
}) => {
  if (loading && !bestBet) {
    return (
      <section
        aria-label="Top Best Bet Spotlight"
        className="border border-slate-800 bg-[#111827] rounded-lg px-5 py-4"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2 w-full max-w-xl">
            <div className="h-3 w-40 bg-slate-800 rounded animate-pulse" />
            <div className="h-5 w-80 bg-slate-800 rounded animate-pulse" />
          </div>
          <div className="h-9 w-36 bg-slate-800 rounded animate-pulse" />
        </div>
      </section>
    );
  }

  if (!bestBet) {
    return (
      <section
        aria-label="Top Best Bet Spotlight"
        className="border border-slate-800 bg-[#111827] rounded-lg px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
      >
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <TrendingUp className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
            <span className="font-medium text-slate-300">#1 Best Bet Now</span>
            <span aria-hidden="true">·</span>
            <span>
              {verifiedLiveOnly
                ? 'Verified Live Odds Filter Active'
                : 'All Market Odds Active'}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-300">
            {verifiedLiveOnly
              ? 'No active match currently meets the minimum +EV threshold with verified live bookmaker prices.'
              : 'No qualifying +EV edges detected in the current scoreboard slate.'}
          </p>
        </div>

        {verifiedLiveOnly && (
          <button
            type="button"
            onClick={onToggleVerifiedOnly}
            className="px-4 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Include Pre-Match / Closing Odds
          </button>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label="Top Best Bet Spotlight"
      data-testid="best-bet-spotlight"
      className="border border-slate-800 bg-[#111827] rounded-lg px-5 py-4"
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-400">
            <span className="font-semibold text-emerald-400">#1 Best Bet Now</span>
            <span aria-hidden="true">·</span>
            <span className="capitalize text-slate-200 font-medium">
              {bestBet.sport}
            </span>
            <span aria-hidden="true">·</span>
            <span>{bestBet.leagueName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-slate-300">
              {bestBet.clockLabel}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={`inline-flex items-center gap-1 font-medium ${
                bestBet.oddsVerifiedLive ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              {bestBet.oddsLabel}
            </span>
            <span aria-hidden="true">·</span>
            <span>{QUALITY_LABELS[bestBet.dataQuality]}</span>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold text-slate-100 tracking-tight">
              {bestBet.selection}
            </h2>
            <span className="text-sm text-slate-400">
              {bestBet.marketCategory} · {bestBet.homeTeam} vs {bestBet.awayTeam}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-5 sm:gap-6 shrink-0">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-5 sm:text-right">
            <div>
              <div className="text-xs text-slate-400">Fair / Book</div>
              <div className="text-sm font-mono tabular-nums font-semibold text-slate-100 whitespace-nowrap">
                {bestBet.fairOdds.toFixed(2)} / {bestBet.bookmakerOdds.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Edge (+EV)</div>
              <div className="text-sm font-mono tabular-nums font-semibold text-emerald-400 whitespace-nowrap">
                +{bestBet.evPct.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">¼-Kelly Stake</div>
              <div className="text-sm font-mono tabular-nums font-semibold text-sky-400 whitespace-nowrap">
                {bestBet.kellyQuarterStakePct.toFixed(2)}%
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Conviction</div>
              <div className="text-sm font-mono tabular-nums font-semibold text-slate-100 whitespace-nowrap">
                {bestBet.convictionScore}/100
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => onInspectMatch(bestBet.matchId)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Inspect
              <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onPlaceBet(bestBet)}
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Place Paper Bet
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
