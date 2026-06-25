// NY Reversal setup detector (LONG and SHORT) — a session-sweep reversal.
//
// Thesis: liquidity rests just beyond the prior session's extremes. Price runs
// the stops by sweeping BEYOND the prior session high/low (a new extreme past
// it), then FAILS and reverses back inside. We fade the failed sweep.
//
// SHORT: sweep ABOVE `prevSessionHigh`, then close back below it on a bearish
// confirmation candle. LONG mirrors below `prevSessionLow`.
//
// NO LOOKAHEAD: `detectNyReversalAt(candles, n)` derives everything from
// `computeFeaturesAt(candles, n)` (which slices to `candles[0..n]`) plus a
// strictly backward scan bounded by `i <= n`. Appending future candles cannot
// change the verdict at `n` — there is a test that proves exactly this.
//
// HONEST CONFIDENCE: `confidence` is a transparent weighted sum of the actual
// boolean rule checks below — never a hand-picked constant. The per-check
// breakdown is preserved in `rawFeatures.confidenceBreakdown`.
//
// NO SYNTHETIC TARGETS: the target is the nearest real structure beyond entry
// (toward the opposite session extreme). If none clears `minRiskReward`, the
// setup is REJECTED (returns null) — never fabricated.

import type { Candle, Setup } from "@/lib/types";
import { computeFeaturesAt, type FeatureOptions, type FeatureSet } from "../features";

/** A single named boolean that contributes to confidence. */
export interface ConfidenceCheck {
  name: string;
  passed: boolean;
  weight: number;
}

export interface NyReversalOptions extends FeatureOptions {
  /** Minimum reward-to-risk the setup must achieve, else no setup. Default 2. */
  minRiskReward?: number;
  /** Stop buffer beyond the sweep extreme, as a multiple of ATR. Default 0.25. */
  stopAtrMult?: number;
  /**
   * Minimum stop distance from entry, as a multiple of ATR. The final stop is
   * never placed closer to entry than this floor, so 1R cannot collapse into
   * market noise when the reversal candle closes near the swept level. Default 1.
   */
  minStopAtrMult?: number;
  /**
   * Minimum distance the sweep must exceed the level by, as a multiple of ATR,
   * to count as a genuine stop run. Default 0 (any new extreme beyond it).
   */
  sweepAtrMult?: number;
  /** Bars back to scan for the sweep that the current bar is reversing. Default 12. */
  sweepLookback?: number;
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
  minStopAtrMult: 1,
  sweepAtrMult: 0,
  sweepLookback: 12,
} as const;

type Dir = "LONG" | "SHORT";

/**
 * Detect an NY Reversal at index `n`. Tries SHORT (failed sweep of the prior
 * session high) first, then LONG (failed sweep of the prior session low).
 * Returns a full `Setup` or `null` if the conditions are not met.
 */
export function detectNyReversalAt(
  candles: Candle[],
  n: number,
  options: NyReversalOptions = {},
  /**
   * Optional precomputed feature set for bar `n` (see `precomputeFeatures`). If
   * omitted it is computed fresh here — so live callers are unchanged. The
   * backtester passes it to avoid recomputing features per bar. It MUST equal
   * `computeFeaturesAt(candles, n, options)`; an explicit `null` means "no
   * feature at this bar" and yields no setup, exactly as a fresh compute would.
   */
  feature?: FeatureSet | null,
): Setup | null {
  const opts = { ...DEFAULTS, ...options };
  const f = feature === undefined ? computeFeaturesAt(candles, n, options) : feature;
  if (!f) return null;
  if (f.atr14 === null) return null;

  return evaluate(candles, n, f, opts, "SHORT") ?? evaluate(candles, n, f, opts, "LONG");
}

function evaluate(
  candles: Candle[],
  n: number,
  f: FeatureSet,
  opts: Required<Omit<NyReversalOptions, keyof FeatureOptions | "context">> & {
    context?: NyReversalOptions["context"];
  },
  dir: Dir,
): Setup | null {
  const atr = f.atr14!;
  // SHORT fades a sweep ABOVE the prior session high; LONG fades a sweep BELOW
  // the prior session low.
  const level = dir === "SHORT" ? f.prevSessionHigh : f.prevSessionLow;
  if (level === null) return null;

  const sweepBuf = atr * opts.sweepAtrMult;
  const start = Math.max(0, n - opts.sweepLookback);

  // 1. Sweep: over the window, price made a new extreme BEYOND the level. The
  //    sweep extreme (incl. the current bar, allowing a one-bar sweep+reversal)
  //    is the structural stop reference.
  let sweepExtreme = dir === "SHORT" ? -Infinity : Infinity;
  let swept = false;
  for (let i = start; i <= n; i++) {
    if (dir === "SHORT") {
      if (candles[i].high > level + sweepBuf) swept = true;
      if (candles[i].high > sweepExtreme) sweepExtreme = candles[i].high;
    } else {
      if (candles[i].low < level - sweepBuf) swept = true;
      if (candles[i].low < sweepExtreme) sweepExtreme = candles[i].low;
    }
  }
  if (!swept) return null;

  // 2. Reversal now: close reclaimed back INSIDE the level on a confirmation
  //    candle. (For a one-bar sweep the current bar both wicked beyond and
  //    closed back inside.)
  const reclaimed = dir === "SHORT" ? f.close < level : f.close > level;
  if (!reclaimed) return null;

  const confirmation = confirmCandle(f, dir, level);
  if (!confirmation.ok) return null;

  // 3. Geometry. Structural stop beyond the sweep extreme; ATR floor a fixed
  //    distance from entry. Take the FURTHER of the two so 1R is real risk.
  const entry = f.close;
  let structuralStop: number;
  let atrFloorStop: number;
  let stopLoss: number;
  let risk: number;
  if (dir === "SHORT") {
    structuralStop = sweepExtreme + atr * opts.stopAtrMult;
    atrFloorStop = entry + atr * opts.minStopAtrMult;
    stopLoss = Math.max(structuralStop, atrFloorStop);
    risk = stopLoss - entry;
  } else {
    structuralStop = sweepExtreme - atr * opts.stopAtrMult;
    atrFloorStop = entry - atr * opts.minStopAtrMult;
    stopLoss = Math.min(structuralStop, atrFloorStop);
    risk = entry - stopLoss;
  }
  if (risk <= 0) return null;

  // 4. Target: nearest real structure toward the opposite session extreme. The
  //    prior session's far side is itself a structural candidate. No synthetic
  //    fallback — reject if nothing clears minRiskReward.
  const structuralTarget =
    dir === "SHORT"
      ? nearestSupportBelow(f, entry)
      : nearestResistanceAbove(f, entry);
  if (structuralTarget === null) return null;
  const target = structuralTarget;
  const riskReward =
    dir === "SHORT" ? (entry - target) / risk : (target - entry) / risk;
  if (riskReward < opts.minRiskReward) return null;

  // --- Honest confidence: weighted sum of real boolean checks. ---
  const rrQuality = riskReward >= 3;
  // A meaningful stop run: the sweep poked at least 0.25 ATR beyond the level.
  const sweepDepth =
    dir === "SHORT"
      ? sweepExtreme - level >= atr * 0.25
      : level - sweepExtreme >= atr * 0.25;
  const ctx = opts.context ?? {};
  const goodSession = ctx.goodSession ?? false;
  const spreadOk =
    ctx.spread === undefined || ctx.maxSpread === undefined
      ? false
      : ctx.spread <= ctx.maxSpread;
  const newsClear = !(ctx.newsRisk ?? false);

  const checks: ConfidenceCheck[] = [
    { name: "sweptLiquidity", passed: true, weight: 0.2 },
    { name: "reversalConfirmed", passed: true, weight: 0.2 },
    { name: "strongRejection", passed: confirmation.strong, weight: 0.15 },
    { name: "rrQuality", passed: rrQuality, weight: 0.15 },
    { name: "sweepDepth", passed: sweepDepth, weight: 0.1 },
    { name: "goodSession", passed: goodSession, weight: 0.1 },
    { name: "spreadOk", passed: spreadOk, weight: 0.05 },
    { name: "newsClear", passed: newsClear, weight: 0.05 },
  ];
  const totalWeight = checks.reduce((a, c) => a + c.weight, 0);
  const confidence =
    checks.reduce((a, c) => a + (c.passed ? c.weight : 0), 0) / totalWeight;

  const reasonCodes: string[] = [
    dir === "SHORT" ? "SWEEP_HIGH" : "SWEEP_LOW",
    "REVERSAL_CONFIRM",
  ];
  for (const p of confirmation.patterns) reasonCodes.push(p);
  if (sweepDepth) reasonCodes.push("STOP_RUN");
  if (rrQuality) reasonCodes.push("RR_3R_PLUS");

  const rawFeatures: Record<string, unknown> = {
    ...(f as unknown as Record<string, unknown>),
    setup: "NY_REVERSAL",
    entry,
    sweptLevel: level,
    sweepExtreme,
    confidenceBreakdown: checks,
    structuralTarget,
    structuralStop,
    atrFloorStop,
    stopAtrFloored:
      dir === "SHORT"
        ? atrFloorStop > structuralStop
        : atrFloorStop < structuralStop,
  };

  return {
    symbol: f.symbol,
    timeframe: f.timeframe,
    direction: dir,
    entryZone: { low: Math.min(level, entry), high: Math.max(level, entry) },
    stopLoss,
    target,
    riskReward,
    invalidation:
      dir === "SHORT"
        ? `Close above ATR-buffered stop ${round(stopLoss)} (sweep high ${round(sweepExtreme)}) — the sweep of prior-session high ${round(level)} did not fail.`
        : `Close below ATR-buffered stop ${round(stopLoss)} (sweep low ${round(sweepExtreme)}) — the sweep of prior-session low ${round(level)} did not fail.`,
    confidence,
    reasonCodes,
    rawFeatures,
  };
}

/** Confirmation candle that the sweep failed and price reversed. */
function confirmCandle(
  f: FeatureSet,
  dir: Dir,
  level: number,
): { ok: boolean; strong: boolean; patterns: string[] } {
  const patterns: string[] = [];
  if (dir === "SHORT") {
    const engulf = f.patterns.includes("BEARISH_ENGULFING");
    const reject = f.patterns.includes("BEARISH_REJECTION");
    if (engulf) patterns.push("BEARISH_ENGULFING");
    if (reject) patterns.push("BEARISH_REJECTION");
    // A bar that poked above the level and closed back below is itself a
    // failed-sweep rejection, even absent a named pattern.
    const wickReject = f.high > level && f.close < level;
    const ok = f.close < f.open && (engulf || reject || wickReject);
    return { ok, strong: engulf || reject, patterns };
  }
  const engulf = f.patterns.includes("BULLISH_ENGULFING");
  const reject = f.patterns.includes("BULLISH_REJECTION");
  if (engulf) patterns.push("BULLISH_ENGULFING");
  if (reject) patterns.push("BULLISH_REJECTION");
  const wickReject = f.low < level && f.close > level;
  const ok = f.close > f.open && (engulf || reject || wickReject);
  return { ok, strong: engulf || reject, patterns };
}

/**
 * Nearest support below `entry`, including the prior session low as a real
 * structural candidate. Returns the highest such level (closest first), or null.
 */
function nearestSupportBelow(f: FeatureSet, entry: number): number | null {
  const candidates = [
    ...f.supportZones.map((z) => z.mid),
    ...(f.prevSessionLow !== null ? [f.prevSessionLow] : []),
  ].filter((m) => m < entry);
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

/**
 * Nearest resistance above `entry`, including the prior session high. Returns
 * the lowest such level (closest first), or null.
 */
function nearestResistanceAbove(f: FeatureSet, entry: number): number | null {
  const candidates = [
    ...f.resistanceZones.map((z) => z.mid),
    ...(f.prevSessionHigh !== null ? [f.prevSessionHigh] : []),
  ].filter((m) => m > entry);
  if (!candidates.length) return null;
  return Math.min(...candidates);
}

function round(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}
