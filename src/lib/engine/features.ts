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
  const patterns = detectPatterns(hist);

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

/** Patterns at the last candle of `hist` (uses the current and prior bar). */
function detectPatterns(hist: Candle[]): CandlePattern[] {
  const out: CandlePattern[] = [];
  const n = hist.length - 1;
  const cur = hist[n];
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
    const prev = hist[n - 1];
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
