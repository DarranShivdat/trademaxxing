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
import { detectTrendPullbackAt } from "@/lib/engine/setups/trend-pullback";
import { detectBreakoutRetestAt } from "@/lib/engine/setups/breakout-retest";
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
   */
  detect: (candles: Candle[], n: number, ctx?: DetectContext) => Setup | null;
}

/** Detection order is the order live signals are produced per bar. */
export const SETUPS: SetupDef[] = [
  {
    tag: "TREND_PULLBACK",
    slug: "trend-pullback",
    label: "Trend Pullback",
    detect: (candles, n, ctx) =>
      detectTrendPullbackAt(candles, n, ctx ? { context: ctx } : {}),
  },
  {
    tag: "BREAKOUT_RETEST",
    slug: "breakout-retest",
    label: "Breakout Retest",
    detect: (candles, n, ctx) =>
      detectBreakoutRetestAt(candles, n, ctx ? { context: ctx } : {}),
  },
  {
    tag: "NY_REVERSAL",
    slug: "ny-reversal",
    label: "NY Reversal",
    detect: (candles, n, ctx) =>
      detectNyReversalAt(candles, n, ctx ? { context: ctx } : {}),
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
