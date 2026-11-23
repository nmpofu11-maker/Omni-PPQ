import React from 'react';
import { PureFlowPrediction, ScrapedMatch, ValueAlert } from '../types/quant';

interface MatchRadarTableProps {
  matches: ScrapedMatch[];
  predictions: Record<string, PureFlowPrediction>;
  alertsByMatch: Record<string, ValueAlert[]>;
  selectedMatchId: string | null;
  onSelectMatch: (matchId: string) => void;
  loading?: boolean;
}

const DATA_TIER_SHORT: Record<ScrapedMatch['dataQuality'], string> = {
  play_by_play_boxscore: 'PBP + Box',
  live_boxscore: 'Live Box',
  record_prior: 'Record Prior',
};

export const MatchRadarTable: React.FC<MatchRadarTableProps> = ({
  matches,
  predictions,
  alertsByMatch,
  selectedMatchId,
  onSelectMatch,
  loading,
}) => {
  if (loading && matches.length === 0) {
    return (
      <div className="border border-slate-800 bg-[#111827] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 text-xs font-medium text-slate-400">
          Loading live multi-sport scoreboard...
        </div>
        <div className="divide-y divide-slate-800/80">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="px-4 py-3.5 flex items-center justify-between gap-4">
              <div className="h-4 w-56 bg-slate-800 rounded animate-pulse" />
              <div className="h-4 w-24 bg-slate-800 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="border border-slate-800 bg-[#111827] rounded-lg p-8 text-center">
        <p className="text-sm font-medium text-slate-200">
          No matches found for the current sport or league filter.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          ESPN scoreboard returned 0 fixtures for this selection right now. Try switching to All Sports or selecting another league.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-slate-800 bg-[#111827] rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F1624]">
              <th className="py-2.5 px-4">Matchup &amp; Sport</th>
              <th className="py-2.5 px-3">Clock</th>
              <th className="py-2.5 px-3 text-right">Score</th>
              <th className="py-2.5 px-3 text-right">Fair Win %</th>
              <th className="py-2.5 px-3 text-right whitespace-nowrap">Top +EV</th>
              <th className="py-2.5 px-4 text-right whitespace-nowrap">Telemetry</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 text-sm">
            {matches.map((m) => {
              const pred = predictions[m.id];
              const topAlert = alertsByMatch[m.id]?.[0];
              const selected = selectedMatchId === m.id;
              const homePct = pred ? Math.round(pred.fairProbs.homeWin * 100) : 50;
              const awayPct = pred ? Math.round(pred.fairProbs.awayWin * 100) : 50;

              return (
                <tr
                  key={m.id}
                  onClick={() => onSelectMatch(m.id)}
                  className={`transition-colors cursor-pointer ${
                    selected
                      ? 'bg-slate-800/75'
                      : 'hover:bg-slate-800/40'
                  }`}
                >
                  <td className="py-3 px-4">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectMatch(m.id);
                      }}
                      className="text-left w-full focus:outline-none focus-visible:underline cursor-pointer"
                    >
                      <div className="flex items-center gap-1.5 text-xs text-slate-400">
                        <span className="capitalize text-slate-300 font-medium">
                          {m.sport}
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span className="truncate max-w-[180px]">{m.leagueName}</span>
                        {m.bbcVerifiedScore && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span className="text-sky-400">BBC Verified</span>
                          </>
                        )}
                      </div>
                      <div className="mt-0.5 font-medium text-slate-100 leading-snug">
                        <span>{m.homeTeam}</span>
                        {m.homeRecord && (
                          <span className="ml-1.5 text-xs font-mono tabular-nums text-slate-400">
                            {' '}({m.homeRecord})
                          </span>
                        )}
                        <span className="mx-1.5 text-slate-500"> vs </span>
                        <span>{m.awayTeam}</span>
                        {m.awayRecord && (
                          <span className="ml-1.5 text-xs font-mono tabular-nums text-slate-400">
                            {' '}({m.awayRecord})
                          </span>
                        )}
                      </div>
                    </button>
                  </td>

                  <td className="py-3 px-3 whitespace-nowrap">
                    <span
                      className={`font-mono tabular-nums text-xs font-medium ${
                        m.status === 'live'
                          ? 'text-emerald-400'
                          : m.status === 'finished'
                            ? 'text-slate-400'
                            : 'text-sky-300'
                      }`}
                    >
                      {m.status === 'live' ? `Live · ${m.clockLabel}` : m.clockLabel}
                    </span>
                  </td>

                  <td className="py-3 px-3 text-right whitespace-nowrap font-mono tabular-nums font-semibold text-slate-100">
                    {m.status === 'upcoming'
                      ? '—'
                      : `${m.homeScore} - ${m.awayScore}`}
                  </td>

                  <td className="py-3 px-3 text-right whitespace-nowrap font-mono tabular-nums text-xs text-slate-300">
                    {homePct}% / {awayPct}%
                  </td>

                  <td className="py-3 px-3 text-right whitespace-nowrap font-mono tabular-nums text-xs">
                    {topAlert ? (
                      <span
                        className={
                          topAlert.oddsVerifiedLive
                            ? 'text-emerald-400 font-semibold'
                            : 'text-amber-300 font-medium'
                        }
                      >
                        +{topAlert.evPct.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>

                  <td className="py-3 px-4 text-right whitespace-nowrap text-xs text-slate-400">
                    {DATA_TIER_SHORT[m.dataQuality]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
