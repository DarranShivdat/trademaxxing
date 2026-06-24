// Trend Pullback setup detector (LONG only, the one setup this module owns).
//
// Thesis: in an established uptrend, price pulls back into the EMA20/50 band,
// then prints a bullish confirmation candle. We buy the resumption with a stop
// below the recent swing low and a target that must be at least 2R away.
//
// NO LOOKAHEAD: `detectTrendPullbackAt(candles, n)` derives everything from
// `computeFeaturesAt(candles, n)`, which itself uses only `candles[0..n]`.
// Appending future candles cannot change the verdict at `n`. There is a test
// that proves exactly this.
//
// HONEST CONFIDENCE: `confidence` is a transparent weighted sum of the actual
// boolean rule checks below — never a hand-picked constant. The per-check
// breakdown is preserved in `rawFeatures.confidenceBreakdown`.

import type { Setup } from "@/lib/types";
import { computeFeaturesAt, type FeatureOptions, type FeatureSet } from "../features";
import type { Candle } from "@/lib/types";

/** A single named boolean that contributes to confidence. */
export interface ConfidenceCheck {
  name: string;
  passed: boolean;
  weight: number;
}

export interface TrendPullbackOptions extends FeatureOptions {
  /** Minimum reward-to-risk the setup must achieve, else no setup. Default 2. */
  minRiskReward?: number;
  /** Stop buffer beyond the swing low, as a multiple of ATR. Default 0.25. */
  stopAtrMult?: number;
  /**
   * How close (in ATR multiples) the pullback low must come to EMA20/50 to
   * count as "tagged". Default 0.5.
   */
  pullbackAtrMult?: number;
  /** Bars back to scan for the pullback tag. Default 5. */
  pullbackLookback?: number;
  /** Optional execution-context flags that feed confidence honestly. */
  context?: {
    /** True when the bar falls in a preferred trading session. */
    goodSession?: boolean;
    /** Current spread in price units. */
    spread?: number;
    /** Max acceptable spread in price units. */
    maxSpread?: number;
    /** True when high-impact news risk is active. */
    newsRisk?: boolean;
  };
}

const DEFAULTS = {
  minRiskReward: 2,
  stopAtrMult: 0.25,
  pullbackAtrMult: 0.5,
  pullbackLookback: 5,
} as const;

/**
 * Detect a Trend Pullback LONG at index `n`. Returns a full `Setup` or `null`
 * if the conditions are not met (or there is insufficient history).
 */
export function detectTrendPullbackAt(
  candles: Candle[],
  n: number,
  options: TrendPullbackOptions = {},
): Setup | null {
  const opts = { ...DEFAULTS, ...options };
  const f = computeFeaturesAt(candles, n, options);
  if (!f) return null;

  // Hard gates: without these the setup type simply does not exist.
  if (
    f.ema20 === null ||
    f.ema50 === null ||
    f.ema200 === null ||
    f.atr14 === null ||
    f.lastSwingLow === null
  ) {
    return null;
  }

  // 1. Trend up: close above a properly stacked EMA50 > EMA200.
  const trendAligned =
    f.close > f.ema50 && f.ema50 > f.ema200 && f.close > f.ema200;
  if (!trendAligned) return null;

  // 2. Pullback that tagged the EMA20/50 band within the lookback window.
  const tagged = pullbackTagged(candles, n, f, opts);
  if (!tagged) return null;

  // 3. Bullish confirmation candle right now.
  const bullishConfirmation =
    f.close > f.open &&
    (f.patterns.includes("BULLISH_ENGULFING") ||
      f.patterns.includes("BULLISH_REJECTION") ||
      f.close > f.ema20);
  if (!bullishConfirmation) return null;

  // 4. Geometry: stop below the recent swing low, entry at the close.
  const entry = f.close;
  const stopLoss = f.lastSwingLow - f.atr14 * opts.stopAtrMult;
  const risk = entry - stopLoss;
  if (risk <= 0) return null; // entry must sit above the protected swing low.

  // 5. Target: the nearest structural resistance above entry. We do NOT
  //    synthesize a target — if structure offers no overhead resistance, or the
  //    nearest one is too close to clear minRiskReward, there is no setup.
  const structuralTarget = nearestResistanceAbove(f, entry);
  if (structuralTarget === null) return null;
  const target = structuralTarget;
  const riskReward = (target - entry) / risk;
  if (riskReward < opts.minRiskReward) return null;

  // --- Honest confidence: weighted sum of real boolean checks. ---
  const cleanStructure =
    f.breakOfStructure.bullish || f.patterns.includes("BULLISH_ENGULFING");
  const rrQuality = riskReward >= 3; // beyond the 2R floor.
  const ctx = opts.context ?? {};
  const goodSession = ctx.goodSession ?? false;
  const spreadOk =
    ctx.spread === undefined || ctx.maxSpread === undefined
      ? false
      : ctx.spread <= ctx.maxSpread;
  const newsClear = !(ctx.newsRisk ?? false);

  const checks: ConfidenceCheck[] = [
    { name: "trendAligned", passed: trendAligned, weight: 0.3 },
    { name: "cleanStructure", passed: cleanStructure, weight: 0.2 },
    { name: "rrQuality", passed: rrQuality, weight: 0.2 },
    { name: "goodSession", passed: goodSession, weight: 0.1 },
    { name: "spreadOk", passed: spreadOk, weight: 0.1 },
    { name: "newsClear", passed: newsClear, weight: 0.1 },
  ];
  const totalWeight = checks.reduce((a, c) => a + c.weight, 0);
  const confidence =
    checks.reduce((a, c) => a + (c.passed ? c.weight : 0), 0) / totalWeight;

  const reasonCodes: string[] = ["TREND_UP", "PULLBACK_EMA"];
  if (f.patterns.includes("BULLISH_ENGULFING")) reasonCodes.push("BULLISH_ENGULFING");
  if (f.patterns.includes("BULLISH_REJECTION")) reasonCodes.push("BULLISH_REJECTION");
  if (f.breakOfStructure.bullish) reasonCodes.push("BOS_UP");
  if (rrQuality) reasonCodes.push("RR_3R_PLUS");

  const rawFeatures: Record<string, unknown> = {
    ...(f as unknown as Record<string, unknown>),
    setup: "TREND_PULLBACK",
    entry,
    confidenceBreakdown: checks,
    structuralTarget,
  };

  return {
    symbol: f.symbol,
    timeframe: f.timeframe,
    direction: "LONG",
    entryZone: {
      low: Math.min(f.ema20, entry),
      high: Math.max(f.ema20, entry),
    },
    stopLoss,
    target,
    riskReward,
    invalidation: `Close below swing low ${round(f.lastSwingLow)} (stop ${round(stopLoss)}) or back below EMA50 ${round(f.ema50)}.`,
    confidence,
    reasonCodes,
    rawFeatures,
  };
}

/** Did price dip into the EMA20/50 band within the lookback window? */
function pullbackTagged(
  candles: Candle[],
  n: number,
  f: FeatureSet,
  opts: { pullbackAtrMult: number; pullbackLookback: number },
): boolean {
  if (f.ema20 === null || f.ema50 === null || f.atr14 === null) return false;
  const tol = f.atr14 * opts.pullbackAtrMult;
  const bandLow = Math.min(f.ema20, f.ema50) - tol;
  const bandHigh = Math.max(f.ema20, f.ema50) + tol;
  const start = Math.max(0, n - opts.pullbackLookback);
  for (let i = start; i <= n; i++) {
    // A bar "tags" the band if its low pokes into [bandLow, bandHigh].
    if (candles[i].low <= bandHigh && candles[i].low >= bandLow) return true;
    // Or it traded through the band (low below, high above).
    if (candles[i].low <= bandHigh && candles[i].high >= bandLow) return true;
  }
  return false;
}

/** Lowest resistance zone whose mid sits above `entry`, else null. */
function nearestResistanceAbove(f: FeatureSet, entry: number): number | null {
  const above = f.resistanceZones
    .map((z) => z.mid)
    .filter((m) => m > entry)
    .sort((a, b) => a - b);
  return above.length ? above[0] : null;
}

function round(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}
