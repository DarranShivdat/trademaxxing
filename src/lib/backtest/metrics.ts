// Backtest analytics. Deliberately reuses the dashboard's `computeStats` so the
// backtest and the live dashboard report identical formulas for win rate, avg
// R, profit factor and max drawdown-R. We map each BacktestTrade onto the
// `PaperTrade` shape `computeStats` expects (size = 1; pnl = the DIRECTIONAL
// price gain — exit−entry for LONG, entry−exit for SHORT — so rMultiple
// resolves to exactly +riskReward on a win and -1 on a loss regardless of
// direction), then add expectancy, which the dashboard does not compute.
//
// The directional pnl matters: `computeStats` scores a win as `pnl > 0`. A
// SHORT that hits its stop exits ABOVE entry, so a naive `exit−entry` would be
// positive and the loss would be miscounted as a win — inverting win rate and
// avg R for every short-trading setup while the R-field path stayed correct.

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
  const directionalPnl =
    closed && t.exitPrice !== undefined
      ? t.direction === "LONG"
        ? t.exitPrice - t.entry
        : t.entry - t.exitPrice
      : undefined;
  const trade: PaperTrade = {
    id: `bt-${i}`,
    symbol: "",
    direction: t.direction,
    entry: t.entry,
    stopLoss: t.stopLoss,
    target: t.target,
    size: 1,
    riskReward: t.riskReward,
    status: closed ? "CLOSED" : "OPEN",
    openedAt: t.entryTime,
    closedAt: t.exitTime,
    exitPrice: t.exitPrice,
    // Directional price pnl; with size 1, rMultiple = pnl / |entry-stop| = R.
    pnl: directionalPnl,
    signalId: undefined,
  };
  return { trade, setupName: SETUP_NAME };
}

/**
 * Profit factor in R terms: Σ(winning R) / |Σ(losing R)|.
 *
 * The dashboard's `profitFactor` sums raw price pnl (exit−entry), which is fine
 * for ONE instrument but invalid to pool across instruments: gold moves on a
 * ~4000 price scale and EUR/USD on a ~1.0 scale, so gold trades would dominate
 * a price-weighted combined figure. R is dimensionless (+riskReward on a win,
 * −1 on a loss), so an R-based profit factor aggregates honestly across assets.
 * Used by the combined backtest table; the single-cell run keeps the price-based
 * `profitFactor` from `computeStats`.
 *
 * Note: a high win rate with reward >1R yields a legitimately large factor
 * (e.g. 80% wins at +2R ⇒ (8·2)/(2·1) = 8). That is correct, not inflated.
 */
export function profitFactorR(trades: BacktestTrade[]): number {
  const resolved = trades.filter((t) => t.r !== null);
  const grossWin = resolved
    .filter((t) => (t.r ?? 0) > 0)
    .reduce((a, t) => a + (t.r as number), 0);
  const grossLoss = Math.abs(
    resolved
      .filter((t) => (t.r ?? 0) < 0)
      .reduce((a, t) => a + (t.r as number), 0),
  );
  if (grossLoss === 0) return grossWin > 0 ? Infinity : 0;
  return grossWin / grossLoss;
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
