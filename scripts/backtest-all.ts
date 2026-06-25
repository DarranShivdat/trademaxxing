/**
 * Backtest EVERY setup across EVERY instrument × timeframe in the DB and print
 * an honest summary — broken out PER SETUP so we can see whether Breakout-Retest
 * or NY-Reversal carry an edge SEPARATELY from Trend-Pullback.
 *
 *   npm run backtest:all
 *   npm run backtest:all -- --equity 25000
 *   npm run backtest:all -- --setup breakout-retest     # restrict to one setup
 *
 * This is an ORCHESTRATOR only: it reuses the existing, unmodified backtest
 * library (`runBacktest` + `computeBacktestStats`) exactly as `npm run backtest`
 * does, once per (setup × instrument × timeframe) cell, then POOLS resolved
 * trades — per setup, and finally across everything. A single cell may be too
 * thin to mean anything on its own; the per-setup pool is what tells us whether
 * THAT setup has an edge.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { Candle, Timeframe } from "../src/lib/types";
import { TIMEFRAMES } from "../src/lib/types";
import { runBacktest, type BacktestTrade } from "../src/lib/backtest/run";
import type { FeatureSet } from "../src/lib/engine/features";
import { computeBacktestStats, profitFactorR } from "../src/lib/backtest/metrics";
import { SETUPS, setupBySlug, type SetupDef } from "../src/lib/setups";
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

// `profitFactorR` (R-based, asset-agnostic pooling) now lives in the backtest
// library so it is shared and unit-tested; see src/lib/backtest/metrics.ts.

interface Cell {
  setup: SetupDef;
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

/** Per-cell table for a set of cells (assumed same setup). */
function printCellTable(cells: Cell[]) {
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
}

/**
 * Pooled COMBINED stats over a set of cells, with the honesty gate. `scopeLabel`
 * names what is being pooled (a setup, or everything).
 */
function printCombined(scopeLabel: string, cells: Cell[]) {
  const totDetected = cells.reduce((a, c) => a + c.detected, 0);
  const totApproved = cells.reduce((a, c) => a + c.approved, 0);
  const totOpen = cells.reduce((a, c) => a + c.open, 0);
  console.log("Pipeline (summed across cells)");
  console.log(`  setups detected ........ ${totDetected}`);
  console.log(`  trades taken ........... ${totApproved}`);
  console.log(`  still open (unresolved)  ${totOpen}`);
  console.log("");

  const pooled = cells.flatMap((c) => c.trades);
  const combined = computeBacktestStats(pooled);

  console.log(`========= COMBINED · ${scopeLabel} (cells pooled) =========`);
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

async function main() {
  const equityArg = arg("equity");
  const equity = equityArg ? Number(equityArg) : undefined;

  // Which setup(s) to run. Default: all of them.
  const setupArg = arg("setup");
  let setups: SetupDef[];
  if (!setupArg) {
    setups = SETUPS;
  } else {
    const def = setupBySlug(setupArg);
    if (!def) {
      throw new Error(
        `Invalid --setup "${setupArg}". One of: ${SETUPS.map((s) => s.slug).join(", ")}`,
      );
    }
    setups = [def];
  }

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

  // Load each instrument/timeframe's candles ONCE, then run every setup over
  // them — detection is cheap relative to repeated DB loads.
  const cells: Cell[] = [];
  for (const symbol of symbols) {
    for (const timeframe of TF_ORDER) {
      const candles = await loadCandles(symbol, timeframe);
      if (candles.length === 0) continue;
      const start = candles[0].openTime.toISOString().slice(0, 10);
      const end = candles[candles.length - 1].openTime.toISOString().slice(0, 10);

      for (const setup of setups) {
        // Prefer the setup's stateful scanner (identical signals, scales to long
        // series); fall back to the stateless detector. Fresh per cell.
        const detect = setup.makeScanner
          ? setup.makeScanner()
          : (c: Candle[], n: number, f?: FeatureSet | null) =>
              setup.detect(c, n, undefined, f);
        const result = runBacktest(candles, {
          accountEquity: equity,
          detect,
        });
        const stats = computeBacktestStats(result.trades);
        cells.push({
          setup,
          symbol,
          timeframe,
          candles: candles.length,
          start,
          end,
          detected: result.detected,
          approved: result.approved,
          closed: stats.closedTrades,
          open: stats.openUnresolved,
          trades: result.trades,
        });
      }
    }
  }

  console.log("");
  console.log("Backtest — PER SETUP × instrument × timeframe");
  console.log(
    `  equity ${equity ?? 10000} · risk 1%/trade · ${setups.length} setup(s) · ${cells.length} cells`,
  );

  // ---- one section per setup: its cells, then its pooled combined ----
  for (const setup of setups) {
    const setupCells = cells.filter((c) => c.setup.tag === setup.tag);
    console.log("");
    console.log(`################  ${setup.label}  ################`);
    console.log("");
    printCellTable(setupCells);
    console.log("");
    printCombined(setup.label, setupCells);
  }

  // ---- grand total across ALL setups (only when more than one ran) ----
  if (setups.length > 1) {
    console.log("");
    console.log("Note: the block below MIXES setups into one pool. Use it only");
    console.log("for an overall portfolio read — the per-setup blocks above are");
    console.log("what tell you whether each setup has an edge on its own.");
    console.log("");
    printCombined("ALL SETUPS", cells);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
