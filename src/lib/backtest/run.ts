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

import type { Candle, Direction, Setup } from "@/lib/types";
import { detectTrendPullbackAt } from "@/lib/engine/setups/trend-pullback";
import {
  streamFeatures,
  type FeatureOptions,
  type FeatureSet,
} from "@/lib/engine/features";
import { evaluateRisk, type RiskContext } from "@/lib/engine/risk";

export type TradeOutcome = "WIN" | "LOSS" | "OPEN";

/** One simulated trade and how it resolved. R is signed: +riskReward / -1. */
export interface BacktestTrade {
  /** Trade direction from the setup. Stop/target geometry depends on it. */
  direction: Direction;
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
  /**
   * The detector to backtest. MUST honor no-lookahead: it may only read
   * candles[0..n] (every engine detector does, by slicing internally). Default
   * `detectTrendPullbackAt` — so existing callers and tests are unchanged. Pass
   * another setup's detector to validate it under the same simulation.
   *
   * `feature` is the precomputed feature set for bar `n` (see `featureOptions`).
   * Forward it to the engine detector to skip per-bar feature recomputation; a
   * detector that ignores it still recomputes fresh and stays correct, just
   * slower.
   */
  detect?: (
    candles: Candle[],
    n: number,
    feature?: FeatureSet | null,
  ) => Setup | null;
  /**
   * Feature options used to precompute the shared feature series fed to
   * `detect`. MUST match the FeatureOptions the detector reads (every engine
   * detector uses the defaults), or the fed feature would not equal what the
   * detector would compute itself. Default `{}` (engine defaults).
   */
  featureOptions?: FeatureOptions;
  /**
   * ENTRY-ELIGIBILITY WINDOW (out-of-sample validation). When set, a detected
   * setup only becomes a trade if its entry bar's `openTime` falls within
   * [from, to] (each bound inclusive; null/undefined = unbounded on that side).
   *
   * This does NOT slice the candle history. The engine still sees the FULL
   * series, so indicators warm up exactly as they would live (no cold-start
   * artifact at the window's left edge), and `detect` is still called on EVERY
   * bar — so stateful scanners keep correct incremental state. The window is a
   * gate applied AFTER detection: it only governs which bars may OPEN a trade.
   * No-lookahead is untouched — detection at bar n still only sees candles[0..n].
   *
   * A trade opened near the window's end resolves naturally on subsequent real
   * bars (the trade playing out, not lookahead); the entry decision — made from
   * past bars only — is what assigns the trade to this window.
   *
   * Both unset (the default) ⇒ every bar is eligible ⇒ byte-identical to the
   * un-windowed backtest.
   */
  from?: Date | null;
  to?: Date | null;
}

/** Entry-window test: is `t` within [from, to]? Unset bounds are unbounded. */
function withinWindow(t: Date, from?: Date | null, to?: Date | null): boolean {
  if (from && t < from) return false;
  if (to && t > to) return false;
  return true;
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
 * Simulate a single trade (LONG or SHORT) forward from its entry bar.
 *
 * Entry fill is the close of `entryIndex` (the confirmation candle) — exactly
 * the engine's internal entry, so risk = |entry-stop| is 1R and reward is the
 * setup's riskReward. We scan from entryIndex+1 (no same-bar resolution) and
 * exit on the FIRST candle to touch stop or target.
 *
 * DIRECTION: for a LONG the stop sits BELOW entry and the target ABOVE, so we
 * detect them with `low <= stopLoss` / `high >= target`. For a SHORT it is the
 * mirror — stop ABOVE, target BELOW — so we test `high >= stopLoss` /
 * `low <= target`. Outcome→R is unchanged (stop = LOSS −1, target = WIN
 * +riskReward); only which price the bar must reach flips.
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
  const { direction, stopLoss, target, riskReward, confidence } = setup;
  const isLong = direction === "LONG";

  const base: BacktestTrade = {
    direction,
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
    const hitStop = isLong ? c.low <= stopLoss : c.high >= stopLoss;
    const hitTarget = isLong ? c.high >= target : c.low <= target;

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
  // Default detector: forward the precomputed feature into its 4th param (not
  // its `options` param, which is the 3rd).
  const detect =
    options.detect ?? ((c, n, f) => detectTrendPullbackAt(c, n, {}, f));

  // Stream the feature series incrementally (no lookahead) instead of
  // recomputing the full feature set per bar inside the detector. We consume
  // feature[n], detect with it, and let it be GC'd — never holding all N live
  // (which OOMs on large series; each feature carries a growing `swings`
  // snapshot). feature[n] is identical to the materialized
  // precomputeFeatures(candles, featureOptions)[n] (same code path) and to
  // computeFeaturesAt(candles, n, featureOptions) — see the equivalence tests —
  // so detection and results are bit-identical, only bounded in memory.
  const features = streamFeatures(candles, options.featureOptions ?? {});

  const trades: BacktestTrade[] = [];
  let detected = 0;
  let approved = 0;
  let rejectedByRisk = 0;
  let skippedWhileInTrade = 0;
  // Bar index through which a position is held; new entries blocked until then.
  let openUntil = -1;

  let n = -1;
  for (const feature of features) {
    n++;
    // DETECTION — only ever sees [0..n] (enforced inside the engine). The
    // streamed feature[n] is itself a function of candles[0..n] only, and is
    // yielded in index order so it lines up with bar `n`. We detect on EVERY
    // bar (even outside the entry window) so stateful scanners stay correct.
    const setup = detect(candles, n, feature);
    if (!setup) continue;
    // ENTRY-ELIGIBILITY WINDOW: a setup outside [from, to] cannot open a trade.
    // Applied AFTER detection, so warmup, scanner state and no-lookahead are all
    // untouched — see BacktestOptions.from/to. Unset ⇒ always eligible.
    if (!withinWindow(candles[n].openTime, options.from, options.to)) continue;
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
