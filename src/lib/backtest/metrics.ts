// Backtest analytics. Deliberately reuses the dashboard's `computeStats` so the
// backtest and the live dashboard report identical formulas for win rate, avg
// R, profit factor and max drawdown-R. We map each BacktestTrade onto the
// `PaperTrade` shape `computeStats` expects (size = 1; pnl = exit - entry, so
// rMultiple resolves to exactly +riskReward on a win and -1 on a loss), then
// add expectancy, which the dashboard does not compute.

import type { PaperTrade } from "@/lib/types";
import { computeStats, type TradeStats, type TradeRow } from "@/lib/dashboard/metrics";
import type { BacktestTrade } from "./run";

const SETUP_NAME = "TREND_PULLBACK";

export interface BacktestStats extends TradeStats {
  /**
   * Expectancy in R per trade: winRate*avgWinR + lossRate*avgLossR. With R
   * booked as +riskReward / -1 this equals avgR, but we report the decomposed
   * form (and the win/loss averages) explicitly.
   */
  expectancy: number;
  avgWinR: number;
  avgLossR: number;
  /** Trades that never hit stop or target before the data ended. */
  openUnresolved: number;
}

/** Map a resolved backtest trade onto a PaperTrade for `computeStats`. */
function toPaperTrade(t: BacktestTrade, i: number): TradeRow {
  const closed = t.outcome !== "OPEN";
  const trade: PaperTrade = {
    id: `bt-${i}`,
    symbol: "",
    direction: "LONG",
    entry: t.entry,
    stopLoss: t.stopLoss,
    target: t.target,
    size: 1,
    riskReward: t.riskReward,
    status: closed ? "CLOSED" : "OPEN",
    openedAt: t.entryTime,
    closedAt: t.exitTime,
    exitPrice: t.exitPrice,
    // pnl in price terms; with size 1, rMultiple = pnl / (entry-stop) = R.
    pnl: closed && t.exitPrice !== undefined ? t.exitPrice - t.entry : undefined,
    signalId: undefined,
  };
  return { trade, setupName: SETUP_NAME };
}

export function computeBacktestStats(trades: BacktestTrade[]): BacktestStats {
  const rows = trades.map(toPaperTrade);
  const base = computeStats(rows);

  const resolved = trades.filter((t) => t.r !== null);
  const winsR = resolved.filter((t) => (t.r ?? 0) > 0).map((t) => t.r as number);
  const lossesR = resolved.filter((t) => (t.r ?? 0) < 0).map((t) => t.r as number);

  const avgWinR = winsR.length
    ? winsR.reduce((a, b) => a + b, 0) / winsR.length
    : 0;
  const avgLossR = lossesR.length
    ? lossesR.reduce((a, b) => a + b, 0) / lossesR.length
    : 0;
  const n = resolved.length;
  const winRate = n ? winsR.length / n : 0;
  const lossRate = n ? lossesR.length / n : 0;
  const expectancy = winRate * avgWinR + lossRate * avgLossR;

  return {
    ...base,
    expectancy,
    avgWinR,
    avgLossR,
    openUnresolved: trades.filter((t) => t.outcome === "OPEN").length,
  };
}
