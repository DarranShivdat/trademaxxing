// Market-data vocabulary shared across every module.

/** Candle timeframes. These map 1:1 onto Twelve Data's `interval` values. */
export type Timeframe = "1min" | "5min" | "15min" | "1h" | "4h" | "1day";

export const TIMEFRAMES: readonly Timeframe[] = [
  "1min",
  "5min",
  "15min",
  "1h",
  "4h",
  "1day",
] as const;

export type InstrumentType = "FOREX" | "COMMODITY";

export interface Instrument {
  /** Canonical symbol, e.g. "XAU/USD". */
  symbol: string;
  name: string;
  type: InstrumentType;
  /** Decimal precision of the base/quote sides — used for display/rounding. */
  basePrecision: number;
  quotePrecision: number;
}

/** A single OHLCV bar. `openTime` is the candle's open timestamp in UTC. */
export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A point-in-time price quote. */
export interface PriceQuote {
  symbol: string;
  price: number;
  timestamp: Date;
}
