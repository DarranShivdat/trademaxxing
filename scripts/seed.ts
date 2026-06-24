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
  "1min": { minutes: 1, count: 500 },
  "5min": { minutes: 5, count: 500 },
  "15min": { minutes: 15, count: 400 },
  "1h": { minutes: 60, count: 480 },
  "4h": { minutes: 240, count: 360 },
  "1day": { minutes: 1440, count: 365 },
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
 * boundary, via a bounded random walk. OHLC are internally consistent
 * (high >= max(open, close), low <= min(open, close)).
 */
function generateCandles(minutes: number, count: number): MockCandle[] {
  const stepMs = minutes * 60_000;
  const now = Date.now();
  const lastBoundary = Math.floor(now / stepMs) * stepMs;

  // Volatility scales with the square root of the bar length.
  const volatility = 0.0008 * Math.sqrt(minutes);

  const candles: MockCandle[] = [];
  let price = BASE_PRICE;

  for (let i = count - 1; i >= 0; i--) {
    const openTime = new Date(lastBoundary - i * stepMs);
    const open = price;

    const drift = (Math.random() - 0.5) * 2 * volatility;
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
