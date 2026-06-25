// Setup registry — the single list of detectors the app knows how to run.
//
// Both the live detection pipeline (`lib/pipeline/detect.ts`) and the
// backtester (`scripts/backtest*.ts`) iterate this list, so adding a setup here
// wires it into BOTH at once. We do NOT reimplement any trading logic: each
// entry just adapts a frozen engine detector to a common
// `(candles, n, ctx?) => Setup | null` shape. The engine detectors already
// self-tag via `rawFeatures.setup` ("TREND_PULLBACK" / "BREAKOUT_RETEST" /
// "NY_REVERSAL"); `tag` here mirrors that so callers have an authoritative,
// queryable label without re-parsing rawFeatures.

import type { Candle, Setup } from "@/lib/types";
import type { FeatureSet } from "@/lib/engine/features";
import { detectTrendPullbackAt } from "@/lib/engine/setups/trend-pullback";
import {
  detectBreakoutRetestAt,
  createBreakoutRetestScanner,
} from "@/lib/engine/setups/breakout-retest";
import { detectNyReversalAt } from "@/lib/engine/setups/ny-reversal";

/** Stable identifier for a setup — matches the engine's `rawFeatures.setup`. */
export type SetupTag = "TREND_PULLBACK" | "BREAKOUT_RETEST" | "NY_REVERSAL";

/**
 * Execution-context flags the detectors fold into confidence (never into the
 * pass/fail decision). Shared shape across all three engine detectors.
 */
export interface DetectContext {
  /** True when the bar falls in a preferred trading session. */
  goodSession?: boolean;
  /** Current spread in price units. */
  spread?: number;
  /** Max acceptable spread in price units. */
  maxSpread?: number;
  /** True when high-impact news risk is active. */
  newsRisk?: boolean;
}

export interface SetupDef {
  /** Machine tag, mirrors the engine's `rawFeatures.setup`. */
  tag: SetupTag;
  /** CLI slug, e.g. "trend-pullback". */
  slug: string;
  /** Human label for tables/headers. */
  label: string;
  /**
   * Run the detector at index `n`. Honors no-lookahead exactly as the engine
   * does (the underlying detector slices to candles[0..n] internally).
   *
   * `feature` is an optional precomputed feature set for bar `n` (from
   * `precomputeFeatures`) — the backtester passes it to skip per-bar
   * recomputation. Omit it (the live path) and the detector computes fresh.
   */
  detect: (
    candles: Candle[],
    n: number,
    ctx?: DetectContext,
    feature?: FeatureSet | null,
  ) => Setup | null;
  /**
   * Optional factory for a STATEFUL, forward-walking detector used by the
   * backtester to scale a setup that would otherwise scan history every bar.
   * Each call returns a fresh detector bound to one series (call it once per
   * backtest run). It emits BIT-IDENTICAL signals to `detect` at the same bar —
   * only faster — and REQUIRES the precomputed `feature` for each bar (it does
   * not recompute features). Setups without one fall back to `detect`.
   */
  makeScanner?: () => (
    candles: Candle[],
    n: number,
    feature: FeatureSet | null | undefined,
  ) => Setup | null;
}

/** Detection order is the order live signals are produced per bar. */
export const SETUPS: SetupDef[] = [
  {
    tag: "TREND_PULLBACK",
    slug: "trend-pullback",
    label: "Trend Pullback",
    detect: (candles, n, ctx, feature) =>
      detectTrendPullbackAt(candles, n, ctx ? { context: ctx } : {}, feature),
  },
  {
    tag: "BREAKOUT_RETEST",
    slug: "breakout-retest",
    label: "Breakout Retest",
    detect: (candles, n, ctx, feature) =>
      detectBreakoutRetestAt(candles, n, ctx ? { context: ctx } : {}, feature),
    // Incremental scanner for the backtester: identical signals, O(n) not O(n²).
    makeScanner: () => {
      const scanner = createBreakoutRetestScanner();
      return (candles, n, feature) => scanner.detectAt(candles, n, feature);
    },
  },
  {
    tag: "NY_REVERSAL",
    slug: "ny-reversal",
    label: "NY Reversal",
    detect: (candles, n, ctx, feature) =>
      detectNyReversalAt(candles, n, ctx ? { context: ctx } : {}, feature),
  },
];

/** Look up a setup by its CLI slug. */
export function setupBySlug(slug: string): SetupDef | undefined {
  return SETUPS.find((s) => s.slug === slug);
}

/** The setup tag stored in a Setup's rawFeatures, if recoverable. */
export function setupTagOf(setup: Setup): SetupTag | "UNKNOWN" {
  const t = (setup.rawFeatures as Record<string, unknown>)?.setup;
  if (t === "TREND_PULLBACK" || t === "BREAKOUT_RETEST" || t === "NY_REVERSAL") {
    return t;
  }
  return "UNKNOWN";
}
