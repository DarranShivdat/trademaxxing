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
 * HISTORY DEPTH (free tier):
 *   - 1day  is NOT output-capped: a single request from 2005 returns whatever
 *           the tier serves (up to the 5000-row cap — a deep multi-year history).
 *   - 1h / 15min are hard-capped at 5000 rows PER REQUEST. A single request
 *           therefore only reaches ~7-8 months (1h) / ~7-8 weeks (15min). To go
 *           deeper we PAGINATE backwards: successive [from,to] windows, each
 *           sized to hold well under 5000 bars (so order=ASC never truncates),
 *           stitched into one contiguous series via idempotent upsert. The
 *           provider serializes + spaces every window through the ~8 req/min
 *           limiter, so a deep pull is intentionally slow (tens of minutes).
 *   - DEPTH POLICY is per instrument × timeframe (see INSTRUMENTS):
 *           XAU/USD 15min+1h walk back UNTIL DRY (as deep as the tier serves —
 *           these are the positive-expectancy cells we need to grow past 30
 *           trades); EUR/USD and GBP/USD intraday are capped at ~2 years for
 *           comparison without spending the whole rate budget on them.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { TwelveDataProvider } from "../src/lib/providers/market-data/twelve-data";
import { runDetection } from "../src/lib/pipeline/detect";
import { prisma } from "../src/lib/db";
import type { Candle, Timeframe } from "../src/lib/types";

/**
 * Backward-walk floor for a paginated intraday pull:
 *   - "dry"          → keep walking back until the tier returns an empty window
 *                      (pull as deep as the data goes).
 *   - "YYYY-MM-DD"   → stop once the series reaches this date.
 *   - undefined      → default to DEFAULT_INTRADAY_YEARS back from now.
 */
type IntradayDepth = "dry" | string;

interface InstrumentSpec {
  symbol: string;
  name: string;
  type: "FOREX" | "COMMODITY";
  basePrecision: number;
  quotePrecision: number;
  /**
   * Per-timeframe start-date overrides for the SINGLE-request daily pull
   * (default is DAILY_SINCE). Used to skip a region of bad source data for one
   * instrument without affecting the others — see EUR/USD below.
   */
  sinceOverride?: Partial<Record<Timeframe, string>>;
  /**
   * Per-timeframe depth policy for the PAGINATED intraday pulls (15min / 1h).
   * Absent timeframes fall back to a DEFAULT_INTRADAY_YEARS cap.
   */
  intradayDepth?: Partial<Record<Timeframe, IntradayDepth>>;
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
    // Gold intraday is the priority: its tiny 15min/1h samples showed positive
    // expectancy, so we pull as deep as the tier allows to see if the edge
    // survives a real sample size. "dry" = walk back until windows come up empty.
    intradayDepth: { "15min": "dry", "1h": "dry" },
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

// Timeframes pulled per instrument, in priority order. 15min and 1h are pulled
// FIRST (and, for XAU, deepest) so the gold intraday cells are complete before
// any rate budget is spent elsewhere. 1day is a single uncapped request.
const TIMEFRAMES_TO_PULL: Timeframe[] = ["15min", "1h", "1day"];

// Start date for the single-request daily pull (overridable per instrument —
// EUR/USD starts in 2009 to skip its corrupt 2008 prints, see below).
const DAILY_SINCE = "2005-01-01";

// Default depth cap for paginated intraday frames when an instrument doesn't
// set an explicit policy: walk back this many years, then stop.
const DEFAULT_INTRADAY_YEARS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// Pagination window span (calendar days) per intraday timeframe. Each window is
// sized to return WELL under the 5000-row cap (~2k bars), because order=ASC +
// the cap would otherwise silently keep only the earliest 5000 rows of a window
// and drop the rest. Gold/forex trade ~23h × ~5 days/wk, so:
//   15min: 30d  ≈ 23·4·~21 ≈ 1,900 bars
//   1h:   120d  ≈ 23·1·~85 ≈ 1,950 bars
const WINDOW_DAYS: Partial<Record<Timeframe, number>> = {
  "15min": 30,
  "1h": 120,
};

// Hard ceiling on windows per cell so a misbehaving series can never loop
// forever. 400 windows × ~7.5s ≈ 50 min — far beyond any real depth need.
const MAX_WINDOWS_PER_CELL = 400;

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

/**
 * Fetch one window, retrying transient NETWORK errors (the provider already
 * retries rate-limit 429s, but rethrows DNS/connect blips). Over a long
 * multi-window pull a single blip shouldn't abort the run.
 */
async function fetchWindow(
  provider: TwelveDataProvider,
  symbol: string,
  timeframe: Timeframe,
  from: Date,
  to: Date,
): Promise<Candle[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.getCandles(symbol, timeframe, from, to);
    } catch (err) {
      if (attempt >= 4) throw err;
      const wait = 5000 * attempt;
      console.log(`  network error (attempt ${attempt}): ${(err as Error).message} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * Upsert a batch of candles. Upsert (not create) so overlapping window edges
 * and any resume/re-run are idempotent — the unique [symbol,timeframe,openTime]
 * key collapses duplicates instead of throwing.
 */
async function writeCandles(rows: Candle[]): Promise<void> {
  for (const c of rows) {
    const data = {
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      source: "twelve_data",
    };
    await prisma.candle.upsert({
      where: {
        symbol_timeframe_openTime: {
          symbol: c.symbol,
          timeframe: c.timeframe,
          openTime: c.openTime,
        },
      },
      update: data,
      create: { symbol: c.symbol, timeframe: c.timeframe, openTime: c.openTime, ...data },
    });
  }
}

/** Single uncapped request — used for the daily frame (not output-capped). */
async function pullSingle(
  provider: TwelveDataProvider,
  symbol: string,
  timeframe: Timeframe,
  since: string,
): Promise<number> {
  const to = new Date();
  const from = new Date(`${since}T00:00:00Z`);
  console.log(`PULL ${symbol} ${timeframe}: ${from.toISOString()} → ${to.toISOString()} (single request)…`);
  const candles = await fetchWindow(provider, symbol, timeframe, from, to);
  await writeCandles(candles);
  console.log(`  wrote ${candles.length} real candles`);
  return candles.length;
}

/** Resolve the backward-walk floor date for a paginated intraday pull. */
function intradayFloor(inst: InstrumentSpec, timeframe: Timeframe): Date {
  const policy = inst.intradayDepth?.[timeframe];
  if (policy === "dry") return new Date("2000-01-01T00:00:00Z"); // effectively unlimited
  if (typeof policy === "string") return new Date(`${policy}T00:00:00Z`);
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - DEFAULT_INTRADAY_YEARS);
  return d;
}

/**
 * Paginated backward walk for an intraday frame. Fetches successive [from,to]
 * windows from now toward `floor`, stitching them into one contiguous series.
 * Stops when a window comes back empty (hit the tier's history floor), the
 * series reaches `floor`, or no backward progress is made.
 */
async function pullPaginated(
  provider: TwelveDataProvider,
  symbol: string,
  timeframe: Timeframe,
  floor: Date,
): Promise<number> {
  let span = WINDOW_DAYS[timeframe] ?? 30;
  let cursor = new Date(); // upper bound of the next window ("to"), walks backward
  let prevEarliest = Infinity;
  let total = 0;

  for (let windows = 0; windows < MAX_WINDOWS_PER_CELL; windows++) {
    const lowerBound = (): Date => {
      const f = new Date(cursor.getTime() - span * DAY_MS);
      return f < floor ? new Date(floor) : f;
    };
    let from = lowerBound();
    let rows = await fetchWindow(provider, symbol, timeframe, from, cursor);

    // Truncation guard: a window holding ≥5000 bars was capped, so order=ASC
    // kept only its earliest 5000 and dropped the newest. Shrink and refetch.
    for (let guard = 0; rows.length >= 5000 && span > 2 && guard < 6; guard++) {
      span = Math.max(2, Math.floor(span / 2));
      from = lowerBound();
      console.log(`  window hit the 5000-row cap — shrinking span to ${span}d and refetching`);
      rows = await fetchWindow(provider, symbol, timeframe, from, cursor);
    }

    if (rows.length === 0) {
      console.log(
        `  empty window ${from.toISOString().slice(0, 10)}→${cursor.toISOString().slice(0, 10)} — history floor reached`,
      );
      break;
    }

    await writeCandles(rows);
    total += rows.length;
    const earliest = rows[0].openTime; // ASC order → first row is oldest
    console.log(
      `  ${symbol} ${timeframe}: +${rows.length} rows  ` +
        `[${earliest.toISOString().slice(0, 16)} … ${cursor.toISOString().slice(0, 16)}]`,
    );

    if (earliest.getTime() <= floor.getTime()) break; // reached configured floor
    if (earliest.getTime() >= prevEarliest) break; // no backward progress — stop
    prevEarliest = earliest.getTime();
    cursor = earliest; // overlap one bar into the next window; upsert dedupes it
  }

  console.log(`  wrote ${total} real candles across paginated windows`);
  return total;
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

  // --- pull real candles per instrument × timeframe ---
  // Daily is one request; intraday paginates backward over many windows. Every
  // request is rate-limited by the provider, so this is intentionally slow.
  const cells: CellResult[] = [];
  for (const inst of INSTRUMENTS) {
    for (const timeframe of TIMEFRAMES_TO_PULL) {
      let written: number;
      if (timeframe === "1day") {
        const start = inst.sinceOverride?.[timeframe] ?? DAILY_SINCE;
        written = await pullSingle(provider, inst.symbol, timeframe, start);
      } else {
        const floor = intradayFloor(inst, timeframe);
        const mode = inst.intradayDepth?.[timeframe] === "dry" ? "until-dry" : "capped";
        console.log(
          `PULL ${inst.symbol} ${timeframe}: paginating back toward ` +
            `${floor.toISOString().slice(0, 10)} (${mode})…`,
        );
        written = await pullPaginated(provider, inst.symbol, timeframe, floor);
      }
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
  // Count from the continuity check (authoritative DB count) rather than
  // `written`, which on paginated frames includes the one-bar overlaps that
  // upsert collapsed.
  const totalCandles = cells.reduce((a, c) => a + c.seam.count, 0);
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
