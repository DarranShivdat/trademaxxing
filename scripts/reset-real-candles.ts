/**
 * Reset candle data to REAL Twelve Data candles only, then re-run detection.
 *
 * The DB previously held mock seed candles (~$2,400 gold) concatenated with
 * real Twelve Data candles (~$4,300 gold), producing an artificial price seam
 * mid-series — so any signal detected across that seam was an artifact, not
 * real market structure.
 *
 * This script:
 *   1. WIPES all candles, and the signals/features derived from them.
 *   2. PULLS a clean batch of real XAU/USD candles (Twelve Data only) for each
 *      configured timeframe, respecting the ~8 req/min free-tier limit (the
 *      provider serializes + spaces requests itself).
 *   3. VERIFIES there is no price discontinuity in any timeframe.
 *   4. RE-RUNS detection so every signal reflects real market structure only.
 *
 * Reference data (users, instruments) and paper trades are left untouched.
 *
 *   npm run reset:candles
 *
 * Requires TWELVE_DATA_API_KEY in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { TwelveDataProvider } from "../src/lib/providers/market-data/twelve-data";
import { runDetection } from "../src/lib/pipeline/detect";
import { prisma } from "../src/lib/db";
import type { Timeframe } from "../src/lib/types";

const SYMBOL = "XAU/USD";

// Per-timeframe history windows. The engine seeds EMA200, so a setup can only
// form once >200 bars exist — each window is sized comfortably above that.
// (Daily history depth may be capped by the Twelve Data free tier; we report
// whatever actually lands rather than assuming a count.)
const PULL_SPEC: { timeframe: Timeframe; days: number }[] = [
  { timeframe: "15min", days: 30 }, // ~1,900 bars
  { timeframe: "1h", days: 90 }, // ~1,400 bars
  { timeframe: "1day", days: 800 }, // ~550 trading bars (subject to free-tier history)
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
  timeframe: Timeframe,
  days: number,
): Promise<number> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  console.log(`PULL ${SYMBOL} ${timeframe}: ${from.toISOString()} → ${to.toISOString()}…`);

  const candles = await provider.getCandles(SYMBOL, timeframe, from, to);
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

/** Largest consecutive close-to-close % move for a timeframe (seam detector). */
async function checkContinuity(timeframe: Timeframe): Promise<SeamCheck> {
  const rows = await prisma.candle.findMany({
    where: { symbol: SYMBOL, timeframe },
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

async function main(): Promise<void> {
  const provider = new TwelveDataProvider();

  // Reference data: make sure the instrument exists (idempotent).
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

  await wipe();

  // --- pull real candles, one request per timeframe (rate-limited) ---
  const pulled: { timeframe: Timeframe; written: number }[] = [];
  for (const { timeframe, days } of PULL_SPEC) {
    const written = await pullTimeframe(provider, timeframe, days);
    pulled.push({ timeframe, written });
  }

  // --- verify no discontinuity in any timeframe ---
  console.log("\nCONTINUITY CHECK (largest consecutive close-to-close move):");
  const seams: Record<string, SeamCheck> = {};
  let anyFlagged = false;
  for (const { timeframe } of PULL_SPEC) {
    const seam = await checkContinuity(timeframe);
    seams[timeframe] = seam;
    const flagged = seam.maxPct > DISCONTINUITY_PCT[timeframe];
    anyFlagged = anyFlagged || flagged;
    console.log(
      `  ${timeframe.padEnd(6)} ${String(seam.count).padStart(5)} bars · ` +
        `max move ${seam.maxPct.toFixed(2)}%` +
        (seam.atTime
          ? ` (${seam.fromClose}→${seam.toClose} @ ${seam.atTime})`
          : "") +
        (flagged ? "  ⚠️ POSSIBLE SEAM" : "  ✓"),
    );
  }

  // --- re-run detection on each pulled timeframe (clean data only) ---
  console.log("\nDETECTION (clean real data):");
  const detection: Record<string, { detected: number; persisted: number; rejected: number }> = {};
  for (const { timeframe } of PULL_SPEC) {
    const res = await runDetection({ symbol: SYMBOL, timeframe });
    detection[timeframe] = {
      detected: res.detected,
      persisted: res.persisted,
      rejected: res.rejected,
    };
    console.log(
      `  ${timeframe.padEnd(6)} scanned ${res.candles} · detected ${res.detected} · ` +
        `rejected ${res.rejected} · persisted ${res.persisted}`,
    );
  }

  // --- final report ---
  const totalCandles = pulled.reduce((a, p) => a + p.written, 0);
  const totalSignals = await prisma.signal.count();
  console.log("\n================ RESULT ================");
  for (const { timeframe } of PULL_SPEC) {
    const seam = seams[timeframe];
    const det = detection[timeframe];
    console.log(
      `  ${timeframe.padEnd(6)} ${String(seam.count).padStart(5)} real candles · ` +
        `${det.persisted} signals · max move ${seam.maxPct.toFixed(2)}%`,
    );
  }
  console.log(`  TOTAL  ${totalCandles} real candles · ${totalSignals} signals`);
  console.log(
    anyFlagged
      ? "  ⚠️ A timeframe still shows a large jump — investigate above."
      : "  ✓ No price discontinuity in any timeframe (all moves within normal range).",
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
