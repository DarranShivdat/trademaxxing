/**
 * TRANSACTION-COST SENSITIVITY — does the gold-intraday edge survive real costs?
 *
 *   npm run backtest:cost                       # XAU/USD 15min + 1h, default sweep
 *   npm run backtest:cost -- --symbol XAU/USD --timeframe 15min
 *   npm run backtest:cost -- --setup trend-pullback
 *   npm run backtest:cost -- --r-levels 0,0.05,0.1,0.15,0.2,0.25
 *   npm run backtest:cost -- --price-levels 0,0.2,0.4,0.6   # spread+slippage in $
 *
 * WHAT THIS DOES (and what it does NOT touch).
 *   Detection, no-lookahead, intrabar resolution and the metric formulas are
 *   UNCHANGED. For each cell + window (IS / OOS) we run the EXISTING backtester
 *   ONCE to get the gross trades, then re-price those same trades at each cost
 *   level — a pure post-trade deduction (see src/lib/backtest/cost.ts). Cost is
 *   charged as a worse exit fill, so every metric (avg R, win rate, profit
 *   factor) reflects it; both winners and losers pay.
 *
 * THE TWO COST UNITS.
 *   • R sweep (primary): a flat cost in R, directly comparable to the OOS
 *     +0.23R edge — so the breakeven cost is just where net expectancy hits 0.
 *   • Price sweep (honest): a round-turn spread+slippage in PRICE units ($ for
 *     gold), converted to R PER TRADE by each trade's own stop distance. The
 *     same $ cost is a different R hit on tight vs wide stops, so this is the
 *     realistic mapping — and it's keyed to actual retail gold spreads below.
 *
 * The split is done EXACTLY as backtest:split does it (entry-eligibility window
 * over the full series; no candle slice), so warmup and no-lookahead are intact.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { Candle, Timeframe } from "../src/lib/types";
import { TIMEFRAMES } from "../src/lib/types";
import { runBacktest, type BacktestTrade } from "../src/lib/backtest/run";
import type { FeatureSet } from "../src/lib/engine/features";
import { computeBacktestStats, profitFactorR } from "../src/lib/backtest/metrics";
import { applyCost, stopDistance, type CostModel } from "../src/lib/backtest/cost";
import { setupBySlug, type SetupDef } from "../src/lib/setups";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseDate(s: string, end = false): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`);
  const d = new Date(`${s}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${s}".`);
  return d;
}

function parseLevels(s: string | undefined, fallback: number[]): number[] {
  if (!s) return fallback;
  return s.split(",").map((x) => {
    const t = x.trim();
    // Reject blanks explicitly — Number("") is 0, which would smuggle in a
    // spurious zero-cost row from a stray/trailing comma.
    if (t === "") throw new Error(`Empty cost level in "${s}".`);
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid cost level "${x}".`);
    return n;
  });
}

/** Minimum resolved trades before a win-rate / edge claim means anything. */
const MIN_MEANINGFUL = 30;

/**
 * Realistic RETAIL XAU/USD transaction cost, round-turn, in price units ($).
 * Typical retail gold spreads run ~$0.15–$0.45; add a little slippage on a
 * market entry/exit and a round turn lands around $0.30–$0.60. We anchor the
 * honest read at $0.40 and bracket it; this is the line on the curve that maps
 * to "what you'd actually pay". (Set your own with --price-levels.)
 */
const REALISTIC_PRICE_COST = 0.4;

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
function signed(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return fmt(x, dp);
  return (x >= 0 ? "+" : "") + x.toFixed(dp);
}

interface Window {
  label: string;
  from: Date;
  to: Date;
}

/** A cost level's effect on one window's resolved trades. */
interface CostRow {
  /** Cost in R: the flat value (R sweep) or mean per-trade cost/R (price sweep). */
  costR: number;
  expectancy: number;
  winRate: number;
  profitFactor: number;
  totalR: number;
}

/** Run a cell's setup over the full series, gated to one entry window; gross trades. */
function grossTrades(def: SetupDef, candles: Candle[], w: Window): BacktestTrade[] {
  const detect = def.makeScanner
    ? def.makeScanner()
    : (c: Candle[], n: number, f?: FeatureSet | null) => def.detect(c, n, undefined, f);
  return runBacktest(candles, { detect, from: w.from, to: w.to }).trades;
}

/** Stats for a set of (already cost-adjusted) trades, reduced to the row shape. */
function rowFor(costR: number, trades: BacktestTrade[]): CostRow {
  const s = computeBacktestStats(trades);
  return {
    costR,
    expectancy: s.expectancy,
    winRate: s.winRate,
    profitFactor: profitFactorR(trades),
    totalR: s.totalR,
  };
}

/** Resolved trades only (cost applies to realized R). */
function resolved(trades: BacktestTrade[]): BacktestTrade[] {
  return trades.filter((t) => t.r !== null);
}

/** Mean realized gross R = the uncosted expectancy/edge. */
function grossExpectancy(trades: BacktestTrade[]): number {
  const r = resolved(trades);
  return r.length ? r.reduce((a, t) => a + (t.r as number), 0) / r.length : 0;
}

/**
 * Mean of 1/stopDistance over resolved trades — maps a $ cost to mean R: a price
 * cost P has mean R hit P·meanInvStop. The divisor is the count of ALL resolved
 * trades (a degenerate zero-stop trade contributes 0, exactly as applyCost
 * charges it 0), so this matches the sweep table's per-trade mean cost — keeping
 * the analytic breakeven consistent with the applyCost-derived rows.
 */
function meanInvStop(trades: BacktestTrade[]): number {
  const r = resolved(trades);
  if (!r.length) return 0;
  const sum = r.reduce((a, t) => {
    const d = stopDistance(t);
    return a + (d > 0 ? 1 / d : 0);
  }, 0);
  return sum / r.length;
}

/** Mean stop distance over resolved trades — the cell's typical 1R in price units. */
function meanStop(trades: BacktestTrade[]): number {
  const r = resolved(trades);
  return r.length ? r.reduce((a, t) => a + stopDistance(t), 0) / r.length : 0;
}

function printRSweep(label: string, gross: BacktestTrade[], rLevels: number[]) {
  console.log(`  ${label} — flat cost in R (directly comparable to the edge)`);
  console.log(
    "    " +
      "cost".padStart(7) +
      "expectancy".padStart(13) +
      "win rate".padStart(11) +
      "profit f.".padStart(11) +
      "total R".padStart(11),
  );
  console.log("    " + "─".repeat(53));
  for (const c of rLevels) {
    const row = rowFor(c, applyCost(gross, { kind: "r", perTradeR: c }));
    const edge = `${signed(row.expectancy)}R`;
    console.log(
      "    " +
        `${c.toFixed(2)}R`.padStart(7) +
        edge.padStart(13) +
        pct(row.winRate).padStart(11) +
        fmt(row.profitFactor).padStart(11) +
        `${signed(row.totalR, 1)}`.padStart(11),
    );
  }
}

function printPriceSweep(label: string, gross: BacktestTrade[], priceLevels: number[]) {
  const avgStop = meanStop(gross);
  console.log(
    `  ${label} — spread+slippage in $ (per-trade /stop; avg 1R ≈ $${fmt(avgStop)})`,
  );
  console.log(
    "    " +
      "cost".padStart(8) +
      "≈ R".padStart(8) +
      "expectancy".padStart(13) +
      "win rate".padStart(11) +
      "profit f.".padStart(11),
  );
  console.log("    " + "─".repeat(51));
  for (const c of priceLevels) {
    const net = applyCost(gross, { kind: "price", priceUnits: c });
    const row = rowFor(0, net);
    // Mean per-trade cost in R for this price level (varies by stop distance).
    const meanCostR = c * meanInvStop(gross);
    const real = Math.abs(c - REALISTIC_PRICE_COST) < 1e-9 ? "  ← realistic retail" : "";
    console.log(
      "    " +
        `$${fmt(c)}`.padStart(8) +
        fmt(meanCostR, 3).padStart(8) +
        `${signed(row.expectancy)}R`.padStart(13) +
        pct(row.winRate).padStart(11) +
        fmt(row.profitFactor).padStart(11) +
        real,
    );
  }
}

/**
 * Breakeven cost: where net expectancy = 0. Expectancy is linear in the per-trade
 * cost, so for the R model breakeven == gross expectancy. For the price model,
 * net = gross − P·mean(1/stop), so P* = gross / mean(1/stop).
 */
function breakeven(gross: BacktestTrade[]): { r: number; price: number } {
  const g = grossExpectancy(gross);
  const inv = meanInvStop(gross);
  return { r: g, price: inv > 0 ? g / inv : Infinity };
}

function printCell(
  symbol: string,
  timeframe: Timeframe,
  def: SetupDef,
  candles: Candle[],
  is: Window,
  oos: Window,
  rLevels: number[],
  priceLevels: number[],
) {
  const isGross = grossTrades(def, candles, is);
  const oosGross = grossTrades(def, candles, oos);
  const nIs = resolved(isGross).length;
  const nOos = resolved(oosGross).length;

  console.log("");
  console.log(`■ ${symbol} ${timeframe} · ${def.label}`);
  console.log(
    `  data ${ymd(candles[0].openTime)} → ${ymd(candles[candles.length - 1].openTime)} ` +
      `(${candles.length} candles) · IS ${nIs} trades · OOS ${nOos} trades`,
  );
  console.log(
    `  gross edge: IS ${signed(grossExpectancy(isGross))}R · OOS ${signed(grossExpectancy(oosGross))}R`,
  );

  console.log("");
  console.log("  ── OUT-OF-SAMPLE under cost (the real test) ──────────────────");
  printRSweep("OOS", oosGross, rLevels);
  console.log("");
  printPriceSweep("OOS", oosGross, priceLevels);

  console.log("");
  console.log("  ── IN-SAMPLE under cost (for comparison) ─────────────────────");
  printRSweep("IS ", isGross, rLevels);

  console.log("");
  console.log("  BREAKEVEN (net expectancy → 0):");
  // A breakeven cost only exists for a positive gross edge; a losing setup never
  // breaks even (a negative "cost to breakeven" is meaningless).
  const breakevenLine = (label: string, gross: BacktestTrade[]) => {
    const g = grossExpectancy(gross);
    if (g <= 0) {
      console.log(`    ${label}  no positive gross edge (${signed(g)}R) — never breaks even`);
      return;
    }
    const be = breakeven(gross);
    console.log(
      `    ${label}  ${signed(be.r)}R per trade  ≈  $${fmt(be.price)} round-turn spread+slippage`,
    );
  };
  breakevenLine("OUT-OF-SAMPLE".padEnd(13), oosGross);
  breakevenLine("IN-SAMPLE".padEnd(13), isGross);
  // Where realistic retail cost lands, and the verdict.
  const realCostR = REALISTIC_PRICE_COST * meanInvStop(oosGross);
  const netAtReal = grossExpectancy(oosGross) - realCostR;
  console.log(
    `    realistic $${fmt(REALISTIC_PRICE_COST)} ≈ ${fmt(realCostR, 3)}R/trade ⇒ OOS net ${signed(netAtReal)}R ` +
      `(${netAtReal > 0 ? "SURVIVES" : "GONE"})`,
  );

  if (nOos < MIN_MEANINGFUL) {
    console.log(
      `    ⚠ OOS THIN: ${nOos} resolved trades (< ${MIN_MEANINGFUL}) — treat this curve as an anecdote.`,
    );
  }
}

async function main() {
  const setupSlug = arg("setup") ?? "trend-pullback";
  const def = setupBySlug(setupSlug);
  if (!def) throw new Error(`Invalid --setup "${setupSlug}".`);

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

  const rLevels = parseLevels(arg("r-levels"), [0, 0.05, 0.1, 0.15, 0.2, 0.25]);
  const priceLevels = parseLevels(arg("price-levels"), [0, 0.2, 0.4, 0.6]);

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
  console.log("Transaction-cost sensitivity — does the edge survive real costs?");
  console.log(`  setup: ${def.label} · post-trade deduction (detection/no-lookahead unchanged)`);
  console.log(`  IN-SAMPLE      ${ymd(is.from)} → ${ymd(is.to)}`);
  console.log(`  OUT-OF-SAMPLE  ${ymd(oos.from)} → ${ymd(oos.to)}`);
  console.log(
    `  cost charged as a worse exit fill on EVERY trade (wins and losses both pay).`,
  );
  console.log(
    `  win rate stays ~flat across these levels: a worse fill shrinks each trade's R, and`,
  );
  console.log(
    `  because winners clear ≥2R while these costs are a fraction of R, no win flips to a`,
  );
  console.log(
    `  loss — the edge erodes through expectancy and profit factor, not the hit rate. (A`,
  );
  console.log(
    `  cost exceeding a winner's reward — e.g. a price cost on an abnormally tight stop —`,
  );
  console.log(`  would reclassify it; the win-rate column reflects that if it happens.)`);

  for (const cell of cells) {
    const candles = await loadCandles(cell.symbol, cell.timeframe);
    if (candles.length === 0) {
      console.log("");
      console.log(`■ ${cell.symbol} ${cell.timeframe} · ${def.label}`);
      console.log(`  No candles in DB. Pull/seed data first (npm run pull:candles).`);
      continue;
    }
    printCell(cell.symbol, cell.timeframe, def, candles, is, oos, rLevels, priceLevels);
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
