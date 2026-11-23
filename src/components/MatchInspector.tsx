import React, { useMemo, useState } from 'react';
import { Activity, BarChart3, ShieldCheck } from 'lucide-react';
import {
  PureFlowPrediction,
  ScrapedMatch,
  TeamTelemetry,
  ValueAlert,
} from '../types/quant';

interface MatchInspectorProps {
  match: ScrapedMatch | null;
  prediction: PureFlowPrediction | null;
  alerts: ValueAlert[];
  bankroll: number;
  loadingDetails?: boolean;
  onPlaceBet: (alert: ValueAlert, customStake?: number) => void;
}

const DATA_TIER_LABEL: Record<ScrapedMatch['dataQuality'], string> = {
  play_by_play_boxscore: 'Play-by-Play + Boxscore',
  live_boxscore: 'Live Boxscore',
  record_prior: 'Record Prior',
};

function buildTelemetryRows(
  sport: ScrapedMatch['sport'],
  h: TeamTelemetry,
  a: TeamTelemetry
): Array<{ label: string; home: string; away: string }> {
  const fmt = (v: number | undefined, suffix = '') =>
    v !== undefined && Number.isFinite(v) ? `${v}${suffix}` : '—';

  if (sport === 'soccer') {
    return [
      { label: 'Shots on Target', home: fmt(h.shotsOnTarget), away: fmt(a.shotsOnTarget) },
      { label: 'Total Shots', home: fmt(h.shots), away: fmt(a.shots) },
      { label: 'Possession', home: fmt(h.possessionPct, '%'), away: fmt(a.possessionPct, '%') },
      { label: 'Corners', home: fmt(h.corners), away: fmt(a.corners) },
      { label: 'Yellow Cards', home: fmt(h.yellowCards), away: fmt(a.yellowCards) },
      { label: 'Red Cards', home: fmt(h.redCards), away: fmt(a.redCards) },
    ];
  }
  if (sport === 'basketball') {
    return [
      { label: 'Field Goal %', home: fmt(h.fieldGoalPct, '%'), away: fmt(a.fieldGoalPct, '%') },
      { label: '3-Point %', home: fmt(h.threePointPct, '%'), away: fmt(a.threePointPct, '%') },
      { label: 'Free Throw %', home: fmt(h.freeThrowPct, '%'), away: fmt(a.freeThrowPct, '%') },
      { label: 'Rebounds', home: fmt(h.rebounds), away: fmt(a.rebounds) },
      { label: 'Assists', home: fmt(h.assists), away: fmt(a.assists) },
      { label: 'Turnovers', home: fmt(h.turnovers), away: fmt(a.turnovers) },
      { label: 'Personal Fouls', home: fmt(h.fouls), away: fmt(a.fouls) },
    ];
  }
  if (sport === 'football') {
    const fmtTop = (sec?: number) => {
      if (sec === undefined) return '—';
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    };
    return [
      { label: 'Total Yards', home: fmt(h.totalYards), away: fmt(a.totalYards) },
      { label: 'Passing Yards', home: fmt(h.passingYards), away: fmt(a.passingYards) },
      { label: 'Rushing Yards', home: fmt(h.rushingYards), away: fmt(a.rushingYards) },
      { label: 'First Downs', home: fmt(h.firstDowns), away: fmt(a.firstDowns) },
      { label: '3rd Down %', home: fmt(h.thirdDownPct, '%'), away: fmt(a.thirdDownPct, '%') },
      { label: 'Turnovers', home: fmt(h.turnovers), away: fmt(a.turnovers) },
      { label: 'Time of Possession', home: fmtTop(h.timeOfPossessionSec), away: fmtTop(a.timeOfPossessionSec) },
    ];
  }
  if (sport === 'hockey') {
    return [
      { label: 'Shots on Goal', home: fmt(h.shotsOnTarget), away: fmt(a.shotsOnTarget) },
      { label: 'Power Play %', home: fmt(h.powerPlayPct, '%'), away: fmt(a.powerPlayPct, '%') },
      { label: 'Faceoff %', home: fmt(h.faceoffPct, '%'), away: fmt(a.faceoffPct, '%') },
      { label: 'Hits', home: fmt(h.hits), away: fmt(a.hits) },
      { label: 'Blocked Shots', home: fmt(h.blockedShots), away: fmt(a.blockedShots) },
      { label: 'Giveaways', home: fmt(h.giveaways), away: fmt(a.giveaways) },
      { label: 'Saves', home: fmt(h.saves), away: fmt(a.saves) },
    ];
  }
  if (sport === 'baseball') {
    return [
      { label: 'Hits', home: fmt(h.baseballHits), away: fmt(a.baseballHits) },
      { label: 'Batting Avg', home: fmt(h.battingAvg), away: fmt(a.battingAvg) },
      { label: 'Team ERA', home: fmt(h.era), away: fmt(a.era) },
      { label: 'Errors', home: fmt(h.errors), away: fmt(a.errors) },
      { label: 'Strikeouts (P)', home: fmt(h.strikeoutsPitching), away: fmt(a.strikeoutsPitching) },
    ];
  }

  // Tennis
  const setsCount = Math.max(h.linescores?.length ?? 0, a.linescores?.length ?? 0);
  const rows: Array<{ label: string; home: string; away: string }> = [];
  for (let i = 0; i < setsCount; i++) {
    rows.push({
      label: `Set ${i + 1} Games`,
      home: String(h.linescores?.[i] ?? 0),
      away: String(a.linescores?.[i] ?? 0),
    });
  }
  if (h.aces !== undefined || a.aces !== undefined) {
    rows.push({ label: 'Aces', home: fmt(h.aces), away: fmt(a.aces) });
  }
  if (h.doubleFaults !== undefined || a.doubleFaults !== undefined) {
    rows.push({ label: 'Double Faults', home: fmt(h.doubleFaults), away: fmt(a.doubleFaults) });
  }
  return rows.length > 0
    ? rows
    : [{ label: 'Set Score', home: 'Live Markov State', away: 'Live Markov State' }];
}

export const MatchInspector: React.FC<MatchInspectorProps> = ({
  match,
  prediction,
  alerts,
  bankroll,
  loadingDetails,
  onPlaceBet,
}) => {
  const [stakeOverride, setStakeOverride] = useState<Record<string, string>>({});

  const momentumPaths = useMemo(() => {
    if (!prediction || prediction.momentumSeries.length === 0) return null;
    const pts = prediction.momentumSeries;
    const w = 360;
    const h = 88;
    const padX = 8;
    const padY = 8;

    const toCoords = (vals: number[]) =>
      vals
        .map((v, idx) => {
          const x =
            pts.length === 1
              ? w / 2
              : padX + (idx / (pts.length - 1)) * (w - padX * 2);
          const y = h - padY - v * (h - padY * 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    return {
      w,
      h,
      homePoints: toCoords(pts.map((p) => p.homeMomentum)),
      awayPoints: toCoords(pts.map((p) => p.awayMomentum)),
    };
  }, [prediction]);

  if (!match || !prediction) {
    return (
      <aside
        aria-label="Live Match Inspector"
        className="border border-slate-800 bg-[#111827] rounded-lg p-6 text-center"
      >
        <BarChart3 className="w-6 h-6 text-slate-500 mx-auto" aria-hidden="true" />
        <h3 className="mt-3 text-sm font-semibold text-slate-200">
          Select a Match to Inspect
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          Choose any fixture from the radar to inspect Stage 1 odds-free probabilities, live telemetry, momentum flow, and Stage 2 bookmaker edges.
        </p>
      </aside>
    );
  }

  const telemetryRows = buildTelemetryRows(
    match.sport,
    match.homeStats,
    match.awayStats
  );

  return (
    <aside
      aria-label="Live Match Inspector"
      data-testid="match-inspector"
      className="border border-slate-800 bg-[#111827] rounded-lg divide-y divide-slate-800"
    >
      {/* Match Header */}
      <div className="p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="capitalize font-medium text-slate-200">
              {match.sport}
            </span>
            <span aria-hidden="true">·</span>
            <span>{match.leagueName}</span>
            <span aria-hidden="true">·</span>
            <span
              className={`font-mono tabular-nums font-medium ${
                match.status === 'live' ? 'text-emerald-400' : 'text-slate-300'
              }`}
            >
              {match.clockLabel}
            </span>
          </div>

          <span className="text-xs text-slate-400">
            {DATA_TIER_LABEL[match.dataQuality]}
            {loadingDetails ? ' · Syncing...' : ''}
          </span>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
          <div className="min-w-0">
            <div className="text-base font-semibold text-slate-100 truncate">
              {match.homeTeam}
            </div>
            <div className="text-xs font-mono tabular-nums text-slate-400">
              Home {match.homeRecord ? `· ${match.homeRecord}` : ''}
            </div>
          </div>

          <div className="px-3 py-1.5 rounded bg-[#0B0F17] border border-slate-800 font-mono tabular-nums text-xl font-bold text-slate-100 whitespace-nowrap">
            {match.status === 'upcoming'
              ? 'vs'
              : `${match.homeScore} - ${match.awayScore}`}
          </div>

          <div className="min-w-0 text-right">
            <div className="text-base font-semibold text-slate-100 truncate">
              {match.awayTeam}
            </div>
            <div className="text-xs font-mono tabular-nums text-slate-400">
              Away {match.awayRecord ? `· ${match.awayRecord}` : ''}
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400 font-mono tabular-nums">
            <span>Elapsed Progress</span>
            <span>{Math.round(match.progressPct * 100)}%</span>
          </div>
          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-400 transition-all duration-300"
              style={{ width: `${Math.round(match.progressPct * 100)}%` }}
            />
          </div>
        </div>

        {match.bbcVerifiedScore && (
          <div className="text-xs text-sky-400 font-mono tabular-nums">
            BBC Sport Cross-Check: {match.bbcVerifiedScore.homeScore} -{' '}
            {match.bbcVerifiedScore.awayScore}
            {match.bbcVerifiedScore.clock
              ? ` (${match.bbcVerifiedScore.clock})`
              : ''}
          </div>
        )}
      </div>

      {/* Stage 1: Odds-Free Fair Probability Matrix */}
      <div className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-200 tracking-wide">
            Stage 1 Fair Probability Matrix (Odds-Free)
          </h3>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            Conf {Math.round(prediction.confidence * 100)}%
          </span>
        </div>

        <div
          className={`grid divide-x divide-slate-800 border-y border-slate-800 py-2.5 ${
            prediction.fairProbs.draw !== undefined ? 'grid-cols-3' : 'grid-cols-2'
          }`}
        >
          <div className="pr-3">
            <div className="text-xs text-slate-400 truncate">{match.homeTeam}</div>
            <div className="mt-0.5 text-base font-mono tabular-nums font-semibold text-slate-100">
              {(prediction.fairProbs.homeWin * 100).toFixed(1)}%
            </div>
            <div className="text-xs font-mono tabular-nums text-slate-400">
              Fair {(1 / Math.max(0.01, prediction.fairProbs.homeWin)).toFixed(2)}
            </div>
          </div>

          {prediction.fairProbs.draw !== undefined && (
            <div className="px-3">
              <div className="text-xs text-slate-400">Draw</div>
              <div className="mt-0.5 text-base font-mono tabular-nums font-semibold text-slate-100">
                {(prediction.fairProbs.draw * 100).toFixed(1)}%
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-400">
                Fair {(1 / Math.max(0.01, prediction.fairProbs.draw)).toFixed(2)}
              </div>
            </div>
          )}

          <div className="pl-3">
            <div className="text-xs text-slate-400 truncate">{match.awayTeam}</div>
            <div className="mt-0.5 text-base font-mono tabular-nums font-semibold text-slate-100">
              {(prediction.fairProbs.awayWin * 100).toFixed(1)}%
            </div>
            <div className="text-xs font-mono tabular-nums text-slate-400">
              Fair {(1 / Math.max(0.01, prediction.fairProbs.awayWin)).toFixed(2)}
            </div>
          </div>
        </div>

        {match.sport === 'soccer' &&
          prediction.fairProbs.nextGoalHome !== undefined && (
            <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
              <span>
                Next Goal Share:{' '}
                <strong className="font-mono tabular-nums text-slate-200">
                  {(prediction.fairProbs.nextGoalHome * 100).toFixed(1)}%
                </strong>{' '}
                /{' '}
                <strong className="font-mono tabular-nums text-slate-200">
                  {((prediction.fairProbs.nextGoalAway ?? 0) * 100).toFixed(1)}%
                </strong>
              </span>
              <span className="font-mono tabular-nums">
                Exp Total: {prediction.expectedRemaining.totalMean.toFixed(2)}
              </span>
            </div>
          )}

        {/* Total & Spread Fair Distributions */}
        <div className="grid grid-cols-2 gap-4 pt-1">
          <div className="space-y-1">
            <div className="text-xs text-slate-400">Fair Over / Under</div>
            {prediction.standardLines.totalLines.slice(0, 3).map((tl) => (
              <div
                key={tl.line}
                className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-300"
              >
                <span>O/U {tl.line}</span>
                <span>
                  {(tl.overProb * 100).toFixed(0)}% / {(tl.underProb * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <div className="text-xs text-slate-400">Fair Home Spread</div>
            {prediction.standardLines.spreadLines.slice(0, 3).map((sl) => (
              <div
                key={sl.line}
                className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-300"
              >
                <span>{sl.line > 0 ? `+${sl.line}` : sl.line}</span>
                <span>
                  {(sl.homeCoverProb * 100).toFixed(0)}% / {(sl.awayCoverProb * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="text-xs text-slate-400 space-y-0.5 pt-1">
          {prediction.modelNotes.map((note, idx) => (
            <div key={idx}>{note}</div>
          ))}
        </div>
      </div>

      {/* Stage 2: Market Value Edges */}
      <div className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-200 tracking-wide">
            Stage 2 Market Value Edges
          </h3>
          {match.odds && (
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                match.odds.isLiveVerified ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              {match.odds.isLiveVerified ? 'Verified Live Odds' : 'Pre-Match / Closing'}
            </span>
          )}
        </div>

        {alerts.length === 0 ? (
          <p className="text-xs text-slate-400">
            {match.odds
              ? 'No positive-EV discrepancy found against current bookmaker lines.'
              : 'ESPN pickcenter / live odds unavailable for this fixture.'}
          </p>
        ) : (
          <div className="divide-y divide-slate-800/80 border-y border-slate-800/80">
            {alerts.slice(0, 5).map((al) => {
              const recommendedStake = Math.max(
                10,
                Math.round((bankroll * (al.kellyQuarterStakePct / 100)) * 100) / 100
              );
              const stakeVal = stakeOverride[al.id] ?? String(recommendedStake);
              return (
                <div
                  key={al.id}
                  className="py-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-100">
                        {al.selection}
                      </div>
                      <div className="text-xs text-slate-400">
                        {al.marketCategory} · Conv{' '}
                        <span className="font-mono tabular-nums text-slate-200">
                          {al.convictionScore}/100
                        </span>
                      </div>
                    </div>
                    <div className="text-right font-mono tabular-nums">
                      <div
                        className={`text-xs font-semibold ${
                          al.evPct >= 0 ? 'text-emerald-400' : 'text-slate-400'
                        }`}
                      >
                        {al.evPct >= 0 ? '+' : ''}
                        {al.evPct.toFixed(1)}% EV
                      </div>
                      <div className="text-xs text-slate-400">
                        Fair {al.fairOdds.toFixed(2)} vs {al.bookmakerOdds.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {al.evPct > 0 && (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <div className="flex items-center gap-1.5">
                        <label
                          htmlFor={`stake-${al.id}`}
                          className="text-xs text-slate-400"
                        >
                          Stake $
                        </label>
                        <input
                          id={`stake-${al.id}`}
                          type="number"
                          min="1"
                          step="1"
                          value={stakeVal}
                          onChange={(e) =>
                            setStakeOverride((prev) => ({
                              ...prev,
                              [al.id]: e.target.value,
                            }))
                          }
                          className="w-20 bg-[#0B0F17] border border-slate-700 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-100"
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          onPlaceBet(al, Number.parseFloat(stakeVal) || recommendedStake)
                        }
                        className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Place Paper Bet
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Momentum Flow Chart */}
      {momentumPaths && (
        <div className="p-5 space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              Momentum Flow
            </h3>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span className="text-emerald-400">Home</span>
              <span className="text-sky-400">Away</span>
            </div>
          </div>

          <div className="bg-[#0B0F17] border border-slate-800 rounded p-2">
            <svg
              viewBox={`0 0 ${momentumPaths.w} ${momentumPaths.h}`}
              className="w-full h-22 overflow-visible"
              role="img"
              aria-label="Home vs Away momentum flow chart"
            >
              <line
                x1="0"
                y1={momentumPaths.h / 2}
                x2={momentumPaths.w}
                y2={momentumPaths.h / 2}
                stroke="#1E293B"
                strokeDasharray="4 4"
              />
              <polyline
                fill="none"
                stroke="#38BDF8"
                strokeWidth="2"
                points={momentumPaths.awayPoints}
              />
              <polyline
                fill="none"
                stroke="#10B981"
                strokeWidth="2"
                points={momentumPaths.homePoints}
              />
            </svg>
          </div>
        </div>
      )}

      {/* Sport Telemetry Table */}
      <div className="p-5 space-y-2.5">
        <h3 className="text-xs font-semibold text-slate-200">
          Sport Boxscore Telemetry
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-1.5 text-left font-medium">Metric</th>
                <th className="py-1.5 text-right font-medium">
                  {match.homeAbbrev || 'Home'}
                </th>
                <th className="py-1.5 text-right font-medium">
                  {match.awayAbbrev || 'Away'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {telemetryRows.map((r) => (
                <tr key={r.label}>
                  <td className="py-1.5 text-slate-300">{r.label}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-slate-100">
                    {r.home}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-slate-100">
                    {r.away}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Play-by-Play Feed */}
      {match.plays.length > 0 && (
        <div className="p-5 space-y-2.5">
          <h3 className="text-xs font-semibold text-slate-200">
            Recent Play-by-Play Events ({match.plays.length})
          </h3>
          <ul className="space-y-2 max-h-52 overflow-y-auto pr-1">
            {[...match.plays].reverse().slice(0, 12).map((play) => (
              <li
                key={play.id}
                className="text-xs text-slate-300 flex items-start gap-2 border-b border-slate-800/50 pb-1.5"
              >
                <span className="font-mono tabular-nums text-slate-400 shrink-0 w-14">
                  {play.clock}
                </span>
                <span className="text-slate-200">{play.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
};
