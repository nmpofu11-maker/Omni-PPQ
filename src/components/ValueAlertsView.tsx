import React, { useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { ValueAlert } from '../types/quant';

interface ValueAlertsViewProps {
  alerts: ValueAlert[];
  verifiedLiveOnly: boolean;
  onToggleVerifiedOnly: () => void;
  onInspectMatch: (matchId: string) => void;
  onPlaceBet: (alert: ValueAlert) => void;
}

const QUALITY_LABELS: Record<ValueAlert['dataQuality'], string> = {
  play_by_play_boxscore: 'Play-by-Play + Box',
  live_boxscore: 'Live Boxscore',
  record_prior: 'Record Prior',
};

export const ValueAlertsView: React.FC<ValueAlertsViewProps> = ({
  alerts,
  verifiedLiveOnly,
  onToggleVerifiedOnly,
  onInspectMatch,
  onPlaceBet,
}) => {
  const [minEv, setMinEv] = useState<number>(1.5);

  const visible = alerts.filter((a) => a.evPct >= minEv);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-800 bg-[#111827] rounded-lg px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Ranked +EV Opportunities Across All Sports
          </h2>
          <p className="text-xs text-slate-400">
            Sorted by Conviction Score (0–100) weighting EV magnitude, telemetry depth, odds verification, and Quarter-Kelly consistency.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <span>Min EV %</span>
            <input
              type="number"
              min="0"
              max="25"
              step="0.5"
              value={minEv}
              onChange={(e) => setMinEv(Number.parseFloat(e.target.value) || 0)}
              className="w-16 bg-[#0B0F17] border border-slate-700 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
            />
          </label>

          <button
            type="button"
            onClick={onToggleVerifiedOnly}
            className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              verifiedLiveOnly
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40'
                : 'bg-[#0B0F17] text-slate-300 border-slate-700'
            }`}
          >
            {verifiedLiveOnly ? 'Verified Live Only: ON' : 'Verified Live Only: OFF'}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="border border-slate-800 bg-[#111827] rounded-lg p-8 text-center">
          <p className="text-sm font-medium text-slate-200">
            No value alerts match the current filter.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {verifiedLiveOnly
              ? 'Try lowering the minimum EV threshold or including Pre-Match / Closing bookmaker prices.'
              : 'Wait for live play-by-play and odds updates from ESPN.'}
          </p>
        </div>
      ) : (
        <div className="border border-slate-800 bg-[#111827] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F1624]">
                  <th className="py-2.5 px-4">Conviction</th>
                  <th className="py-2.5 px-3">Match &amp; Selection</th>
                  <th className="py-2.5 px-3">Odds Status</th>
                  <th className="py-2.5 px-3 text-right">Fair / Book</th>
                  <th className="py-2.5 px-3 text-right">+EV %</th>
                  <th className="py-2.5 px-3 text-right">¼-Kelly</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-sm">
                {visible.map((al, idx) => (
                  <tr key={al.id} className="hover:bg-slate-800/35 transition-colors">
                    <td className="py-3 px-4 whitespace-nowrap font-mono tabular-nums">
                      <span className="text-sm font-semibold text-slate-100">
                        {al.convictionScore}
                      </span>
                      <span className="text-xs text-slate-500">/100</span>
                      {idx === 0 && (
                        <div className="text-xs font-sans font-medium text-emerald-400">
                          #1 Rank
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-3">
                      <div className="text-xs text-slate-400">
                        <span className="capitalize text-slate-300">{al.sport}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{al.leagueName}</span>
                        <span aria-hidden="true"> · </span>
                        <span className="font-mono tabular-nums">{al.clockLabel}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{QUALITY_LABELS[al.dataQuality]}</span>
                      </div>
                      <div className="mt-0.5 font-semibold text-slate-100">
                        {al.selection}
                      </div>
                      <div className="text-xs text-slate-400">
                        {al.marketCategory} · {al.homeTeam} vs {al.awayTeam}
                      </div>
                    </td>

                    <td className="py-3 px-3 whitespace-nowrap text-xs">
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${
                          al.oddsVerifiedLive ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                        {al.oddsLabel}
                      </span>
                    </td>

                    <td className="py-3 px-3 text-right whitespace-nowrap font-mono tabular-nums text-xs text-slate-200">
                      {al.fairOdds.toFixed(2)} / {al.bookmakerOdds.toFixed(2)}
                    </td>

                    <td className="py-3 px-3 text-right whitespace-nowrap font-mono tabular-nums text-xs font-semibold text-emerald-400">
                      +{al.evPct.toFixed(1)}%
                    </td>

                    <td className="py-3 px-3 text-right whitespace-nowrap font-mono tabular-nums text-xs text-sky-400">
                      {al.kellyQuarterStakePct.toFixed(2)}%
                    </td>

                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onInspectMatch(al.matchId)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors cursor-pointer"
                        >
                          Inspect
                          <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onPlaceBet(al)}
                          className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded transition-colors cursor-pointer"
                        >
                          Bet
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
