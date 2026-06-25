/**
 * Backtest a single setup over real candles already in the DB and print an
 * honest results table.
 *
 *   npm run backtest -- --symbol XAU/USD --timeframe 1h
 *   npm run backtest -- --timeframe 4h --equity 25000
 *   npm run backtest -- --setup breakout-retest          # a specific setup
 *   npm run backtest -- --setup all                      # each setup in turn
 *   npm run backtest -- --from 2024-01-01 --to 2026-06-25  # entry window only
 *
 * Detection delegates entirely to the existing engine (no lookahead); trades
 * are simulated forward against intrabar highs/lows with stop-first resolution.
 * See src/lib/backtest/run.ts for the contract.
 *
 * --from / --to restrict only which bars may OPEN a trade (entry-eligibility
 * window). The engine still sees the FULL candle history, so indicators warm up
 * exactly as live — no cold-start artifact at the window edge — and no-lookahead
 * is untouched. See BacktestOptions.from/to.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { Candle, Timeframe } from "../src/lib/types";
import { TIMEFRAMES } from "../src/lib/types";
import { runBacktest } from "../src/lib/backtest/run";
import type { FeatureSet } from "../src/lib/engine/features";
import { computeBacktestStats } from "../src/lib/backtest/metrics";
import { SETUPS, setupBySlug, type SetupDef } from "../src/lib/setups";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Parse a YYYY-MM-DD CLI date into a UTC window bound. `end` bounds map to the
 * last instant of the day so a [..→2023-12-31] / [2024-01-01→..] split is gapless
 * and non-overlapping. Returns undefined when the arg is absent (unbounded).
 */
function parseDate(s: string | undefined, end = false): Date | undefined {
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`);
  }
  const d = new Date(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${s}".`);
  return d;
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
  const from = parseDate(arg("from"));
  const to = parseDate(arg("to"), true);

  // Which setup(s) to backtest. Default trend-pullback (historical behavior);
  // "all" runs each in turn; otherwise a specific slug.
  const setupArg = arg("setup") ?? "trend-pullback";
  let defs: SetupDef[];
  if (setupArg === "all") {
    defs = SETUPS;
  } else {
    const def = setupBySlug(setupArg);
    if (!def) {
      throw new Error(
        `Invalid --setup "${setupArg}". One of: ${SETUPS.map((s) => s.slug).join(", ")}, all`,
      );
    }
    defs = [def];
  }

  const candles = await loadCandles(symbol, timeframe);
  if (candles.length === 0) {
    console.log(
      `No candles in DB for ${symbol} ${timeframe}. ` +
        `Pull/seed data first (e.g. npm run pull:candles).`,
    );
    return;
  }

  for (const def of defs) {
    report(def, candles, symbol, timeframe, equity, from, to);
  }
}

/** Print a full single-setup backtest report for one instrument/timeframe. */
function report(
  def: SetupDef,
  candles: Candle[],
  symbol: string,
  timeframe: Timeframe,
  equity: string | undefined,
  from?: Date,
  to?: Date,
) {
  // Prefer the setup's stateful scanner (identical signals, scales to long
  // series); fall back to the stateless per-bar detector. Fresh per run.
  const detect = def.makeScanner
    ? def.makeScanner()
    : (c: Candle[], n: number, f?: FeatureSet | null) =>
        def.detect(c, n, undefined, f);
  const result = runBacktest(candles, {
    accountEquity: equity ? Number(equity) : undefined,
    detect,
    from,
    to,
  });
  const stats = computeBacktestStats(result.trades);

  const start = candles[0].openTime.toISOString().slice(0, 10);
  const end = candles[candles.length - 1].openTime.toISOString().slice(0, 10);

  console.log("");
  console.log(`Backtest — ${def.label}`);
  console.log(`  ${symbol} ${timeframe}   ${start} → ${end}   ${candles.length} candles`);
  if (from || to) {
    const w0 = from ? from.toISOString().slice(0, 10) : start;
    const w1 = to ? to.toISOString().slice(0, 10) : end;
    console.log(
      `  entry window: ${w0} → ${w1}  (full history warms indicators; only entries are gated)`,
    );
  }
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
