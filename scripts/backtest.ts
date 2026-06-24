/**
 * Backtest the trend-pullback strategy over real candles already in the DB and
 * print an honest results table.
 *
 *   npm run backtest -- --symbol XAU/USD --timeframe 1h
 *   npm run backtest -- --timeframe 4h --equity 25000
 *
 * Detection delegates entirely to the existing engine (no lookahead); trades
 * are simulated forward against intrabar highs/lows with stop-first resolution.
 * See src/lib/backtest/run.ts for the contract.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { Candle, Timeframe } from "../src/lib/types";
import { TIMEFRAMES } from "../src/lib/types";
import { runBacktest } from "../src/lib/backtest/run";
import { computeBacktestStats } from "../src/lib/backtest/metrics";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Minimum closed trades before a win rate / edge claim means anything. */
const MIN_MEANINGFUL = 30;

async function loadCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
  const rows = await prisma.candle.findMany({
    where: { symbol, timeframe },
    orderBy: { openTime: "asc" },
  });
  return rows.map((c) => ({
    symbol: c.symbol,
    timeframe: c.timeframe as Timeframe,
    openTime: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

function fmt(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return x > 0 ? "∞" : "-∞";
  return x.toFixed(dp);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const symbol = arg("symbol") ?? "XAU/USD";
  const tfArg = arg("timeframe") ?? "1h";
  if (!TIMEFRAMES.includes(tfArg as Timeframe)) {
    throw new Error(`Invalid --timeframe "${tfArg}". One of: ${TIMEFRAMES.join(", ")}`);
  }
  const timeframe = tfArg as Timeframe;
  const equity = arg("equity");

  const candles = await loadCandles(symbol, timeframe);
  if (candles.length === 0) {
    console.log(
      `No candles in DB for ${symbol} ${timeframe}. ` +
        `Pull/seed data first (e.g. npm run pull:candles).`,
    );
    return;
  }

  const result = runBacktest(candles, {
    accountEquity: equity ? Number(equity) : undefined,
  });
  const stats = computeBacktestStats(result.trades);

  const start = candles[0].openTime.toISOString().slice(0, 10);
  const end = candles[candles.length - 1].openTime.toISOString().slice(0, 10);

  console.log("");
  console.log(`Backtest — Trend Pullback`);
  console.log(`  ${symbol} ${timeframe}   ${start} → ${end}   ${candles.length} candles`);
  console.log("");

  console.log("Pipeline");
  console.log(`  setups detected ........ ${result.detected}`);
  console.log(`  rejected by risk ....... ${result.rejectedByRisk}`);
  console.log(`  skipped (in a trade) ... ${result.skippedWhileInTrade}`);
  console.log(`  trades taken ........... ${result.approved}`);
  console.log("");

  // Trade count is the headline — everything else is conditional on it.
  console.log("Results");
  console.log(`  TRADES (resolved) ...... ${stats.closedTrades}`);
  console.log(`  still open (unresolved)  ${stats.openUnresolved}`);

  if (stats.closedTrades === 0) {
    console.log("");
    console.log("  No resolved trades — nothing to measure. The strategy is");
    console.log("  selective; this candle set produced no completed setups.");
    return;
  }

  console.log(`  wins / losses .......... ${stats.wins} / ${stats.losses}`);
  console.log(`  win rate ............... ${pct(stats.winRate)}`);
  console.log(`  avg R per trade ........ ${fmt(stats.avgR)}R`);
  console.log(`  expectancy ............. ${fmt(stats.expectancy)}R`);
  console.log(`    avg win / avg loss ... +${fmt(stats.avgWinR)}R / ${fmt(stats.avgLossR)}R`);
  console.log(`  total R ................ ${fmt(stats.totalR)}R`);
  console.log(`  profit factor .......... ${fmt(stats.profitFactor)}`);
  console.log(`  max drawdown ........... ${fmt(stats.maxDrawdownR)}R`);
  console.log("");

  // Honesty gate: do not let a 3-trade win rate masquerade as an edge.
  if (stats.closedTrades < MIN_MEANINGFUL) {
    console.log(
      `  ⚠ NOT STATISTICALLY MEANINGFUL: only ${stats.closedTrades} resolved ` +
        `trade(s)\n` +
        `    (< ${MIN_MEANINGFUL}). These numbers are anecdotes, not evidence of an\n` +
        `    edge. The strategy is selective by design; gather far more data\n` +
        `    (more history / timeframes) before trusting the win rate.`,
    );
  } else {
    console.log(
      `  Sample size: ${stats.closedTrades} resolved trades — large enough for a\n` +
        `  first read, though more is always better for a confident edge claim.`,
    );
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
