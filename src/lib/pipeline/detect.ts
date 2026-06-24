// Detection pipeline — the glue that runs the engine over real candles.
//
// Loads candles from the DB, walks the series running `detectTrendPullbackAt`
// at each index (the engine slices to candles[0..n] internally, so this honors
// no-lookahead by construction), runs every produced Setup through
// `evaluateRisk`, and persists the survivors as Signal rows together with the
// RiskDecision that let them through.
//
// This module owns NO trading logic — it only orchestrates the frozen engine
// (detect + risk) and Prisma. It is the single source of truth shared by the
// CLI script (`scripts/detect-signals.ts`) and the API/cron route
// (`POST /api/detect`).

import type { Candle, RiskDecision, Setup, Timeframe } from "@/lib/types";
import { prisma } from "@/lib/db";
import { detectTrendPullbackAt } from "@/lib/engine/setups/trend-pullback";
import { evaluateRisk, type ExistingSignal, type RiskContext } from "@/lib/engine/risk";
import { explainSignal, persistSignalExplanation } from "@/lib/llm";

export interface RunDetectionOptions {
  /** Instrument symbol to scan. Default "XAU/USD". */
  symbol?: string;
  /** Timeframe to scan. Default "1h". */
  timeframe?: Timeframe;
  /** Account equity used for position sizing in the risk check. Default 10000. */
  accountEquity?: number;
  /** Risk per trade as % of equity. Default 1. */
  riskPerTradePct?: number;
  /** Max trades/day cap fed to the risk check. Default 2. */
  maxTradesPerDay?: number;
  /** Trades already taken today, fed to the risk check. Default 0. */
  tradesToday?: number;
  /**
   * Call the LLM explainer for each newly persisted signal and store the review.
   * Best-effort: failures are logged, never fatal. Default false.
   */
  explain?: boolean;
  /** Override the explainer model (else provider default, Haiku). */
  explainModel?: string;
}

export interface PersistedSignalSummary {
  signalId: string;
  barTime: string;
  direction: Setup["direction"];
  confidence: number;
  verdict: RiskDecision["verdict"];
  explained: boolean;
}

export interface RunDetectionResult {
  symbol: string;
  timeframe: Timeframe;
  candles: number;
  /** Bars at which the engine produced a Setup. */
  detected: number;
  /** Setups rejected by the risk check (not persisted). */
  rejected: number;
  /** Detections skipped because that bar already has a signal. */
  skipped: number;
  /** Signals written this run. */
  persisted: number;
  signals: PersistedSignalSummary[];
}

const DEFAULTS = {
  symbol: "XAU/USD",
  timeframe: "1h" as Timeframe,
  accountEquity: 10_000,
  riskPerTradePct: 1,
  maxTradesPerDay: 2,
  tradesToday: 0,
};

/** Load candles for a symbol/timeframe as the engine's Candle shape, oldest first. */
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

/** The bar time a stored setup was detected at, if recoverable. */
function setupBarTime(setup: Setup): string | null {
  const t = (setup.rawFeatures as Record<string, unknown>)?.time;
  if (typeof t === "string") return new Date(t).toISOString();
  if (t instanceof Date) return t.toISOString();
  return null;
}

/**
 * Run the detection pipeline. Idempotent: bars that already produced a signal
 * are skipped, and overlapping setups dedupe through the risk engine's
 * same-zone rule (existing NEW signals + ones persisted earlier this run are
 * fed back in as `existingSignals`).
 */
export async function runDetection(
  options: RunDetectionOptions = {},
): Promise<RunDetectionResult> {
  // Coalesce per-field: spreading `options` would let an explicit `undefined`
  // (e.g. from a CLI arg that wasn't passed) clobber a default.
  const opts = {
    symbol: options.symbol ?? DEFAULTS.symbol,
    timeframe: options.timeframe ?? DEFAULTS.timeframe,
    accountEquity: options.accountEquity ?? DEFAULTS.accountEquity,
    riskPerTradePct: options.riskPerTradePct ?? DEFAULTS.riskPerTradePct,
    maxTradesPerDay: options.maxTradesPerDay ?? DEFAULTS.maxTradesPerDay,
    tradesToday: options.tradesToday ?? DEFAULTS.tradesToday,
    explain: options.explain ?? false,
    explainModel: options.explainModel,
  };
  const candles = await loadCandles(opts.symbol, opts.timeframe);

  // Existing signals for this symbol/timeframe. Idempotency (seenBarTimes) must
  // consider EVERY status: a signal that was since REVIEWED or EXPIRED still
  // means we already produced one for that bar and must not re-emit it. Zone
  // dedup fed to the risk check, however, only blocks against still-active
  // (NEW) signals.
  const existingRows = await prisma.signal.findMany({
    where: { symbol: opts.symbol, timeframe: opts.timeframe },
  });
  const existingSignals: ExistingSignal[] = [];
  const seenBarTimes = new Set<string>();
  for (const row of existingRows) {
    try {
      const setup = JSON.parse(row.setup) as Setup;
      const bt = setupBarTime(setup);
      if (bt) seenBarTimes.add(bt);
      if (row.status === "NEW") {
        existingSignals.push({ direction: setup.direction, entryZone: setup.entryZone });
      }
    } catch {
      // ignore unparseable legacy rows
    }
  }

  const result: RunDetectionResult = {
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    candles: candles.length,
    detected: 0,
    rejected: 0,
    skipped: 0,
    persisted: 0,
    signals: [],
  };

  for (let n = 0; n < candles.length; n++) {
    const bar = candles[n];
    const hour = bar.openTime.getUTCHours();
    const setup = detectTrendPullbackAt(candles, n, {
      // Honest execution context for confidence: London/NY hours count as a
      // preferred session. Spread/news are unknown for historical bars.
      context: { goodSession: hour >= 7 && hour < 21 },
    });
    if (!setup) continue;
    result.detected += 1;

    const barTime = bar.openTime.toISOString();
    if (seenBarTimes.has(barTime)) {
      result.skipped += 1;
      continue;
    }

    const ctx: RiskContext = {
      accountEquity: opts.accountEquity,
      riskPerTradePct: opts.riskPerTradePct,
      maxTradesPerDay: opts.maxTradesPerDay,
      tradesToday: opts.tradesToday,
      existingSignals,
    };
    const decision = evaluateRisk(setup, ctx);
    if (decision.verdict === "REJECTED") {
      result.rejected += 1;
      continue;
    }

    const created = await prisma.signal.create({
      data: {
        symbol: setup.symbol,
        timeframe: setup.timeframe,
        direction: setup.direction,
        setup: JSON.stringify(setup),
        confidence: setup.confidence,
        status: "NEW",
        risk: JSON.stringify(decision),
      },
    });

    // Feed the new signal back so subsequent overlapping bars dedupe.
    existingSignals.push({ direction: setup.direction, entryZone: setup.entryZone });
    seenBarTimes.add(barTime);

    let explained = false;
    if (opts.explain) {
      try {
        const explanation = await explainSignal(setup, { model: opts.explainModel });
        await persistSignalExplanation(created.id, explanation);
        explained = true;
      } catch (err) {
        // Best-effort: a missing API key or LLM error must not fail detection.
        console.warn(
          `explainSignal failed for ${created.id}: ${(err as Error).message}`,
        );
      }
    }

    result.persisted += 1;
    result.signals.push({
      signalId: created.id,
      barTime,
      direction: setup.direction,
      confidence: setup.confidence,
      verdict: decision.verdict,
      explained,
    });
  }

  return result;
}
