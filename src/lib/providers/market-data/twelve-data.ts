import type { Candle, PriceQuote, Timeframe } from "../../types";
import type { MarketDataProvider } from "./provider";

const BASE_URL = "https://api.twelvedata.com";

// Twelve Data `interval` values match our Timeframe values 1:1.
const INTERVAL: Record<Timeframe, string> = {
  "1min": "1min",
  "5min": "5min",
  "15min": "15min",
  "1h": "1h",
  "4h": "4h",
  "1day": "1day",
};

interface TwelveDataValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TwelveDataTimeSeriesResponse {
  meta?: unknown;
  values?: TwelveDataValue[];
  status?: string;
  // Error responses use { code, message, status: "error" }.
  code?: number;
  message?: string;
}

interface TwelveDataPriceResponse {
  price?: string;
  code?: number;
  message?: string;
  status?: string;
}

export interface TwelveDataProviderOptions {
  apiKey?: string;
  /** Requests allowed per minute. Free tier is ~8. */
  requestsPerMinute?: number;
  /** Max retries on rate-limit (429 / code 429) responses. */
  maxRetries?: number;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * A minimal rate limiter that serializes requests and enforces a minimum gap
 * between them, so we stay under Twelve Data's free-tier limit (~8 req/min)
 * without bursting. Calls queue and resolve in order.
 */
class MinIntervalLimiter {
  private readonly minIntervalMs: number;
  private chain: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(requestsPerMinute: number) {
    this.minIntervalMs = Math.ceil(60_000 / Math.max(1, requestsPerMinute));
  }

  /** Run `task` after waiting long enough since the previous task started. */
  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - Date.now();
      if (wait > 0) await delay(wait);
      this.lastStart = Date.now();
    });
    // Keep the chain alive regardless of task success/failure.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => task());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a Twelve Data datetime string into a UTC Date.
 *   - intraday: "2024-01-02 15:30:00"
 *   - daily:    "2024-01-02"
 * Twelve Data returns these without a timezone offset; we treat them as UTC.
 */
function parseDatetimeUtc(datetime: string): Date {
  const normalized = datetime.includes(" ")
    ? datetime.replace(" ", "T") + "Z"
    : datetime + "T00:00:00Z";
  return new Date(normalized);
}

export class TwelveDataProvider implements MarketDataProvider {
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly limiter: MinIntervalLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TwelveDataProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "TwelveDataProvider: missing API key. Set TWELVE_DATA_API_KEY in .env.local.",
      );
    }
    this.apiKey = apiKey;
    this.maxRetries = options.maxRetries ?? 3;
    this.limiter = new MinIntervalLimiter(options.requestsPerMinute ?? 8);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Candle[]> {
    const params = new URLSearchParams({
      symbol,
      interval: INTERVAL[timeframe],
      start_date: toApiDate(from),
      end_date: toApiDate(to),
      order: "ASC",
      outputsize: "5000",
      timezone: "UTC",
      format: "JSON",
      apikey: this.apiKey,
    });

    const data = await this.request<TwelveDataTimeSeriesResponse>(
      `/time_series?${params.toString()}`,
    );

    if (data.status === "error") {
      throw new Error(
        `TwelveData time_series error (${data.code}): ${data.message}`,
      );
    }

    const values = data.values ?? [];
    return values.map((v) => ({
      symbol,
      timeframe,
      openTime: parseDatetimeUtc(v.datetime),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      // Forex/commodities often omit volume; default to 0.
      volume: v.volume !== undefined ? Number(v.volume) : 0,
    }));
  }

  async getLatestPrice(symbol: string): Promise<PriceQuote> {
    const params = new URLSearchParams({
      symbol,
      format: "JSON",
      apikey: this.apiKey,
    });

    const data = await this.request<TwelveDataPriceResponse>(
      `/price?${params.toString()}`,
    );

    if (data.status === "error" || data.price === undefined) {
      throw new Error(
        `TwelveData price error (${data.code ?? "?"}): ${data.message ?? "no price returned"}`,
      );
    }

    return {
      symbol,
      price: Number(data.price),
      timestamp: new Date(),
    };
  }

  /** Rate-limited GET with retry on rate-limit responses. */
  private async request<T>(path: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      const result = await this.limiter.schedule(async () => {
        const res = await this.fetchImpl(`${BASE_URL}${path}`);
        const body = (await res.json()) as T & { code?: number };
        return { res, body };
      });

      const rateLimited =
        result.res.status === 429 || result.body.code === 429;

      if (!rateLimited) {
        if (!result.res.ok) {
          throw new Error(
            `TwelveData HTTP ${result.res.status} for ${path}`,
          );
        }
        return result.body;
      }

      if (attempt >= this.maxRetries) {
        throw new Error(
          `TwelveData rate limit exceeded after ${this.maxRetries} retries`,
        );
      }
      attempt += 1;
      // Back off ~one full window before retrying.
      await delay(8_000 * attempt);
    }
  }
}

/** Twelve Data accepts "YYYY-MM-DD HH:mm:ss" (UTC). */
function toApiDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
