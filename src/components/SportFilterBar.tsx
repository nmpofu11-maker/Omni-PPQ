import React from 'react';
import { Bell, Search } from 'lucide-react';
import { LeagueInfo, SportFilter } from '../types/quant';

interface SportFilterBarProps {
  sportFilter: SportFilter;
  onSportChange: (sport: SportFilter) => void;
  sportCounts: Record<SportFilter, number>;
  liveCounts: Record<SportFilter, number>;
  leagues: LeagueInfo[];
  selectedLeague: string;
  onLeagueChange: (slug: string) => void;
  statusFilter: 'all' | 'live' | 'upcoming' | 'finished';
  onStatusChange: (status: 'all' | 'live' | 'upcoming' | 'finished') => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  verifiedLiveOnly: boolean;
  onToggleVerifiedLiveOnly: () => void;
  alertsEnabled: boolean;
  onEnableAlerts: () => void;
}

const SPORT_TABS: Array<{ id: SportFilter; label: string }> = [
  { id: 'all', label: 'All Sports' },
  { id: 'soccer', label: 'Soccer' },
  { id: 'basketball', label: 'Basketball' },
  { id: 'football', label: 'Football' },
  { id: 'hockey', label: 'Hockey' },
  { id: 'baseball', label: 'Baseball' },
  { id: 'tennis', label: 'Tennis' },
];

export const SportFilterBar: React.FC<SportFilterBarProps> = ({
  sportFilter,
  onSportChange,
  sportCounts,
  liveCounts,
  leagues,
  selectedLeague,
  onLeagueChange,
  statusFilter,
  onStatusChange,
  searchQuery,
  onSearchChange,
  verifiedLiveOnly,
  onToggleVerifiedLiveOnly,
  alertsEnabled,
  onEnableAlerts,
}) => {
  const scopedLeagues =
    sportFilter === 'all'
      ? leagues
      : leagues.filter((l) => l.sport === sportFilter);

  return (
    <div className="space-y-3">
      {/* Sport Segmented Selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Filter by sport"
          className="flex flex-wrap items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-lg"
        >
          {SPORT_TABS.map((tab) => {
            const active = sportFilter === tab.id;
            const total = sportCounts[tab.id] ?? 0;
            const live = liveCounts[tab.id] ?? 0;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSportChange(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5 ${
                  active
                    ? 'bg-slate-800 text-slate-100 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                <span>{tab.label}</span>
                <span className="font-mono tabular-nums text-slate-400">
                  ({total})
                </span>
                {live > 0 && (
                  <span className="font-mono tabular-nums text-emerald-400">
                    {live} live
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onToggleVerifiedLiveOnly}
            aria-pressed={verifiedLiveOnly}
            className={`px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              verifiedLiveOnly
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40'
                : 'bg-[#111827] text-slate-300 border-slate-800 hover:border-slate-700'
            }`}
          >
            {verifiedLiveOnly ? 'Verified Live Odds Only' : 'All Odds (Incl. Pre-Match)'}
          </button>

          <button
            type="button"
            onClick={onEnableAlerts}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              alertsEnabled
                ? 'bg-sky-500/10 text-sky-300 border-sky-500/40'
                : 'bg-[#111827] text-slate-300 border-slate-800 hover:border-slate-700'
            }`}
          >
            <Bell className="w-3.5 h-3.5" aria-hidden="true" />
            {alertsEnabled ? 'Push & Audio Armed' : 'Arm Push Alerts'}
          </button>
        </div>
      </div>

      {/* League Scoped Dropdown + Status + Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="league-select" className="text-xs text-slate-400 whitespace-nowrap">
            League
          </label>
          <select
            id="league-select"
            value={selectedLeague}
            onChange={(e) => onLeagueChange(e.target.value)}
            className="bg-[#111827] border border-slate-800 rounded-md px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500 max-w-[260px]"
          >
            <option value="all">
              All {sportFilter === 'all' ? 'Core' : sportFilter.charAt(0).toUpperCase() + sportFilter.slice(1)} Leagues ({scopedLeagues.length} in catalog)
            </option>
            {scopedLeagues.map((lg) => (
              <option key={lg.sportPath} value={lg.slug}>
                {lg.name} ({lg.slug})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-md">
          {(['all', 'live', 'upcoming', 'finished'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => onStatusChange(st)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors capitalize whitespace-nowrap shrink-0 cursor-pointer ${
                statusFilter === st
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {st}
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search
            className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter teams or leagues..."
            aria-label="Filter teams or leagues"
            className="w-full bg-[#111827] border border-slate-800 rounded-md pl-8 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>
    </div>
  );
};
