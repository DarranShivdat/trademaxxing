import type { Candle, PriceQuote, Timeframe } from "../../types";

/**
 * Source of price data. Swap the concrete implementation (TwelveDataProvider
 * today) without touching any consumer. Every implementation must normalize
 * its upstream response into our `Candle` / `PriceQuote` types.
 */
export interface MarketDataProvider {
  /**
   * Fetch candles for `symbol` at `timeframe` within [from, to] (inclusive),
   * returned in ascending time order.
   */
  getCandles(
    symbol: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Candle[]>;

  /** Latest available price for `symbol`. */
  getLatestPrice(symbol: string): Promise<PriceQuote>;
}
