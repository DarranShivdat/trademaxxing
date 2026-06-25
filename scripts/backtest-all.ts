/**
 * Backtest the trend-pullback strategy across EVERY instrument × timeframe in
 * the DB and print an honest combined summary.
 *
 *   npm run backtest:all
 *   npm run backtest:all -- --equity 25000
 *
 * This is an ORCHESTRATOR only: it reuses the existing, unmodified backtest
 * library (`runBacktest` + `computeBacktestStats`) exactly as `npm run backtest`
 * does, once per cell, then POOLS every resolved trade across all cells and
 * runs the same stats function on the pool. The combined trade count is the
 * headline — a single cell may be too thin to mean anything on its own, but the
 * aggregate is what tells us whether there is an edge.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { Candle, Timeframe } from "../src/lib/types";
import { TIMEFRAMES } from "../src/lib/types";
import { runBacktest, type BacktestTrade } from "../src/lib/backtest/run";
import { computeBacktestStats } from "../src/lib/backtest/metrics";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Minimum closed trades before a per-cell win rate / edge claim means anything. */
const MIN_MEANINGFUL = 30;

// The timeframes we pull. (Instruments are discovered from the DB so the table
// always matches whatever was actually loaded.)
const TF_ORDER: Timeframe[] = ["15min", "1h", "1day"];

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

/**
 * Profit factor in R terms: Σ(winning R) / |Σ(losing R)|.
 *
 * The library's `profitFactor` sums raw price pnl (exit−entry), which is fine
 * for ONE instrument but invalid to pool across instruments: gold moves on a
 * ~4000 price scale and EUR/USD on a ~1.0 scale, so gold trades would dominate
 * a price-weighted combined figure. R is dimensionless (+riskReward on a win,
 * −1 on a loss), so an R-based profit factor aggregates honestly across assets.
 * We use it for every cell here so the table is internally consistent; the
 * single-cell `npm run backtest` keeps the library's price-based figure.
 */
function profitFactorR(trades: BacktestTrade[]): number {
  const resolved = trades.filter((t) => t.r !== null);
  const grossWin = resolved.filter((t) => (t.r ?? 0) > 0).reduce((a, t) => a + (t.r as number), 0);
  const grossLoss = Math.abs(
    resolved.filter((t) => (t.r ?? 0) < 0).reduce((a, t) => a + (t.r as number), 0),
  );
  if (grossLoss === 0) return grossWin > 0 ? Infinity : 0;
  return grossWin / grossLoss;
}

interface Cell {
  symbol: string;
  timeframe: Timeframe;
  candles: number;
  start: string;
  end: string;
  detected: number;
  approved: number;
  closed: number;
  open: number;
  trades: BacktestTrade[];
}

async function main() {
  const equityArg = arg("equity");
  const equity = equityArg ? Number(equityArg) : undefined;

  // Discover instruments from the candle table (every symbol that has data).
  const symbolRows = await prisma.candle.findMany({
    distinct: ["symbol"],
    select: { symbol: true },
    orderBy: { symbol: "asc" },
  });
  const symbols = symbolRows.map((r) => r.symbol);

  if (symbols.length === 0) {
    console.log("No candles in DB. Pull data first (npm run reset:candles).");
    return;
  }

  const cells: Cell[] = [];
  for (const symbol of symbols) {
    for (const timeframe of TF_ORDER) {
      const candles = await loadCandles(symbol, timeframe);
      if (candles.length === 0) continue;

      const result = runBacktest(candles, { accountEquity: equity });
      const stats = computeBacktestStats(result.trades);
      cells.push({
        symbol,
        timeframe,
        candles: candles.length,
        start: candles[0].openTime.toISOString().slice(0, 10),
        end: candles[candles.length - 1].openTime.toISOString().slice(0, 10),
        detected: result.detected,
        approved: result.approved,
        closed: stats.closedTrades,
        open: stats.openUnresolved,
        trades: result.trades,
      });
    }
  }

  console.log("");
  console.log("Backtest — Trend Pullback · ALL instruments × timeframes");
  console.log(`  equity ${equity ?? 10000} · risk 1%/trade · ${cells.length} cells`);
  console.log("");

  // ---- per-cell table ----
  const head =
    "  " +
    "Instrument".padEnd(9) +
    "TF".padEnd(7) +
    "Candles".padStart(8) +
    "Trades".padStart(8) +
    "Win%".padStart(8) +
    "AvgR".padStart(8) +
    "Expect".padStart(8) +
    "PF(R)".padStart(7) +
    "  Period";
  console.log(head);
  console.log("  " + "─".repeat(head.length + 14));

  for (const cell of cells) {
    const s = computeBacktestStats(cell.trades);
    const thin = cell.closed > 0 && cell.closed < MIN_MEANINGFUL;
    const win = cell.closed > 0 ? pct(s.winRate) : "—";
    const avgR = cell.closed > 0 ? fmt(s.avgR) : "—";
    const exp = cell.closed > 0 ? fmt(s.expectancy) : "—";
    const pf = cell.closed > 0 ? fmt(profitFactorR(cell.trades)) : "—";
    console.log(
      "  " +
        cell.symbol.padEnd(9) +
        cell.timeframe.padEnd(7) +
        String(cell.candles).padStart(8) +
        String(cell.closed).padStart(8) +
        win.padStart(8) +
        avgR.padStart(8) +
        exp.padStart(8) +
        pf.padStart(7) +
        `  ${cell.start}→${cell.end}` +
        (cell.closed === 0 ? "  (no resolved trades)" : thin ? "  ⚠ <30" : ""),
    );
  }
  console.log("");

  // ---- pipeline totals (where do setups go?) ----
  const totDetected = cells.reduce((a, c) => a + c.detected, 0);
  const totApproved = cells.reduce((a, c) => a + c.approved, 0);
  const totOpen = cells.reduce((a, c) => a + c.open, 0);
  console.log("Pipeline (summed across cells)");
  console.log(`  setups detected ........ ${totDetected}`);
  console.log(`  trades taken ........... ${totApproved}`);
  console.log(`  still open (unresolved)  ${totOpen}`);
  console.log("");

  // ---- COMBINED stats over the pooled trade list ----
  const pooled = cells.flatMap((c) => c.trades);
  const combined = computeBacktestStats(pooled);

  console.log("================ COMBINED (all cells pooled) ================");
  console.log(`  RESOLVED TRADES ........ ${combined.closedTrades}`);
  console.log(`  still open ............. ${combined.openUnresolved}`);

  if (combined.closedTrades === 0) {
    console.log("");
    console.log("  No resolved trades anywhere — nothing to measure.");
    console.log("=============================================================");
    return;
  }

  console.log(`  wins / losses .......... ${combined.wins} / ${combined.losses}`);
  console.log(`  win rate ............... ${pct(combined.winRate)}`);
  console.log(`  avg R per trade ........ ${fmt(combined.avgR)}R`);
  console.log(`  expectancy ............. ${fmt(combined.expectancy)}R`);
  console.log(`    avg win / avg loss ... +${fmt(combined.avgWinR)}R / ${fmt(combined.avgLossR)}R`);
  console.log(`  total R ................ ${fmt(combined.totalR)}R`);
  console.log(`  profit factor (R) ...... ${fmt(profitFactorR(pooled))}   (R-based; see note)`);
  console.log(`  max drawdown ........... ${fmt(combined.maxDrawdownR)}R`);
  console.log("");

  // Honesty gate — per cell AND in aggregate.
  const thinCells = cells.filter((c) => c.closed > 0 && c.closed < MIN_MEANINGFUL);
  const emptyCells = cells.filter((c) => c.closed === 0);
  if (thinCells.length || emptyCells.length) {
    console.log("  Per-cell sample size is thin:");
    for (const c of emptyCells) {
      console.log(`    · ${c.symbol} ${c.timeframe}: 0 resolved trades (nothing to measure)`);
    }
    for (const c of thinCells) {
      console.log(`    · ${c.symbol} ${c.timeframe}: ${c.closed} trades (< ${MIN_MEANINGFUL}, anecdote only)`);
    }
    console.log("");
  }

  if (combined.closedTrades < MIN_MEANINGFUL) {
    console.log(
      `  ⚠ EVEN POOLED this is only ${combined.closedTrades} resolved trades (< ${MIN_MEANINGFUL}).\n` +
        `    Not yet a statistically meaningful read — treat as directional, not proof.`,
    );
  } else {
    console.log(
      `  ✓ COMBINED ${combined.closedTrades} resolved trades — past the ${MIN_MEANINGFUL}-trade\n` +
        `    floor, so the pooled win rate / expectancy is a meaningful first read of\n` +
        `    the edge (individual cells above may still be too thin to trust alone).`,
    );
  }
  console.log("=============================================================");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
