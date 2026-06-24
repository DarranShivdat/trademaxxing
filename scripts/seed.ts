/**
 * Seed the database with a demo user, the XAU/USD instrument, and realistic
 * mock candles across multiple timeframes — so downstream work can run without
 * hitting the live Twelve Data API.
 *
 * Idempotent: re-running upserts the same rows (keyed by the candle uniqueness
 * constraint) rather than duplicating.
 *
 *   npm run seed
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import type { Timeframe } from "../src/lib/types";

const prisma = new PrismaClient();

const SYMBOL = "XAU/USD";

// Minutes per timeframe, and how many bars to generate for each.
const TIMEFRAME_SPEC: Record<Timeframe, { minutes: number; count: number }> = {
  "1min": { minutes: 1, count: 800 },
  "5min": { minutes: 5, count: 800 },
  "15min": { minutes: 15, count: 700 },
  "1h": { minutes: 60, count: 700 },
  "4h": { minutes: 240, count: 500 },
  "1day": { minutes: 1440, count: 500 },
};

const BASE_PRICE = 2350; // rough XAU/USD level

interface MockCandle {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Generate `count` OHLCV bars ending at the most recent timeframe-aligned
 * boundary, via a regime-switching random walk. OHLC are internally consistent
 * (high >= max(open, close), low <= min(open, close)).
 *
 * Unlike a driftless walk, the series cycles through trending and ranging
 * regimes — so it produces the stacked-EMA uptrends and pullbacks the detection
 * engine looks for, giving the pipeline realistic data to find setups in. The
 * trend drift stays small relative to bar volatility, so trends still pull back
 * rather than running in a straight line.
 */
function generateCandles(minutes: number, count: number): MockCandle[] {
  const stepMs = minutes * 60_000;
  const now = Date.now();
  const lastBoundary = Math.floor(now / stepMs) * stepMs;

  // Volatility scales with the square root of the bar length.
  const volatility = 0.0008 * Math.sqrt(minutes);

  const candles: MockCandle[] = [];
  let price = BASE_PRICE;

  // Regime drift per bar, refreshed every `regimeLeft` bars. Magnitude is a
  // fraction of volatility so trends accumulate over many bars but each bar's
  // noise can still print red candles and pullbacks.
  let trendPerBar = 0;
  let regimeLeft = 0;

  for (let i = count - 1; i >= 0; i--) {
    const openTime = new Date(lastBoundary - i * stepMs);
    const open = price;

    if (regimeLeft <= 0) {
      // New regime: ~50–150 bars. Bias toward uptrends so there is long-side
      // material, with ranging and down stretches mixed in.
      regimeLeft = 50 + Math.floor(Math.random() * 100);
      const roll = Math.random();
      const strength = (0.5 + Math.random() * 0.5) * volatility; // 0.5–1.0 × vol
      trendPerBar = roll < 0.6 ? strength : roll < 0.85 ? -strength : 0;
    }
    regimeLeft -= 1;

    // Noise moderately above the trend: up-legs retrace into the EMA band (the
    // pullbacks the detector keys on) while still making distinct higher highs
    // overhead — the resistance a 2R target needs.
    const noise = (Math.random() - 0.5) * 1.8 * volatility;
    const drift = trendPerBar + noise;
    const close = round2(open * (1 + drift));

    const wick = open * volatility * Math.random();
    const high = round2(Math.max(open, close) + wick);
    const low = round2(Math.min(open, close) - wick);
    const volume = Math.round(500 + Math.random() * 4500);

    candles.push({ openTime, open, high, low, close, volume });
    price = close;
  }

  return candles;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main() {
  console.log("Seeding database…");

  const user = await prisma.user.upsert({
    where: { email: "demo@trademaxxing.local" },
    update: {},
    create: { email: "demo@trademaxxing.local", name: "Demo Trader" },
  });
  console.log(`  user: ${user.email}`);

  await prisma.instrument.upsert({
    where: { symbol: SYMBOL },
    update: {},
    create: {
      symbol: SYMBOL,
      name: "Gold / US Dollar",
      type: "COMMODITY",
      basePrecision: 2,
      quotePrecision: 2,
    },
  });
  console.log(`  instrument: ${SYMBOL}`);

  for (const [timeframe, spec] of Object.entries(TIMEFRAME_SPEC) as [
    Timeframe,
    { minutes: number; count: number },
  ][]) {
    const candles = generateCandles(spec.minutes, spec.count);
    for (const c of candles) {
      await prisma.candle.upsert({
        where: {
          symbol_timeframe_openTime: {
            symbol: SYMBOL,
            timeframe,
            openTime: c.openTime,
          },
        },
        update: {
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          source: "seed",
        },
        create: {
          symbol: SYMBOL,
          timeframe,
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          source: "seed",
        },
      });
    }
    console.log(`  candles[${timeframe}]: ${candles.length}`);
  }

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
