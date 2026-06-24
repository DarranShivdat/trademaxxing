// Journal review — needs genuine cross-trade reasoning, so it overrides the
// provider default and runs on Sonnet. Given recent PaperTrades, identify the
// best setups, recurring losing patterns, time-of-day weakness, overtrading,
// and rule violations, then suggest exactly ONE improvement.
//
// Statistics are computed deterministically in `computeJournalStats` and handed
// to the model — the model never fabricates numbers, places trades, or predicts
// price.

import type { LLMProvider } from "@/lib/providers";
import type { Direction, PaperTrade } from "@/lib/types";
import { prisma } from "@/lib/db";
import { getLLMProvider } from "./client";
import { asString, asStringArray, extractJsonObject } from "./json";
import { type JournalReview, type JournalStats, toUsageMeta } from "./types";

/** Journal review reasons across trades; override the Haiku default to Sonnet. */
export const JOURNAL_REVIEW_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a trading-performance coach reviewing a trader's paper-trading journal. You are a language/analysis tool, not a trader.

ABSOLUTE RULES:
- NEVER place, recommend, or size a trade, and NEVER predict future price or outcomes.
- Use ONLY the trades and the pre-computed statistics provided. Do NOT recompute, estimate, or invent any number — win rates, P&L, counts, and averages are given to you; cite them, never fabricate them.
- If the data is too sparse to support a claim (e.g. very few closed trades), say so explicitly instead of inventing a pattern.
- Ground every observation in the supplied stats or specific trades.

Your analysis must cover: best-performing setups/patterns, recurring losing patterns, time-of-day weakness, signs of overtrading, and apparent rule violations (e.g. reward-to-risk below plan, inconsistent sizing, clustering of trades). Then give exactly ONE concrete, prioritized improvement.

Respond with STRICT JSON only — no markdown, no text outside the JSON — matching exactly:
{
  "bestSetups": string[],
  "losingPatterns": string[],
  "timeOfDayWeakness": string,
  "overtrading": string,
  "ruleViolations": string[],
  "improvement": string,          // exactly one improvement
  "summary": string               // short readable narrative
}`;

function emptyDirectionBuckets(): JournalStats["byDirection"] {
  return {
    LONG: { trades: 0, wins: 0, losses: 0, pnl: 0 },
    SHORT: { trades: 0, wins: 0, losses: 0, pnl: 0 },
  };
}

/**
 * Compute deterministic journal statistics from a set of trades. Pure: no I/O,
 * no model. This is the single source of truth for every number the review
 * cites — the model is forbidden from computing its own.
 *
 * Win/loss classification applies to CLOSED trades only, by realized `pnl`.
 */
export function computeJournalStats(trades: readonly PaperTrade[]): JournalStats {
  const stats: JournalStats = {
    totalTrades: trades.length,
    openTrades: 0,
    closedTrades: 0,
    cancelledTrades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: null,
    totalPnl: 0,
    avgPnl: null,
    avgWin: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    avgRiskReward: null,
    bySymbol: {},
    byDirection: emptyDirectionBuckets(),
    byHour: {},
  };

  let closedPnlSum = 0;
  let winPnlSum = 0;
  let lossPnlSum = 0;
  let rrSum = 0;
  let rrCount = 0;

  for (const t of trades) {
    // Reward-to-risk across all trades that carry a value.
    if (typeof t.riskReward === "number" && Number.isFinite(t.riskReward)) {
      rrSum += t.riskReward;
      rrCount += 1;
    }

    // Per-symbol bucket.
    const sym = (stats.bySymbol[t.symbol] ??= { trades: 0, closed: 0, pnl: 0 });
    sym.trades += 1;

    // Per-direction bucket.
    const dir: Direction = t.direction === "SHORT" ? "SHORT" : "LONG";
    const dirBucket = stats.byDirection[dir];
    dirBucket.trades += 1;

    // Per-hour bucket (UTC hour of open).
    const hourKey = String(t.openedAt.getUTCHours());
    const hour = (stats.byHour[hourKey] ??= {
      trades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
    });
    hour.trades += 1;

    if (t.status === "OPEN") {
      stats.openTrades += 1;
      continue;
    }
    if (t.status === "CANCELLED") {
      stats.cancelledTrades += 1;
      continue;
    }

    // CLOSED from here on.
    stats.closedTrades += 1;
    sym.closed += 1;

    const pnl = typeof t.pnl === "number" && Number.isFinite(t.pnl) ? t.pnl : 0;
    stats.totalPnl += pnl;
    closedPnlSum += pnl;
    sym.pnl += pnl;
    dirBucket.pnl += pnl;
    hour.pnl += pnl;

    if (pnl > 0) {
      stats.wins += 1;
      dirBucket.wins += 1;
      hour.wins += 1;
      winPnlSum += pnl;
      stats.largestWin = stats.largestWin === null ? pnl : Math.max(stats.largestWin, pnl);
    } else if (pnl < 0) {
      stats.losses += 1;
      dirBucket.losses += 1;
      hour.losses += 1;
      lossPnlSum += pnl;
      stats.largestLoss = stats.largestLoss === null ? pnl : Math.min(stats.largestLoss, pnl);
    } else {
      stats.breakeven += 1;
    }
  }

  if (stats.closedTrades > 0) {
    stats.winRate = stats.wins / stats.closedTrades;
    stats.avgPnl = closedPnlSum / stats.closedTrades;
  }
  if (stats.wins > 0) stats.avgWin = winPnlSum / stats.wins;
  if (stats.losses > 0) stats.avgLoss = lossPnlSum / stats.losses;
  if (rrCount > 0) stats.avgRiskReward = rrSum / rrCount;

  return stats;
}

/** Compact one trade for the prompt (drops nothing the review needs, stays small). */
function compactTrade(t: PaperTrade) {
  return {
    symbol: t.symbol,
    direction: t.direction,
    status: t.status,
    entry: t.entry,
    stopLoss: t.stopLoss,
    target: t.target,
    size: t.size,
    riskReward: t.riskReward,
    pnl: t.pnl ?? null,
    exitPrice: t.exitPrice ?? null,
    openedAt: t.openedAt.toISOString(),
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
  };
}

/** Build the user-turn content. Pure — useful for tests. */
export function buildJournalUserPrompt(
  trades: readonly PaperTrade[],
  stats: JournalStats,
): string {
  return [
    "Review this paper-trading journal. The statistics below are authoritative — cite them, do not recompute.",
    "",
    "PRE-COMPUTED STATISTICS:",
    "```json",
    JSON.stringify(stats, null, 2),
    "```",
    "",
    `TRADES (${trades.length}, most recent first):`,
    "```json",
    JSON.stringify(trades.map(compactTrade), null, 2),
    "```",
  ].join("\n");
}

export interface ReviewJournalOptions {
  /** Inject a provider (testing / model override). Defaults to Haiku provider. */
  provider?: LLMProvider;
  /** Override the model. Defaults to Sonnet (cross-trade reasoning). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Produce a qualitative journal review. Defaults to Sonnet; statistics are
 * computed here and embedded so the model cannot fabricate numbers.
 */
export async function reviewJournal(
  trades: readonly PaperTrade[],
  options: ReviewJournalOptions = {},
): Promise<JournalReview> {
  const provider = options.provider ?? getLLMProvider();
  const stats = computeJournalStats(trades);

  const response = await provider.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildJournalUserPrompt(trades, stats) }],
    model: options.model ?? JOURNAL_REVIEW_MODEL,
    maxTokens: options.maxTokens ?? 2048,
    temperature: options.temperature ?? 0.2,
  });

  const parsed = extractJsonObject<Record<string, unknown>>(response.content);

  return {
    bestSetups: asStringArray(parsed.bestSetups),
    losingPatterns: asStringArray(parsed.losingPatterns),
    timeOfDayWeakness: asString(parsed.timeOfDayWeakness),
    overtrading: asString(parsed.overtrading),
    ruleViolations: asStringArray(parsed.ruleViolations),
    improvement: asString(parsed.improvement),
    summary: asString(parsed.summary),
    stats,
    meta: toUsageMeta(response),
  };
}

/** Truncate a date to UTC midnight — the canonical key for the trading day. */
export function toUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Persist a journal review as a `DailyReview` (upsert on userId + day).
 *
 * `summary` holds the readable narrative; `stats` holds a JSON bag with the
 * deterministic metrics plus the structured qualitative review (DailyReview has
 * no `raw` column, so the full artifact lives here without losing anything).
 */
export async function persistDailyReview(
  userId: string,
  review: JournalReview,
  date: Date = new Date(),
) {
  const day = toUtcDay(date);

  const statsPayload = JSON.stringify({
    metrics: review.stats,
    review: {
      bestSetups: review.bestSetups,
      losingPatterns: review.losingPatterns,
      timeOfDayWeakness: review.timeOfDayWeakness,
      overtrading: review.overtrading,
      ruleViolations: review.ruleViolations,
      improvement: review.improvement,
    },
    model: review.meta.model,
  });

  return prisma.dailyReview.upsert({
    where: { userId_date: { userId, date: day } },
    create: {
      userId,
      date: day,
      summary: review.summary,
      stats: statsPayload,
    },
    update: {
      summary: review.summary,
      stats: statsPayload,
    },
  });
}
