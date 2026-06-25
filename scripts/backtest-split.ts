/**
 * IN-SAMPLE vs OUT-OF-SAMPLE split — does the edge hold on data outside the
 * period it "could have been designed on"?
 *
 *   npm run backtest:split                       # default cells + windows
 *   npm run backtest:split -- --equity 25000
 *   npm run backtest:split -- --setup trend-pullback --symbol XAU/USD --timeframe 15min
 *   npm run backtest:split -- --from-is 2020-01-01 --to-is 2023-12-31 \
 *                              --from-oos 2024-01-01 --to-oos 2026-06-25
 *
 * Defaults run XAU/USD 15min and XAU/USD 1h on trend-pullback over:
 *   IN-SAMPLE      2020-01-01 → 2023-12-31
 *   OUT-OF-SAMPLE  2024-01-01 → 2026-06-25
 *
 * HOW THE SPLIT IS DONE (and why it's honest):
 *   This is NOT a candle slice. For each cell we load the FULL history once and
 *   run the EXISTING, UNMODIFIED backtester twice — once with the entry window
 *   set to the in-sample range, once to the out-of-sample range. Because the
 *   engine always sees the whole series, indicators warm up identically in both
 *   runs (no cold-start artifact at 2024-01-01 that would fake OOS decay), and
 *   no-lookahead/streaming/scanner guarantees are untouched: the window only
 *   gates which bars may OPEN a trade. See BacktestOptions.from/to.
 *
 *   Each window is an INDEPENDENT run, so OOS is not blocked by a position
 *   carried over from in-sample. A trade opened near a window's end resolves on
 *   later real bars (the trade playing out) — the entry decision, made from past
 *   bars only, is what assigns it to that window.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { Candle, Timeframe } from "../src/lib/types";
import { TIMEFRAMES } from "../src/lib/types";
import { runBacktest, type BacktestTrade } from "../src/lib/backtest/run";
import type { FeatureSet } from "../src/lib/engine/features";
import { computeBacktestStats, profitFactorR } from "../src/lib/backtest/metrics";
import { applyCost, type CostModel } from "../src/lib/backtest/cost";
import { setupBySlug, type SetupDef } from "../src/lib/setups";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Parse --cost-price / --cost-r into a CostModel, or undefined for a cost-free
 * run. Applied identically to BOTH windows as a post-trade deduction; for the
 * full cost-sensitivity sweep + breakeven, use `npm run backtest:cost`.
 */
function parseCost(): CostModel | undefined {
  const priceArg = arg("cost-price");
  const rArg = arg("cost-r");
  if (priceArg !== undefined && rArg !== undefined) {
    throw new Error("Pass only one of --cost-price or --cost-r.");
  }
  if (priceArg !== undefined) {
    const v = Number(priceArg);
    if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid --cost-price "${priceArg}".`);
    return { kind: "price", priceUnits: v };
  }
  if (rArg !== undefined) {
    const v = Number(rArg);
    if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid --cost-r "${rArg}".`);
    return { kind: "r", perTradeR: v };
  }
  return undefined;
}

/**
 * Parse a YYYY-MM-DD CLI date into a UTC window bound. `end` bounds map to the
 * last instant of the day so the IS→OOS handoff is gapless and non-overlapping.
 */
function parseDate(s: string, end = false): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`);
  }
  const d = new Date(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${s}".`);
  return d;
}

/** Minimum resolved trades before a win rate / edge claim means anything. */
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

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Window {
  label: string;
  from: Date;
  to: Date;
}

interface WindowResult {
  closed: number;
  open: number;
  winRate: number;
  avgR: number;
  expectancy: number;
  profitFactor: number;
}

/** Run the cell's setup over the full series, gated to one entry window. */
function runWindow(
  def: SetupDef,
  candles: Candle[],
  equity: number | undefined,
  w: Window,
  cost?: CostModel,
): WindowResult {
  // Fresh scanner per run — stateful scanners must not share state across runs.
  const detect = def.makeScanner
    ? def.makeScanner()
    : (c: Candle[], n: number, f?: FeatureSet | null) => def.detect(c, n, undefined, f);
  const result = runBacktest(candles, {
    accountEquity: equity,
    detect,
    from: w.from,
    to: w.to,
  });
  // Post-trade cost deduction, applied identically to both windows when set.
  const trades = cost ? applyCost(result.trades, cost) : result.trades;
  const stats = computeBacktestStats(trades);
  return {
    closed: stats.closedTrades,
    open: stats.openUnresolved,
    winRate: stats.winRate,
    avgR: stats.avgR,
    expectancy: stats.expectancy,
    profitFactor: profitFactorR(trades),
  };
}

/** Side-by-side IS vs OOS table for one cell. */
function printCell(
  symbol: string,
  timeframe: Timeframe,
  def: SetupDef,
  candles: Candle[],
  is: Window,
  oos: Window,
  isR: WindowResult,
  oosR: WindowResult,
) {
  const dataStart = ymd(candles[0].openTime);
  const dataEnd = ymd(candles[candles.length - 1].openTime);

  console.log("");
  console.log(`■ ${symbol} ${timeframe} · ${def.label}`);
  console.log(`  data: ${dataStart} → ${dataEnd} (${candles.length} candles, full history warms indicators in both runs)`);
  console.log("");

  const col = (s: string) => s.padStart(22);
  const metric = (label: string, a: string, b: string) =>
    "  " + label.padEnd(16) + col(a) + col(b);

  console.log("  " + "".padEnd(16) + col("IN-SAMPLE") + col("OUT-OF-SAMPLE"));
  console.log("  " + "".padEnd(16) + col(`${ymd(is.from)}→${ymd(is.to)}`) + col(`${ymd(oos.from)}→${ymd(oos.to)}`));
  console.log("  " + "─".repeat(60));
  console.log(metric("Trades", String(isR.closed), String(oosR.closed)));
  const wr = (r: WindowResult) => (r.closed > 0 ? pct(r.winRate) : "—");
  const rr = (r: WindowResult, v: number) => (r.closed > 0 ? `${fmt(v)}R` : "—");
  console.log(metric("Win rate", wr(isR), wr(oosR)));
  console.log(metric("Avg R", rr(isR, isR.avgR), rr(oosR, oosR.avgR)));
  console.log(metric("Expectancy", rr(isR, isR.expectancy), rr(oosR, oosR.expectancy)));
  console.log(
    metric(
      "Profit factor",
      isR.closed > 0 ? fmt(isR.profitFactor) : "—",
      oosR.closed > 0 ? fmt(oosR.profitFactor) : "—",
    ),
  );
  if (isR.open || oosR.open) {
    console.log(metric("(still open)", String(isR.open), String(oosR.open)));
  }
  console.log("");

  // Honesty gate on OUT-OF-SAMPLE sample size — the whole point of the split.
  if (oosR.closed === 0) {
    console.log(`  ⚠ OOS has 0 resolved trades — nothing to validate against here.`);
  } else if (oosR.closed < MIN_MEANINGFUL) {
    console.log(
      `  ⚠ OOS THIN: only ${oosR.closed} resolved trades (< ${MIN_MEANINGFUL}). The out-of-sample\n` +
        `    read is an anecdote, not evidence — treat any IS↔OOS difference as noise.`,
    );
  } else {
    console.log(
      `  ✓ OOS has ${oosR.closed} resolved trades (≥ ${MIN_MEANINGFUL}) — a meaningful out-of-sample read.`,
    );
  }

  if (isR.closed > 0 && isR.closed < MIN_MEANINGFUL) {
    console.log(`  · note: IN-SAMPLE is also thin (${isR.closed} < ${MIN_MEANINGFUL}).`);
  }
}

async function main() {
  const equityArg = arg("equity");
  const equity = equityArg ? Number(equityArg) : undefined;
  const cost = parseCost();

  const setupSlug = arg("setup") ?? "trend-pullback";
  const def = setupBySlug(setupSlug);
  if (!def) {
    throw new Error(`Invalid --setup "${setupSlug}".`);
  }

  const is: Window = {
    label: "IN-SAMPLE",
    from: parseDate(arg("from-is") ?? "2020-01-01"),
    to: parseDate(arg("to-is") ?? "2023-12-31", true),
  };
  const oos: Window = {
    label: "OUT-OF-SAMPLE",
    from: parseDate(arg("from-oos") ?? "2024-01-01"),
    to: parseDate(arg("to-oos") ?? "2026-06-25", true),
  };

  // Default cells: XAU/USD 15min and XAU/USD 1h. A single --symbol/--timeframe
  // override collapses to just that one cell.
  const symbolOverride = arg("symbol");
  const tfOverride = arg("timeframe");
  if (tfOverride && !TIMEFRAMES.includes(tfOverride as Timeframe)) {
    throw new Error(`Invalid --timeframe "${tfOverride}". One of: ${TIMEFRAMES.join(", ")}`);
  }
  const cells: Array<{ symbol: string; timeframe: Timeframe }> =
    symbolOverride || tfOverride
      ? [{ symbol: symbolOverride ?? "XAU/USD", timeframe: (tfOverride ?? "1h") as Timeframe }]
      : [
          { symbol: "XAU/USD", timeframe: "15min" },
          { symbol: "XAU/USD", timeframe: "1h" },
        ];

  console.log("");
  console.log("Out-of-sample validation — IN-SAMPLE vs OUT-OF-SAMPLE");
  console.log(`  setup: ${def.label} · equity ${equity ?? 10000} · risk 1%/trade`);
  console.log(`  IN-SAMPLE      ${ymd(is.from)} → ${ymd(is.to)}`);
  console.log(`  OUT-OF-SAMPLE  ${ymd(oos.from)} → ${ymd(oos.to)}`);
  console.log(`  windows gate ENTRIES only; the engine sees full history (warmup + no-lookahead intact).`);
  if (cost) {
    const desc =
      cost.kind === "price"
        ? `$${cost.priceUnits} spread+slippage/trade (→R by stop distance)`
        : `${cost.perTradeR}R flat/trade`;
    console.log(`  transaction cost: ${desc}, deducted from every trade's R.`);
  }

  for (const cell of cells) {
    const candles = await loadCandles(cell.symbol, cell.timeframe);
    if (candles.length === 0) {
      console.log("");
      console.log(`■ ${cell.symbol} ${cell.timeframe} · ${def.label}`);
      console.log(`  No candles in DB. Pull/seed data first (npm run pull:candles).`);
      continue;
    }
    const isR = runWindow(def, candles, equity, is, cost);
    const oosR = runWindow(def, candles, equity, oos, cost);
    printCell(cell.symbol, cell.timeframe, def, candles, is, oos, isR, oosR);
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
