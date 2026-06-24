// Backtest engine: walk a candle series bar by bar, detect setups with the
// EXISTING engine, and simulate each approved trade forward against real
// intrabar highs/lows. Pure — a function of (candles, options) only, no DB.
//
// THE NO-LOOKAHEAD CONTRACT (the whole point of this module):
//   Detection at bar N may only ever see candles [0..N]. We guarantee this by
//   delegating entirely to `detectTrendPullbackAt(candles, N)`, which slices to
//   [0..N] internally. We write no detector of our own and never feed the
//   detector a future-aware view. We call it exactly as live detection does —
//   full array + index — so backtest signals are identical to live signals at
//   the same index (asserted by run.test.ts).
//
//   Trade *simulation* reads candles AFTER entry — that is the trade playing
//   out, not lookahead — and is strictly separated from detection below.

import type { Candle, Setup } from "@/lib/types";
import { detectTrendPullbackAt } from "@/lib/engine/setups/trend-pullback";
import { evaluateRisk, type RiskContext } from "@/lib/engine/risk";

export type TradeOutcome = "WIN" | "LOSS" | "OPEN";

/** One simulated trade and how it resolved. R is signed: +riskReward / -1. */
export interface BacktestTrade {
  /** Index of the bar whose close we entered on. */
  entryIndex: number;
  entryTime: Date;
  /** Index of the bar that hit stop or target; undefined if never resolved. */
  exitIndex?: number;
  exitTime?: Date;
  entry: number;
  stopLoss: number;
  target: number;
  /** Reward-to-risk from the setup (the R booked on a win). */
  riskReward: number;
  outcome: TradeOutcome;
  exitPrice?: number;
  /** Realized result in R: +riskReward on a win, -1 on a loss, null while open. */
  r: number | null;
  confidence: number;
  /** Whether stop and target sat inside the same candle's range (we took stop). */
  ambiguousBar: boolean;
}

export interface BacktestOptions {
  /** Account equity for the risk engine. Default 10000. */
  accountEquity?: number;
  /** Risk per trade as percent of equity. Default 1. */
  riskPerTradePct?: number;
  /**
   * Treat a WARNING verdict as tradeable (only REJECTED blocks). Default true —
   * WARNING is a soft confidence/spread flag, not a veto, so the trade is live.
   */
  allowWarning?: boolean;
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  candlesScanned: number;
  /** Bars where the engine emitted a setup (pre-risk). */
  detected: number;
  /** Setups that passed risk and became trades. */
  approved: number;
  /** Setups the risk engine rejected. */
  rejectedByRisk: number;
  /** Approved setups skipped because a position was already open. */
  skippedWhileInTrade: number;
  trades: BacktestTrade[];
}

/**
 * Simulate a single LONG trade forward from its entry bar.
 *
 * Entry fill is the close of `entryIndex` (the confirmation candle) — exactly
 * the engine's internal entry, so risk = entry-stop is 1R and reward is the
 * setup's riskReward. We scan from entryIndex+1 (no same-bar resolution) and
 * exit on the FIRST candle to touch stop or target.
 *
 * INTRABAR RESOLUTION: if a single candle's range spans BOTH stop and target,
 * we resolve STOP first — the conservative worst case, since we cannot know the
 * intrabar path from OHLC alone. Gaps fill at the exact stop/target price
 * (slippage is not modeled).
 */
export function simulateTrade(
  candles: Candle[],
  entryIndex: number,
  setup: Setup,
): BacktestTrade {
  const entry = candles[entryIndex].close;
  const { stopLoss, target, riskReward, confidence } = setup;

  const base: BacktestTrade = {
    entryIndex,
    entryTime: candles[entryIndex].openTime,
    entry,
    stopLoss,
    target,
    riskReward,
    outcome: "OPEN",
    r: null,
    confidence,
    ambiguousBar: false,
  };

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    const hitStop = c.low <= stopLoss;
    const hitTarget = c.high >= target;

    if (hitStop && hitTarget) {
      // Range spans both — conservative: assume stop was reached first.
      return {
        ...base,
        exitIndex: i,
        exitTime: c.openTime,
        outcome: "LOSS",
        exitPrice: stopLoss,
        r: -1,
        ambiguousBar: true,
      };
    }
    if (hitStop) {
      return {
        ...base,
        exitIndex: i,
        exitTime: c.openTime,
        outcome: "LOSS",
        exitPrice: stopLoss,
        r: -1,
      };
    }
    if (hitTarget) {
      return {
        ...base,
        exitIndex: i,
        exitTime: c.openTime,
        outcome: "WIN",
        exitPrice: target,
        r: riskReward,
      };
    }
  }

  // Never resolved before the data ran out — stays OPEN, excluded from stats.
  return base;
}

/**
 * Walk the series bar by bar, detect with the existing engine, risk-gate, and
 * simulate. One position at a time: while a trade is open we keep advancing
 * bars but take no new entry (adjacent bars fire on the same move; counting
 * each as a trade would fake the sample size with correlated duplicates).
 */
export function runBacktest(
  candles: Candle[],
  options: BacktestOptions = {},
): BacktestResult {
  const accountEquity = options.accountEquity ?? 10000;
  const riskPerTradePct = options.riskPerTradePct ?? 1;
  const allowWarning = options.allowWarning ?? true;

  const trades: BacktestTrade[] = [];
  let detected = 0;
  let approved = 0;
  let rejectedByRisk = 0;
  let skippedWhileInTrade = 0;
  // Bar index through which a position is held; new entries blocked until then.
  let openUntil = -1;

  for (let n = 0; n < candles.length; n++) {
    // DETECTION — only ever sees [0..n] (enforced inside the engine).
    const setup = detectTrendPullbackAt(candles, n);
    if (!setup) continue;
    detected++;

    if (n <= openUntil) {
      skippedWhileInTrade++;
      continue;
    }

    const ctx: RiskContext = {
      accountEquity,
      riskPerTradePct,
      tradesToday: 0,
      // Portfolio-level caps don't apply to a single-instrument backtest; the
      // intrinsic gates (R/R floor, valid stop) are what matter here.
      maxTradesPerDay: Number.MAX_SAFE_INTEGER,
    };
    const decision = evaluateRisk(setup, ctx);
    const tradeable =
      decision.verdict === "APPROVED" ||
      (allowWarning && decision.verdict === "WARNING");
    if (!tradeable) {
      rejectedByRisk++;
      continue;
    }
    approved++;

    const trade = simulateTrade(candles, n, setup);
    trades.push(trade);
    // Hold until the trade resolves; if it never does, block the rest.
    openUntil = trade.exitIndex ?? candles.length;
  }

  return {
    symbol: candles[0]?.symbol ?? "",
    timeframe: candles[0]?.timeframe ?? "",
    candlesScanned: candles.length,
    detected,
    approved,
    rejectedByRisk,
    skippedWhileInTrade,
    trades,
  };
}
