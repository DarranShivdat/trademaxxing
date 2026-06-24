// Core technical indicators. Pure functions over price/candle arrays.
//
// NO LOOKAHEAD: every indicator here is *causal* — the value at index `i` is a
// function of inputs at indices `<= i` only. As a consequence, computing an
// indicator over `candles.slice(0, n + 1)` yields exactly the same value at `n`
// as computing it over the full array. Callers that need an "at candle N"
// reading must slice up front (see the feature/setup layers).
//
// All series outputs are aligned to the input length; positions without enough
// history to be defined are `null` (never a silently-wrong number).

import type { Candle } from "@/lib/types";

/** A confirmed swing pivot. */
export interface SwingPoint {
  type: "HIGH" | "LOW";
  /** Index of the pivot candle. */
  index: number;
  /** The pivot price (high for HIGH, low for LOW). */
  price: number;
  /**
   * Earliest index at which this pivot is *confirmed* — i.e. once `rightBars`
   * candles after the pivot exist. A pivot at index `i` with `rightBars = r`
   * is only knowable at index `i + r`. Detectors operating "at N" must ignore
   * pivots whose `confirmedAt > N` (slicing the input enforces this for free).
   */
  confirmedAt: number;
}

/** Exponential moving average, SMA-seeded. Aligned, `null` before `period`. */
export function ema(values: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error("ema: period must be > 0");
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** True range of `candles[i]` against the prior close (or H-L at i = 0). */
function trueRange(candles: Candle[], i: number): number {
  const { high, low } = candles[i];
  if (i === 0) return high - low;
  const prevClose = candles[i - 1].close;
  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose),
  );
}

/** Average True Range (Wilder smoothing). Aligned, `null` before `period`. */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error("atr: period must be > 0");
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  // First ATR = simple average of the first `period` true ranges (TR[1..period],
  // skipping TR[0] which has no prior close). Defined at index `period`.
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(candles, i);
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trueRange(candles, i)) / period;
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index (Wilder smoothing). Aligned, `null` before `period`. */
export function rsi(closes: number[], period = 14): (number | null)[] {
  if (period <= 0) throw new Error("rsi: period must be > 0");
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Swing pivots. A pivot HIGH at `i` is a high strictly greater than the highs
 * of the `leftBars` candles before and `rightBars` candles after it; a pivot
 * LOW is the symmetric minimum. Only pivots with `rightBars` candles of room
 * after them are returned, each tagged with `confirmedAt = i + rightBars`.
 *
 * Causal: a pivot is included only when its confirmation window fits inside the
 * passed array, so slicing to `[0..n]` naturally drops anything not yet knowable.
 */
export function swingPoints(
  candles: Candle[],
  leftBars = 2,
  rightBars = 2,
): SwingPoint[] {
  if (leftBars < 1 || rightBars < 1) {
    throw new Error("swingPoints: leftBars and rightBars must be >= 1");
  }
  const out: SwingPoint[] = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high >= hi) isHigh = false;
      if (candles[j].low <= lo) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      out.push({ type: "HIGH", index: i, price: hi, confirmedAt: i + rightBars });
    }
    if (isLow) {
      out.push({ type: "LOW", index: i, price: lo, confirmedAt: i + rightBars });
    }
  }
  return out;
}

/** Convenience: the last non-null value of an aligned series, or `null`. */
export function lastDefined(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i];
  }
  return null;
}
