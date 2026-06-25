// Breakout Retest setup detector (LONG and SHORT).
//
// Thesis: price breaks a confirmed horizontal level (a resistance zone / swing
// high for LONG, a support zone / swing low for SHORT), then PULLS BACK to
// retest that broken level from the other side and confirms it now holds —
// broken resistance becoming support (LONG) or broken support becoming
// resistance (SHORT). We enter on the confirmation candle.
//
// NO LOOKAHEAD: `detectBreakoutRetestAt(candles, n)` derives everything from
// `computeFeaturesAt(candles, n)` (which slices to `candles[0..n]`) plus a
// strictly backward scan bounded by `i <= n`. Appending future candles cannot
// change the verdict at `n` — there is a test that proves exactly this.
//
// HONEST CONFIDENCE: `confidence` is a transparent weighted sum of the actual
// boolean rule checks below — never a hand-picked constant. The per-check
// breakdown is preserved in `rawFeatures.confidenceBreakdown`.
//
// NO SYNTHETIC TARGETS: the target is the nearest real structural level beyond
// entry. If structure offers no such level, or it is too close to clear
// `minRiskReward`, the setup is REJECTED (returns null) — never fabricated.

import type { Candle, Setup } from "@/lib/types";
import { computeFeaturesAt, type FeatureOptions, type FeatureSet } from "../features";

/** A single named boolean that contributes to confidence. */
export interface ConfidenceCheck {
  name: string;
  passed: boolean;
  weight: number;
}

export interface BreakoutRetestOptions extends FeatureOptions {
  /** Minimum reward-to-risk the setup must achieve, else no setup. Default 2. */
  minRiskReward?: number;
  /** Stop buffer beyond the retest extreme, as a multiple of ATR. Default 0.25. */
  stopAtrMult?: number;
  /**
   * Minimum stop distance from entry, as a multiple of ATR. The final stop is
   * never placed closer to entry than this floor, so 1R cannot collapse into
   * market noise when the confirmation candle closes on top of the retest
   * extreme. Default 1.
   */
  minStopAtrMult?: number;
  /**
   * How decisively the breakout bar must close beyond the level, as a multiple
   * of ATR. Filters out marginal closes that barely poke through. Default 0.1.
   */
  breakoutAtrMult?: number;
  /**
   * How close (in ATR multiples) the pullback must come back to the broken
   * level to count as a "retest". Default 0.5.
   */
  retestAtrMult?: number;
  /** Bars back to scan for the breakout + retest sequence. Default 20. */
  breakoutLookback?: number;
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
  breakoutAtrMult: 0.1,
  retestAtrMult: 0.5,
  breakoutLookback: 20,
} as const;

type Dir = "LONG" | "SHORT";

/**
 * Detect a Breakout Retest at index `n`. Tries LONG (broken resistance now
 * support) first, then SHORT (broken support now resistance). Returns a full
 * `Setup` or `null` if the conditions are not met.
 */
export function detectBreakoutRetestAt(
  candles: Candle[],
  n: number,
  options: BreakoutRetestOptions = {},
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
  if (f.atr14 === null) return null; // need a volatility unit for buffers.

  return evaluate(candles, n, f, opts, "LONG") ?? evaluate(candles, n, f, opts, "SHORT");
}

function evaluate(
  candles: Candle[],
  n: number,
  f: FeatureSet,
  opts: Required<Omit<BreakoutRetestOptions, keyof FeatureOptions | "context">> & {
    context?: BreakoutRetestOptions["context"];
  },
  dir: Dir,
): Setup | null {
  const atr = f.atr14!;
  const brkBuf = atr * opts.breakoutAtrMult;
  const retestTol = atr * opts.retestAtrMult;
  const start = Math.max(1, n - opts.breakoutLookback);

  // Candidate levels: cluster mids + raw swing pivots on the breakout side.
  // For LONG we break UP through a resistance that now sits BELOW price; for
  // SHORT we break DOWN through a support that now sits ABOVE price.
  const levels = candidateLevels(f, dir);

  for (const L of levels) {
    // 1. Fresh breakout close: the most recent bar that closed decisively
    //    through L, having closed on the other side immediately before.
    const brokeAt = freshBreakout(candles, start, n, L, brkBuf, dir);
    if (brokeAt < 0) continue;

    // 2. Retest: after the break, price returned to the level. `retestExtreme`
    //    is the deepest excursion of the retest leg (low for LONG, high for
    //    SHORT) — the structural stop reference.
    const retest = retestLeg(candles, brokeAt, n, L, retestTol, dir);
    if (!retest.retested) continue;

    // 3. The level must still hold now (close back on the breakout side) with a
    //    confirmation candle.
    const held = dir === "LONG" ? f.close > L : f.close < L;
    if (!held) continue;

    const taggedNow =
      dir === "LONG" ? f.low <= L + retestTol : f.high >= L - retestTol;
    const confirmation = confirmCandle(f, dir, taggedNow);
    if (!confirmation.ok) continue;

    // 4. Geometry. Structural stop sits a buffer beyond the retest extreme; the
    //    ATR floor sits a fixed distance from entry. Take the FURTHER of the
    //    two so 1R reflects real risk, not market noise.
    const entry = f.close;
    let structuralStop: number;
    let atrFloorStop: number;
    let stopLoss: number;
    let risk: number;
    if (dir === "LONG") {
      structuralStop = retest.extreme - atr * opts.stopAtrMult;
      atrFloorStop = entry - atr * opts.minStopAtrMult;
      stopLoss = Math.min(structuralStop, atrFloorStop);
      risk = entry - stopLoss;
    } else {
      structuralStop = retest.extreme + atr * opts.stopAtrMult;
      atrFloorStop = entry + atr * opts.minStopAtrMult;
      stopLoss = Math.max(structuralStop, atrFloorStop);
      risk = stopLoss - entry;
    }
    if (risk <= 0) continue;

    // 5. Target: nearest real structure beyond entry. No synthetic fallback.
    const structuralTarget =
      dir === "LONG"
        ? nearestResistanceAbove(f, entry)
        : nearestSupportBelow(f, entry);
    if (structuralTarget === null) continue;
    const target = structuralTarget;
    const riskReward =
      dir === "LONG"
        ? (target - entry) / risk
        : (entry - target) / risk;
    if (riskReward < opts.minRiskReward) continue;

    // --- Honest confidence: weighted sum of real boolean checks. ---
    const rrQuality = riskReward >= 3;
    const levelStrength = levelTouches(f, L, retestTol, dir) >= 2;
    const ctx = opts.context ?? {};
    const goodSession = ctx.goodSession ?? false;
    const spreadOk =
      ctx.spread === undefined || ctx.maxSpread === undefined
        ? false
        : ctx.spread <= ctx.maxSpread;
    const newsClear = !(ctx.newsRisk ?? false);

    const checks: ConfidenceCheck[] = [
      { name: "breakoutConfirmed", passed: true, weight: 0.25 },
      { name: "retestHold", passed: true, weight: 0.15 },
      { name: "confirmationStrong", passed: confirmation.strong, weight: 0.15 },
      { name: "rrQuality", passed: rrQuality, weight: 0.15 },
      { name: "levelStrength", passed: levelStrength, weight: 0.1 },
      { name: "goodSession", passed: goodSession, weight: 0.1 },
      { name: "spreadOk", passed: spreadOk, weight: 0.05 },
      { name: "newsClear", passed: newsClear, weight: 0.05 },
    ];
    const totalWeight = checks.reduce((a, c) => a + c.weight, 0);
    const confidence =
      checks.reduce((a, c) => a + (c.passed ? c.weight : 0), 0) / totalWeight;

    const reasonCodes: string[] = [
      dir === "LONG" ? "BREAKOUT_UP" : "BREAKOUT_DOWN",
      "RETEST_HOLD",
    ];
    for (const p of confirmation.patterns) reasonCodes.push(p);
    if (levelStrength) reasonCodes.push("LEVEL_MULTITOUCH");
    if (rrQuality) reasonCodes.push("RR_3R_PLUS");

    const rawFeatures: Record<string, unknown> = {
      ...(f as unknown as Record<string, unknown>),
      setup: "BREAKOUT_RETEST",
      entry,
      brokenLevel: L,
      breakoutIndex: brokeAt,
      retestExtreme: retest.extreme,
      confidenceBreakdown: checks,
      structuralTarget,
      structuralStop,
      atrFloorStop,
      stopAtrFloored:
        dir === "LONG"
          ? atrFloorStop < structuralStop
          : atrFloorStop > structuralStop,
    };

    return {
      symbol: f.symbol,
      timeframe: f.timeframe,
      direction: dir,
      entryZone:
        dir === "LONG"
          ? { low: Math.min(L, entry), high: Math.max(L, entry) }
          : { low: Math.min(L, entry), high: Math.max(L, entry) },
      stopLoss,
      target,
      riskReward,
      invalidation:
        dir === "LONG"
          ? `Close below ATR-buffered stop ${round(stopLoss)} (retest low ${round(retest.extreme)}) — broken resistance ${round(L)} failed to hold as support.`
          : `Close above ATR-buffered stop ${round(stopLoss)} (retest high ${round(retest.extreme)}) — broken support ${round(L)} failed to hold as resistance.`,
      confidence,
      reasonCodes,
      rawFeatures,
    };
  }

  return null;
}

/** Levels eligible to be the broken level: structure on the breakout side. */
function candidateLevels(f: FeatureSet, dir: Dir): number[] {
  const fromZones = (dir === "LONG" ? f.resistanceZones : f.supportZones).map(
    (z) => z.mid,
  );
  const fromSwings = f.swings
    .filter((s) => (dir === "LONG" ? s.type === "HIGH" : s.type === "LOW"))
    .map((s) => s.price);
  const all = [...fromZones, ...fromSwings];
  // LONG: levels below current close (reclaimed above). SHORT: levels above it.
  const filtered = all.filter((p) =>
    dir === "LONG" ? p < f.close : p > f.close,
  );
  // Nearest to current close first — the freshest broken level.
  const sorted = filtered.sort((a, b) =>
    dir === "LONG" ? b - a : a - b,
  );
  // De-dup near-identical levels (within a tiny epsilon) preserving order.
  const out: number[] = [];
  for (const p of sorted) {
    if (!out.some((q) => Math.abs(q - p) < 1e-9)) out.push(p);
  }
  return out;
}

/**
 * The most recent index `b` in `[start..n]` where the close crossed through `L`
 * (beyond a buffer) having been on the other side at `b-1`. Returns -1 if none.
 */
function freshBreakout(
  candles: Candle[],
  start: number,
  n: number,
  L: number,
  brkBuf: number,
  dir: Dir,
): number {
  for (let b = n; b >= start; b--) {
    if (dir === "LONG") {
      if (candles[b].close > L + brkBuf && candles[b - 1].close <= L + brkBuf) {
        return b;
      }
    } else {
      if (candles[b].close < L - brkBuf && candles[b - 1].close >= L - brkBuf) {
        return b;
      }
    }
  }
  return -1;
}

/**
 * Scan the leg after the breakout for a retest of `L`. `retested` is true when
 * some bar came back within `retestTol` of the level; `extreme` is the deepest
 * excursion of that leg (lowest low for LONG, highest high for SHORT).
 */
function retestLeg(
  candles: Candle[],
  brokeAt: number,
  n: number,
  L: number,
  retestTol: number,
  dir: Dir,
): { retested: boolean; extreme: number } {
  let retested = false;
  let extreme = dir === "LONG" ? Infinity : -Infinity;
  for (let r = brokeAt + 1; r <= n; r++) {
    if (dir === "LONG") {
      if (candles[r].low <= L + retestTol) retested = true;
      if (candles[r].low < extreme) extreme = candles[r].low;
    } else {
      if (candles[r].high >= L - retestTol) retested = true;
      if (candles[r].high > extreme) extreme = candles[r].high;
    }
  }
  return { retested, extreme };
}

/** Confirmation candle that the level held. */
function confirmCandle(
  f: FeatureSet,
  dir: Dir,
  taggedNow: boolean,
): { ok: boolean; strong: boolean; patterns: string[] } {
  const patterns: string[] = [];
  if (dir === "LONG") {
    const engulf = f.patterns.includes("BULLISH_ENGULFING");
    const reject = f.patterns.includes("BULLISH_REJECTION");
    if (engulf) patterns.push("BULLISH_ENGULFING");
    if (reject) patterns.push("BULLISH_REJECTION");
    const ok = f.close > f.open && (engulf || reject || taggedNow);
    return { ok, strong: engulf || reject, patterns };
  }
  const engulf = f.patterns.includes("BEARISH_ENGULFING");
  const reject = f.patterns.includes("BEARISH_REJECTION");
  if (engulf) patterns.push("BEARISH_ENGULFING");
  if (reject) patterns.push("BEARISH_REJECTION");
  const ok = f.close < f.open && (engulf || reject || taggedNow);
  return { ok, strong: engulf || reject, patterns };
}

/** How many swing pivots formed `L` (within `tol`) — a strength proxy. */
function levelTouches(f: FeatureSet, L: number, tol: number, dir: Dir): number {
  return f.swings.filter(
    (s) =>
      (dir === "LONG" ? s.type === "HIGH" : s.type === "LOW") &&
      Math.abs(s.price - L) <= tol,
  ).length;
}

/** Lowest resistance zone whose mid sits above `entry`, else null. */
function nearestResistanceAbove(f: FeatureSet, entry: number): number | null {
  const above = f.resistanceZones
    .map((z) => z.mid)
    .filter((m) => m > entry)
    .sort((a, b) => a - b);
  return above.length ? above[0] : null;
}

/** Highest support zone whose mid sits below `entry`, else null. */
function nearestSupportBelow(f: FeatureSet, entry: number): number | null {
  const below = f.supportZones
    .map((z) => z.mid)
    .filter((m) => m < entry)
    .sort((a, b) => b - a);
  return below.length ? below[0] : null;
}

function round(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}
