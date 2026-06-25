// Feature engine. Turns a candle history into the structured feature set that
// setup detectors read and that becomes `Setup.rawFeatures`.
//
// NO LOOKAHEAD: `computeFeaturesAt(candles, n)` slices to `candles[0..n]` before
// computing anything. Every downstream value is therefore a function of the
// past and present only — appending future candles to the input cannot change
// the result at `n`.

import type { Candle } from "@/lib/types";
import {
  atr,
  ema,
  lastDefined,
  rsi,
  swingPoints,
  type SwingPoint,
} from "./indicators";

/** A horizontal support/resistance band built from clustered swing pivots. */
export interface SRZone {
  type: "SUPPORT" | "RESISTANCE";
  low: number;
  high: number;
  /** Cluster midpoint. */
  mid: number;
  /** Number of swing pivots that formed the band. */
  touches: number;
}

export type CandlePattern =
  | "BULLISH_ENGULFING"
  | "BEARISH_ENGULFING"
  | "BULLISH_REJECTION"
  | "BEARISH_REJECTION"
  | "INSIDE_BAR";

/**
 * Break of structure at the current candle: did the close break the most
 * recent confirmed swing in the opposite direction?
 */
export interface BreakOfStructure {
  bullish: boolean;
  bearish: boolean;
  /** The swing level that was broken, if any. */
  brokenLevel: number | null;
}

/** The full structured feature set computed "at" a candle. */
export interface FeatureSet {
  symbol: string;
  timeframe: Candle["timeframe"];
  index: number;
  /** Open time of the candle the features were computed at. */
  time: Date;
  // Current bar OHLC.
  open: number;
  high: number;
  low: number;
  close: number;
  // Indicator readings at the current bar (null if insufficient history).
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  atr14: number | null;
  rsi14: number | null;
  /** Confirmed swings (confirmedAt <= index), oldest first. */
  swings: SwingPoint[];
  /** Most recent confirmed swing high price, or null. */
  lastSwingHigh: number | null;
  /** Most recent confirmed swing low price, or null. */
  lastSwingLow: number | null;
  /** High/low of the previous UTC day, or null if not enough history. */
  prevSessionHigh: number | null;
  prevSessionLow: number | null;
  supportZones: SRZone[];
  resistanceZones: SRZone[];
  breakOfStructure: BreakOfStructure;
  patterns: CandlePattern[];
}

export interface FeatureOptions {
  swingLeft?: number;
  swingRight?: number;
  /** How many recent swings to cluster into S/R zones. */
  zoneLookback?: number;
  /** Cluster width as a multiple of ATR (defaults to 0.5 * ATR). */
  zoneAtrMult?: number;
}

const DEFAULTS = {
  swingLeft: 2,
  swingRight: 2,
  zoneLookback: 12,
  zoneAtrMult: 0.5,
} as const;

/**
 * Compute the full feature set at index `n`, using only `candles[0..n]`.
 * Returns `null` if `n` is out of range.
 */
export function computeFeaturesAt(
  candles: Candle[],
  n: number,
  options: FeatureOptions = {},
): FeatureSet | null {
  if (n < 0 || n >= candles.length) return null;
  const opts = { ...DEFAULTS, ...options };

  // The single line that guarantees no lookahead for everything below.
  const hist = candles.slice(0, n + 1);
  const cur = hist[hist.length - 1];
  const closes = hist.map((c) => c.close);

  const ema20 = lastDefined(ema(closes, 20));
  const ema50 = lastDefined(ema(closes, 50));
  const ema200 = lastDefined(ema(closes, 200));
  const atr14 = lastDefined(atr(hist, 14));
  const rsi14 = lastDefined(rsi(closes, 14));

  const swings = swingPoints(hist, opts.swingLeft, opts.swingRight).filter(
    (s) => s.confirmedAt <= n,
  );
  const highs = swings.filter((s) => s.type === "HIGH");
  const lows = swings.filter((s) => s.type === "LOW");
  const lastSwingHigh = highs.length ? highs[highs.length - 1].price : null;
  const lastSwingLow = lows.length ? lows[lows.length - 1].price : null;

  const { prevSessionHigh, prevSessionLow } = prevSession(hist);

  const zoneWidth =
    atr14 !== null ? atr14 * opts.zoneAtrMult : undefined;
  const resistanceZones = clusterZones(
    highs.slice(-opts.zoneLookback),
    "RESISTANCE",
    zoneWidth,
  );
  const supportZones = clusterZones(
    lows.slice(-opts.zoneLookback),
    "SUPPORT",
    zoneWidth,
  );

  const breakOfStructure = computeBOS(cur, lastSwingHigh, lastSwingLow);
  const patterns = detectPatterns(hist, hist.length - 1);

  return {
    symbol: cur.symbol,
    timeframe: cur.timeframe,
    index: n,
    time: cur.openTime,
    open: cur.open,
    high: cur.high,
    low: cur.low,
    close: cur.close,
    ema20,
    ema50,
    ema200,
    atr14,
    rsi14,
    swings,
    lastSwingHigh,
    lastSwingLow,
    prevSessionHigh,
    prevSessionLow,
    supportZones,
    resistanceZones,
    breakOfStructure,
    patterns,
  };
}

/**
 * Stream the feature set for EVERY bar in one forward pass, yielding `feature[n]`
 * for `n = 0..N-1` in order and **never holding more than the current bar's
 * feature live**. This is the streaming core both `precomputeFeatures` (which
 * collects the whole series) and the backtester (which consumes one feature,
 * uses it, and lets it be GC'd) are built on.
 *
 * `[...streamFeatures(candles, opts)][n]` is **identical** (deep-equal) to
 * `computeFeaturesAt(candles, n, opts)` for every `n` — see the equivalence
 * test in features.test.ts. The difference is cost: the per-bar function
 * re-slices and recomputes every indicator over `candles[0..n]` (O(n) per bar,
 * O(n²) over a series), while this walks the series once (≈ O(n) total) and
 * keeps only O(N) indicator arrays plus one live feature in memory — so a
 * 159k-candle run no longer materializes 159k feature sets (each with its own
 * growing `swings` snapshot) at once.
 *
 * NO LOOKAHEAD — preserved exactly:
 *  - EMA/ATR/RSI are causal recurrences; the full series value at `n` is a
 *    function of inputs `<= n` only, so `series[n]` equals the per-bar
 *    `lastDefined` over the slice (identical FP ops, identical order).
 *  - Swing pivots are revealed only when `n` reaches their `confirmedAt`
 *    (= pivot index + swingRight). A pivot that future bars would confirm stays
 *    invisible until those bars arrive — no future confirmation leaks into
 *    `feature[n]`.
 *  - S/R zones re-cluster the running *confirmed* swing window each bar, so they
 *    never include a pivot (or touch) that isn't yet knowable at `n`.
 *  - prevSession rolls UTC-day buckets forward; the "previous session" is the
 *    most recently *completed* prior day, never a day still in progress.
 *
 * Assumes `candles` is sorted ascending by `openTime` (the candle-series
 * contract) — the same assumption the per-bar `prevSession` relies on.
 */
export function* streamFeatures(
  candles: Candle[],
  options: FeatureOptions = {},
): Generator<FeatureSet | null> {
  const opts = { ...DEFAULTS, ...options };
  const N = candles.length;
  if (N === 0) return;

  const closes = candles.map((c) => c.close);
  // Full causal indicator series, computed once. series[n] === per-bar reading.
  // These are O(N) numeric arrays (~8 MB at 159k bars) — the bounded state we
  // keep for the whole walk; the per-bar FeatureSet objects are not retained.
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const atr14 = atr(candles, 14);
  const rsi14 = rsi(closes, 14);

  // Every pivot in one O(n) pass, revealed forward as each confirms. `allSwings`
  // is in pivot-index order, so `confirmedAt` is non-decreasing — a single
  // cursor suffices.
  const allSwings = swingPoints(candles, opts.swingLeft, opts.swingRight);
  let swingCursor = 0;
  const confirmed: SwingPoint[] = [];
  const confirmedHighs: SwingPoint[] = [];
  const confirmedLows: SwingPoint[] = [];
  let lastSwingHigh: number | null = null;
  let lastSwingLow: number | null = null;

  // Previous-UTC-day high/low, maintained as we cross day boundaries.
  let curDay = utcDay(candles[0].openTime);
  let curDayHi = -Infinity;
  let curDayLo = Infinity;
  let prevSessionHigh: number | null = null;
  let prevSessionLow: number | null = null;

  for (let n = 0; n < N; n++) {
    const cur = candles[n];

    // prevSession: when the day changes, the day we just finished becomes the
    // previous session; then fold the current bar into the (new) day bucket.
    const day = utcDay(cur.openTime);
    if (day !== curDay) {
      prevSessionHigh = curDayHi;
      prevSessionLow = curDayLo;
      curDay = day;
      curDayHi = -Infinity;
      curDayLo = Infinity;
    }
    if (cur.high > curDayHi) curDayHi = cur.high;
    if (cur.low < curDayLo) curDayLo = cur.low;

    // Reveal pivots that confirm at or before this bar (HIGH before LOW at a
    // tie, matching swingPoints' push order).
    while (
      swingCursor < allSwings.length &&
      allSwings[swingCursor].confirmedAt <= n
    ) {
      const s = allSwings[swingCursor];
      confirmed.push(s);
      if (s.type === "HIGH") {
        confirmedHighs.push(s);
        lastSwingHigh = s.price;
      } else {
        confirmedLows.push(s);
        lastSwingLow = s.price;
      }
      swingCursor++;
    }

    const a14 = atr14[n];
    const zoneWidth = a14 !== null ? a14 * opts.zoneAtrMult : undefined;
    const resistanceZones = clusterZones(
      confirmedHighs.slice(-opts.zoneLookback),
      "RESISTANCE",
      zoneWidth,
    );
    const supportZones = clusterZones(
      confirmedLows.slice(-opts.zoneLookback),
      "SUPPORT",
      zoneWidth,
    );

    yield {
      symbol: cur.symbol,
      timeframe: cur.timeframe,
      index: n,
      time: cur.openTime,
      open: cur.open,
      high: cur.high,
      low: cur.low,
      close: cur.close,
      ema20: ema20[n],
      ema50: ema50[n],
      ema200: ema200[n],
      atr14: a14,
      rsi14: rsi14[n],
      // Snapshot: `confirmed` keeps growing, so each bar gets its own copy. In
      // streaming use only the current bar's copy is live at a time, so this no
      // longer accumulates O(N×swings) of retained snapshots.
      swings: confirmed.slice(),
      lastSwingHigh,
      lastSwingLow,
      prevSessionHigh,
      prevSessionLow,
      supportZones,
      resistanceZones,
      breakOfStructure: computeBOS(cur, lastSwingHigh, lastSwingLow),
      patterns: detectPatterns(candles, n),
    };
  }
}

/**
 * Materialize the full feature series as an array. Convenience wrapper over
 * `streamFeatures` for callers that genuinely need random access; the result is
 * bit-identical to streaming the same `(candles, options)` by construction (it
 * is literally collected from it). Memory is O(N) feature objects — fine for
 * tests and small series, but the backtester streams instead (see run.ts) to
 * stay bounded on large series.
 *
 * `precomputeFeatures(candles, opts)[n]` deep-equals `computeFeaturesAt(candles,
 * n, opts)` for every `n` — proven by the equivalence test in features.test.ts.
 */
export function precomputeFeatures(
  candles: Candle[],
  options: FeatureOptions = {},
): (FeatureSet | null)[] {
  return Array.from(streamFeatures(candles, options));
}

/** High/low of the most recent *prior* UTC day relative to the last candle. */
function prevSession(hist: Candle[]): {
  prevSessionHigh: number | null;
  prevSessionLow: number | null;
} {
  const curDay = utcDay(hist[hist.length - 1].openTime);
  // Walk back to the first day strictly before the current candle's day.
  let prevDay: string | null = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const d = utcDay(hist[i].openTime);
    if (d !== curDay) {
      prevDay = d;
      break;
    }
  }
  if (prevDay === null) return { prevSessionHigh: null, prevSessionLow: null };

  let hi = -Infinity;
  let lo = Infinity;
  for (const c of hist) {
    if (utcDay(c.openTime) === prevDay) {
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
  }
  return { prevSessionHigh: hi, prevSessionLow: lo };
}

function utcDay(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/**
 * Cluster swing prices into bands: walk price-sorted pivots, merging any within
 * `width` of the running cluster mean into one zone.
 */
function clusterZones(
  pivots: SwingPoint[],
  type: SRZone["type"],
  width: number | undefined,
): SRZone[] {
  if (pivots.length === 0 || width === undefined || width <= 0) return [];
  const prices = pivots.map((p) => p.price).sort((a, b) => a - b);

  const zones: SRZone[] = [];
  let bucket: number[] = [prices[0]];
  const flush = () => {
    const low = Math.min(...bucket);
    const high = Math.max(...bucket);
    zones.push({
      type,
      low,
      high,
      mid: (low + high) / 2,
      touches: bucket.length,
    });
  };
  for (let i = 1; i < prices.length; i++) {
    const mean = bucket.reduce((a, b) => a + b, 0) / bucket.length;
    if (Math.abs(prices[i] - mean) <= width) {
      bucket.push(prices[i]);
    } else {
      flush();
      bucket = [prices[i]];
    }
  }
  flush();
  // Strongest (most-touched) zones first.
  return zones.sort((a, b) => b.touches - a.touches);
}

function computeBOS(
  cur: Candle,
  lastSwingHigh: number | null,
  lastSwingLow: number | null,
): BreakOfStructure {
  const bullish = lastSwingHigh !== null && cur.close > lastSwingHigh;
  const bearish = lastSwingLow !== null && cur.close < lastSwingLow;
  const brokenLevel = bullish
    ? lastSwingHigh
    : bearish
      ? lastSwingLow
      : null;
  return { bullish, bearish, brokenLevel };
}

/** Patterns at candle `n` of `candles` (uses the current and prior bar). */
function detectPatterns(candles: Candle[], n: number): CandlePattern[] {
  const out: CandlePattern[] = [];
  const cur = candles[n];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;

  // Rejection / pin bars: one dominant wick, small body, close on the strong side.
  if (range > 0 && body <= range * 0.35) {
    if (lowerWick >= body * 2 && lowerWick > upperWick) {
      out.push("BULLISH_REJECTION");
    }
    if (upperWick >= body * 2 && upperWick > lowerWick) {
      out.push("BEARISH_REJECTION");
    }
  }

  if (n >= 1) {
    const prev = candles[n - 1];
    const curBull = cur.close > cur.open;
    const curBear = cur.close < cur.open;
    const prevBull = prev.close > prev.open;
    const prevBear = prev.close < prev.open;

    // Engulfing: current body fully covers the prior body, opposite color.
    if (
      curBull &&
      prevBear &&
      cur.close >= prev.open &&
      cur.open <= prev.close
    ) {
      out.push("BULLISH_ENGULFING");
    }
    if (
      curBear &&
      prevBull &&
      cur.open >= prev.close &&
      cur.close <= prev.open
    ) {
      out.push("BEARISH_ENGULFING");
    }

    // Inside bar: current range contained within the prior range.
    if (cur.high < prev.high && cur.low > prev.low) {
      out.push("INSIDE_BAR");
    }
  }

  return out;
}
