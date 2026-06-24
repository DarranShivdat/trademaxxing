// Test helpers for synthesizing candle data.
import type { Candle, Timeframe } from "@/lib/types";

const BASE_TIME = Date.UTC(2024, 0, 1, 0, 0, 0); // fixed; no Date.now() in tests.
const HOUR = 3_600_000;

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Build candles from compact OHLC bars, one hour apart starting 2024-01-01. */
export function candles(
  bars: Bar[],
  symbol = "XAU/USD",
  timeframe: Timeframe = "1h",
  stepMs = HOUR,
): Candle[] {
  return bars.map((b, i) => ({
    symbol,
    timeframe,
    openTime: new Date(BASE_TIME + i * stepMs),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume ?? 1000,
  }));
}

/** A simple bar from open/close; high/low padded unless overridden. */
export function bar(
  open: number,
  close: number,
  high?: number,
  low?: number,
): Bar {
  return {
    open,
    close,
    high: high ?? Math.max(open, close) + 0.5,
    low: low ?? Math.min(open, close) - 0.5,
  };
}

/** Closes-only candles (high/low derived) for indicator tests. */
export function fromCloses(values: number[], stepMs = HOUR): Candle[] {
  return candles(
    values.map((c, i) => {
      const open = i === 0 ? c : values[i - 1];
      return bar(open, c);
    }),
    "XAU/USD",
    "1h",
    stepMs,
  );
}
