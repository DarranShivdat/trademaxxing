/**
 * Pull REAL recent XAU/USD candles from Twelve Data into the DB — proves the
 * TwelveDataProvider integration end-to-end. Requires TWELVE_DATA_API_KEY in
 * .env.local.
 *
 *   npm run pull:candles
 *
 * Optional args:
 *   --timeframe=1h     (default 1h)
 *   --days=10          how far back to fetch (default 10)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { PrismaClient } from "@prisma/client";
import { TwelveDataProvider } from "../src/lib/providers/market-data/twelve-data";
import { TIMEFRAMES, type Timeframe } from "../src/lib/types";

const prisma = new PrismaClient();
const SYMBOL = "XAU/USD";

function parseArgs() {
  const args = process.argv.slice(2);
  let timeframe: Timeframe = "1h";
  let days = 10;
  for (const arg of args) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "timeframe" && TIMEFRAMES.includes(value as Timeframe)) {
      timeframe = value as Timeframe;
    } else if (key === "days") {
      days = Number(value) || days;
    }
  }
  return { timeframe, days };
}

async function main() {
  const { timeframe, days } = parseArgs();
  const provider = new TwelveDataProvider();

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(
    `Fetching ${SYMBOL} ${timeframe} candles from ${from.toISOString()} to ${to.toISOString()}…`,
  );

  const candles = await provider.getCandles(SYMBOL, timeframe, from, to);
  console.log(`  received ${candles.length} candles from Twelve Data`);

  let written = 0;
  for (const c of candles) {
    await prisma.candle.upsert({
      where: {
        symbol_timeframe_openTime: {
          symbol: c.symbol,
          timeframe: c.timeframe,
          openTime: c.openTime,
        },
      },
      update: {
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        source: "twelve_data",
      },
      create: {
        symbol: c.symbol,
        timeframe: c.timeframe,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        source: "twelve_data",
      },
    });
    written += 1;
  }

  console.log(`  upserted ${written} candles into the DB`);

  // Sanity check: latest price.
  try {
    const quote = await provider.getLatestPrice(SYMBOL);
    console.log(
      `  latest price: ${quote.price} @ ${quote.timestamp.toISOString()}`,
    );
  } catch (err) {
    console.warn("  (latest price lookup failed)", (err as Error).message);
  }

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
