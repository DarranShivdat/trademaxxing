/**
 * Reset candle data to REAL Twelve Data candles only, then re-run detection.
 *
 * Covers MULTIPLE instruments (gold + forex majors). The DB previously held
 * mock seed candles concatenated with real candles, producing an artificial
 * price seam mid-series — so any signal across that seam was an artifact, not
 * real market structure. Each instrument here is pulled fresh from a SINGLE
 * source (Twelve Data), so there is no seam by construction.
 *
 * This script:
 *   1. UPSERTS each instrument's reference row (correct precision per asset:
 *      gold ~2 decimals, forex ~5).
 *   2. WIPES all candles, and the signals/features derived from them.
 *   3. PULLS a deep batch of real candles for every instrument × timeframe,
 *      respecting the ~8 req/min free-tier limit (the provider serializes +
 *      spaces requests itself, so this is intentionally slow).
 *   4. VERIFIES there is no price discontinuity in any series.
 *   5. RE-RUNS detection so every signal reflects real market structure only.
 *
 * Reference users and paper trades are left untouched.
 *
 *   npm run reset:candles
 *
 * Requires TWELVE_DATA_API_KEY in .env.local (or the environment).
 *
 * HISTORY DEPTH (free tier, single request per cell — see API probes):
 *   - 1day  is NOT output-capped: we request from 2005 and take whatever the
 *           tier serves (up to the 5000-row cap — typically a deep multi-year
 *           history). This is the rich source of trades.
 *   - 1h    is hard-capped at 5000 rows → the most recent ~7-8 months.
 *   - 15min is hard-capped at 5000 rows → the most recent ~7-8 weeks.
 *   Going deeper on the intraday frames would require paginating backwards
 *   (many more requests); 5000 rows/cell is already a substantial sample, so
 *   we take the single-request max and report exactly what landed.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { TwelveDataProvider } from "../src/lib/providers/market-data/twelve-data";
import { runDetection } from "../src/lib/pipeline/detect";
import { prisma } from "../src/lib/db";
import type { Timeframe } from "../src/lib/types";

interface InstrumentSpec {
  symbol: string;
  name: string;
  type: "FOREX" | "COMMODITY";
  basePrecision: number;
  quotePrecision: number;
  /**
   * Per-timeframe start-date overrides (defaults come from PULL_SPEC). Used to
   * skip a region of bad source data for one instrument without affecting the
   * others — see EUR/USD below.
   */
  sinceOverride?: Partial<Record<Timeframe, string>>;
}

// Real instruments. Forex majors carry ~5 decimal places (1.13775), gold ~2
// (4035.49) — quotePrecision is display metadata only; the engine and backtest
// work on raw float prices and R-multiples, so precision does not change any
// computed result.
const INSTRUMENTS: InstrumentSpec[] = [
  {
    symbol: "XAU/USD",
    name: "Gold / US Dollar",
    type: "COMMODITY",
    basePrecision: 2,
    quotePrecision: 2,
  },
  {
    symbol: "EUR/USD",
    name: "Euro / US Dollar",
    type: "FOREX",
    basePrecision: 5,
    quotePrecision: 5,
    // Twelve Data's free-tier EUR/USD DAILY history has corrupt prints across
    // 2008 (isolated bars spike ~6-17% to e.g. 1.5571 then revert next day —
    // physically impossible for EUR/USD, which ranged ~1.27-1.47 that year).
    // Intraday EUR/USD and 2009-onward daily are clean, so we start the daily
    // series in 2009 to exclude the bad region. (XAU/GBP daily verified clean
    // back to their full range — their large daily moves are real events.)
    sinceOverride: { "1day": "2009-01-01" },
  },
  {
    symbol: "GBP/USD",
    name: "British Pound / US Dollar",
    type: "FOREX",
    basePrecision: 5,
    quotePrecision: 5,
  },
];

// Per-timeframe history windows, expressed as a start date so daily can reach
// back years. `to` is always "now". The provider requests outputsize=5000, so
// intraday frames return the most-recent 5000 rows regardless of how early the
// start is; daily returns everything available up to that cap.
const PULL_SPEC: { timeframe: Timeframe; since: string }[] = [
  { timeframe: "15min", since: "2025-01-01" }, // → ~5000 rows (recent weeks)
  { timeframe: "1h", since: "2024-01-01" }, //    → ~5000 rows (recent months)
  { timeframe: "1day", since: "2005-01-01" }, //  → deep multi-year history
];

// A consecutive close-to-close move beyond this % is flagged as a possible
// discontinuity. Thresholds are per-timeframe because daily bars legitimately
// move far more than intraday ones — a ~7% day is real volatility, a ~7% jump
// between two 15min bars is not. Either way these sit far below the old
// mock→real seam (~58%), which is what this check is meant to catch.
const DISCONTINUITY_PCT: Record<Timeframe, number> = {
  "1min": 3,
  "5min": 3,
  "15min": 3,
  "1h": 4,
  "4h": 8,
  "1day": 12,
};

async function wipe(): Promise<void> {
  // Order matters only for clarity; signals cascade-delete their reviews.
  const features = await prisma.feature.deleteMany({});
  const signals = await prisma.signal.deleteMany({});
  const candles = await prisma.candle.deleteMany({});
  console.log(
    `WIPE: ${candles.count} candles, ${signals.count} signals (+ cascaded reviews), ` +
      `${features.count} features deleted. (instruments / users / paper_trades untouched)`,
  );
}

async function pullTimeframe(
  provider: TwelveDataProvider,
  symbol: string,
  timeframe: Timeframe,
  since: string,
): Promise<number> {
  const to = new Date();
  const from = new Date(`${since}T00:00:00Z`);
  console.log(`PULL ${symbol} ${timeframe}: ${from.toISOString()} → ${to.toISOString()}…`);

  // The provider retries on rate-limit (429) but rethrows transient network
  // errors (DNS/connect timeouts). Over a long 9-cell pull a single blip
  // shouldn't abort everything, so retry network failures here with backoff.
  let candles;
  for (let attempt = 1; ; attempt++) {
    try {
      candles = await provider.getCandles(symbol, timeframe, from, to);
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      const wait = 5000 * attempt;
      console.log(`  network error (attempt ${attempt}): ${(err as Error).message} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // Candles were just wiped, so a plain create is safe (no duplicate keys).
  for (const c of candles) {
    await prisma.candle.create({
      data: {
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
  }
  console.log(`  wrote ${candles.length} real candles`);
  return candles.length;
}

interface SeamCheck {
  count: number;
  maxPct: number;
  atTime: string | null;
  fromClose: number | null;
  toClose: number | null;
}

/** Largest consecutive close-to-close % move for a series (seam detector). */
async function checkContinuity(symbol: string, timeframe: Timeframe): Promise<SeamCheck> {
  const rows = await prisma.candle.findMany({
    where: { symbol, timeframe },
    orderBy: { openTime: "asc" },
    select: { openTime: true, close: true },
  });

  let maxPct = 0;
  let atTime: string | null = null;
  let fromClose: number | null = null;
  let toClose: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    const cur = rows[i].close;
    if (prev === 0) continue;
    const pct = Math.abs((cur - prev) / prev) * 100;
    if (pct > maxPct) {
      maxPct = pct;
      atTime = rows[i].openTime.toISOString();
      fromClose = prev;
      toClose = cur;
    }
  }
  return { count: rows.length, maxPct, atTime, fromClose, toClose };
}

interface CellResult {
  symbol: string;
  timeframe: Timeframe;
  written: number;
  seam: SeamCheck;
  flagged: boolean;
  detected: number;
  rejected: number;
  persisted: number;
  scanned: number;
}

async function main(): Promise<void> {
  const provider = new TwelveDataProvider();

  // --- reference data: upsert every instrument (idempotent) ---
  for (const inst of INSTRUMENTS) {
    await prisma.instrument.upsert({
      where: { symbol: inst.symbol },
      update: {
        name: inst.name,
        type: inst.type,
        basePrecision: inst.basePrecision,
        quotePrecision: inst.quotePrecision,
        active: true,
      },
      create: {
        symbol: inst.symbol,
        name: inst.name,
        type: inst.type,
        basePrecision: inst.basePrecision,
        quotePrecision: inst.quotePrecision,
      },
    });
  }
  console.log(
    `INSTRUMENTS: ${INSTRUMENTS.map((i) => `${i.symbol}(p${i.quotePrecision})`).join(", ")}`,
  );

  await wipe();

  // --- pull real candles, one request per instrument × timeframe ---
  // (rate-limited by the provider; this is intentionally slow.)
  const cells: CellResult[] = [];
  for (const inst of INSTRUMENTS) {
    for (const { timeframe, since } of PULL_SPEC) {
      const start = inst.sinceOverride?.[timeframe] ?? since;
      const written = await pullTimeframe(provider, inst.symbol, timeframe, start);
      cells.push({
        symbol: inst.symbol,
        timeframe,
        written,
        seam: { count: 0, maxPct: 0, atTime: null, fromClose: null, toClose: null },
        flagged: false,
        detected: 0,
        rejected: 0,
        persisted: 0,
        scanned: 0,
      });
    }
  }

  // --- verify no discontinuity in any series ---
  console.log("\nCONTINUITY CHECK (largest consecutive close-to-close move):");
  let anyFlagged = false;
  for (const cell of cells) {
    const seam = await checkContinuity(cell.symbol, cell.timeframe);
    cell.seam = seam;
    cell.flagged = seam.maxPct > DISCONTINUITY_PCT[cell.timeframe];
    anyFlagged = anyFlagged || cell.flagged;
    console.log(
      `  ${cell.symbol.padEnd(8)} ${cell.timeframe.padEnd(6)} ${String(seam.count).padStart(5)} bars · ` +
        `max move ${seam.maxPct.toFixed(2)}%` +
        (seam.atTime ? ` (${seam.fromClose}→${seam.toClose} @ ${seam.atTime})` : "") +
        (cell.flagged ? "  ⚠️ POSSIBLE SEAM" : "  ✓"),
    );
  }

  // --- re-run detection on each series (clean data only) ---
  console.log("\nDETECTION (clean real data):");
  for (const cell of cells) {
    const res = await runDetection({ symbol: cell.symbol, timeframe: cell.timeframe });
    cell.detected = res.detected;
    cell.rejected = res.rejected;
    cell.persisted = res.persisted;
    cell.scanned = res.candles;
    console.log(
      `  ${cell.symbol.padEnd(8)} ${cell.timeframe.padEnd(6)} scanned ${res.candles} · detected ${res.detected} · ` +
        `rejected ${res.rejected} · persisted ${res.persisted}`,
    );
  }

  // --- final report ---
  const totalCandles = cells.reduce((a, c) => a + c.written, 0);
  const totalSignals = await prisma.signal.count();
  console.log("\n================ RESULT ================");
  for (const cell of cells) {
    console.log(
      `  ${cell.symbol.padEnd(8)} ${cell.timeframe.padEnd(6)} ${String(cell.seam.count).padStart(5)} real candles · ` +
        `${cell.persisted} signals · max move ${cell.seam.maxPct.toFixed(2)}%`,
    );
  }
  console.log(`  TOTAL  ${totalCandles} real candles across ${cells.length} series · ${totalSignals} signals`);
  console.log(
    anyFlagged
      ? "  ⚠️ A series still shows a large jump — investigate above."
      : "  ✓ No price discontinuity in any series (all moves within normal range).",
  );
  console.log("========================================");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
