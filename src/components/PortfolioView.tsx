import React from 'react';
import { CheckCircle2, Download, RefreshCw, Trash2 } from 'lucide-react';
import { CalibrationMetrics, PaperBet } from '../types/quant';

interface PortfolioViewProps {
  bankroll: number;
  initialBankroll: number;
  bets: PaperBet[];
  calibration: CalibrationMetrics;
  settling: boolean;
  onSettleAll: () => void;
  onDeleteBet: (betId: string) => void;
  onResetPortfolio: () => void;
}

export const PortfolioView: React.FC<PortfolioViewProps> = ({
  bankroll,
  initialBankroll,
  bets,
  calibration,
  settling,
  onSettleAll,
  onDeleteBet,
  onResetPortfolio,
}) => {
  const pendingExposure = bets
    .filter((b) => b.status === 'pending')
    .reduce((acc, b) => acc + b.stakeAmount, 0);

  const exportLedger = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      bankroll,
      initialBankroll,
      calibration,
      bets,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omnipulse-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Calibration & Bankroll KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="border border-slate-800 bg-[#111827] rounded-lg p-4">
          <div className="text-xs text-slate-400">Available Bankroll</div>
          <div className="mt-1 text-lg font-mono tabular-nums font-semibold text-slate-100">
            ${bankroll.toFixed(2)}
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-500">
            Exposure ${pendingExposure.toFixed(2)}
          </div>
        </div>

        <div className="border border-slate-800 bg-[#111827] rounded-lg p-4">
          <div className="text-xs text-slate-400">Settled / Net PnL</div>
          <div
            className={`mt-1 text-lg font-mono tabular-nums font-semibold ${
              calibration.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {calibration.totalPnl >= 0 ? '+' : ''}${calibration.totalPnl.toFixed(2)}
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-500">
            {calibration.totalSettled} settled bets
          </div>
        </div>

        <div className="border border-slate-800 bg-[#111827] rounded-lg p-4">
          <div className="text-xs text-slate-400">Yield / ROI</div>
          <div
            className={`mt-1 text-lg font-mono tabular-nums font-semibold ${
              calibration.roiPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {calibration.roiPct >= 0 ? '+' : ''}
            {calibration.roiPct.toFixed(2)}%
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-500">
            Staked ${calibration.totalStaked.toFixed(0)}
          </div>
        </div>

        <div className="border border-slate-800 bg-[#111827] rounded-lg p-4">
          <div className="text-xs text-slate-400">Win Rate</div>
          <div className="mt-1 text-lg font-mono tabular-nums font-semibold text-slate-100">
            {calibration.winRatePct.toFixed(1)}%
          </div>
          <div className="text-xs text-slate-500">Decisive bets</div>
        </div>

        <div className="border border-slate-800 bg-[#111827] rounded-lg p-4">
          <div className="text-xs text-slate-400">Brier Score</div>
          <div className="mt-1 text-lg font-mono tabular-nums font-semibold text-sky-400">
            {calibration.totalSettled > 0
              ? calibration.brierScore.toFixed(4)
              : '—'}
          </div>
          <div className="text-xs text-slate-500">Lower is sharper (&lt;0.25)</div>
        </div>

        <div className="border border-slate-800 bg-[#111827] rounded-lg p-4">
          <div className="text-xs text-slate-400">Log Loss</div>
          <div className="mt-1 text-lg font-mono tabular-nums font-semibold text-sky-400">
            {calibration.totalSettled > 0
              ? calibration.logLoss.toFixed(4)
              : '—'}
          </div>
          <div className="text-xs text-slate-500">Probabilistic calibration</div>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-800 bg-[#111827] rounded-lg px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Multi-Sport Paper Bet Ledger &amp; Auto-Settlement
          </h2>
          <p className="text-xs text-slate-400">
            Persisted locally with full JSON ledger export and optional Firestore sync support.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onSettleAll}
            disabled={settling}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-60 rounded-md transition-colors cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${settling ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            {settling ? 'Settling...' : 'Settle Finished Matches'}
          </button>

          <button
            type="button"
            onClick={exportLedger}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export Ledger
          </button>

          <button
            type="button"
            onClick={onResetPortfolio}
            className="px-3 py-2 text-xs font-medium text-slate-400 hover:text-rose-300 bg-[#0B0F17] border border-slate-800 rounded-md transition-colors cursor-pointer"
          >
            Reset $10k
          </button>
        </div>
      </div>

      {/* Bets Table */}
      {bets.length === 0 ? (
        <div className="border border-slate-800 bg-[#111827] rounded-lg p-8 text-center">
          <CheckCircle2 className="w-6 h-6 text-slate-500 mx-auto" aria-hidden="true" />
          <p className="mt-2 text-sm font-medium text-slate-200">
            No paper bets placed yet.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Place a Quarter-Kelly paper bet from the #1 Best Bet Spotlight, Value Alerts, or Live Match Inspector to begin calibration tracking.
          </p>
        </div>
      ) : (
        <div className="border border-slate-800 bg-[#111827] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0F1624]">
                  <th className="py-2.5 px-4">Selection &amp; Market</th>
                  <th className="py-2.5 px-3 text-right">Stake</th>
                  <th className="py-2.5 px-3 text-right">Odds</th>
                  <th className="py-2.5 px-3 text-right">Fair Prob</th>
                  <th className="py-2.5 px-3 text-right">Status</th>
                  <th className="py-2.5 px-3 text-right">PnL</th>
                  <th className="py-2.5 px-4 text-right">Remove</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-sm">
                {bets.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-800/35">
                    <td className="py-3 px-4">
                      <div className="text-xs text-slate-400">
                        <span className="capitalize text-slate-300">{b.sport}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{b.leagueName}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{b.marketCategory}</span>
                      </div>
                      <div className="font-semibold text-slate-100">
                        {b.selection}
                      </div>
                      <div className="text-xs text-slate-400">
                        {b.homeTeam} vs {b.awayTeam}
                        {b.finalScore ? ` (Final ${b.finalScore})` : ''}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-right font-mono tabular-nums text-xs text-slate-200">
                      ${b.stakeAmount.toFixed(2)}
                    </td>

                    <td className="py-3 px-3 text-right font-mono tabular-nums text-xs text-slate-200">
                      {b.bookmakerOdds.toFixed(2)}
                    </td>

                    <td className="py-3 px-3 text-right font-mono tabular-nums text-xs text-slate-300">
                      {(b.fairProbAtPlacement * 100).toFixed(1)}%
                    </td>

                    <td className="py-3 px-3 text-right text-xs font-medium capitalize">
                      <span
                        className={
                          b.status === 'won'
                            ? 'text-emerald-400'
                            : b.status === 'lost'
                              ? 'text-rose-400'
                              : b.status === 'push'
                                ? 'text-amber-300'
                                : 'text-sky-400'
                        }
                      >
                        {b.status}
                      </span>
                    </td>

                    <td
                      className={`py-3 px-3 text-right font-mono tabular-nums text-xs font-semibold ${
                        b.pnl > 0
                          ? 'text-emerald-400'
                          : b.pnl < 0
                            ? 'text-rose-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {b.status === 'pending'
                        ? '—'
                        : `${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2)}`}
                    </td>

                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        aria-label={`Delete bet ${b.selection}`}
                        onClick={() => onDeleteBet(b.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 rounded transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
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
