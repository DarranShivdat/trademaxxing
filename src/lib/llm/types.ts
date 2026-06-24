// Output shapes for the LLM analyst layer.
//
// These describe *language* artifacts only — explanations and journal reviews.
// The LLM never places trades, sizes positions, or predicts price; nothing here
// carries a buy/sell instruction or a forecast. Numeric facts (confidence,
// statistics) always originate from the input data, never from the model.

import type { LLMCompletionResponse } from "@/lib/providers";

/** Token/model metadata attached to every LLM artifact for observability. */
export interface LLMUsageMeta {
  /** The model that actually served the response. */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Plain-English explanation of a single Setup. Purely descriptive: it explains
 * what the detection system produced and what to watch, with no recommendation
 * to trade and no price prediction.
 */
export interface SignalExplanation {
  /** One short paragraph in plain English describing the setup. */
  explanation: string;
  /** Why this setup qualifies under the strategy (tied to the setup's fields). */
  whyQualifies: string[];
  /** Conditions that would void the setup (derived from `invalidation` + levels). */
  whatInvalidates: string[];
  /** Things to monitor while the setup is live. */
  whatToWatch: string[];
  /** Risk warnings (paper trading, setups fail, no guarantees, etc.). */
  riskWarnings: string[];
  meta: LLMUsageMeta;
}

/**
 * Deterministic, code-computed journal statistics. These are NEVER produced by
 * the model — they are calculated from the trades and handed to the model so it
 * can reason without fabricating numbers.
 */
export interface JournalStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  cancelledTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Win rate over closed trades, 0..1. `null` when no trades have closed. */
  winRate: number | null;
  totalPnl: number;
  /** Average P&L over closed trades. `null` when no trades have closed. */
  avgPnl: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  /** Average reward-to-risk across all trades. `null` when there are none. */
  avgRiskReward: number | null;
  bySymbol: Record<string, { trades: number; closed: number; pnl: number }>;
  byDirection: Record<
    "LONG" | "SHORT",
    { trades: number; wins: number; losses: number; pnl: number }
  >;
  /** Keyed by UTC hour-of-day ("0".."23") of `openedAt`. */
  byHour: Record<
    string,
    { trades: number; wins: number; losses: number; pnl: number }
  >;
}

/**
 * Qualitative journal review. The model reasons across trades using the
 * pre-computed `JournalStats`; it suggests exactly one improvement and never
 * invents statistics or tells the user to place a trade.
 */
export interface JournalReview {
  /** Setups/patterns that performed best, grounded in the stats. */
  bestSetups: string[];
  /** Recurring losing patterns. */
  losingPatterns: string[];
  /** Observation about time-of-day weakness (or that data is insufficient). */
  timeOfDayWeakness: string;
  /** Observation about overtrading (or that data is insufficient). */
  overtrading: string;
  /** Apparent rule violations (e.g. R:R below plan, oversized, etc.). */
  ruleViolations: string[];
  /** Exactly ONE concrete, prioritized improvement. */
  improvement: string;
  /** Short readable narrative summary. */
  summary: string;
  /** The deterministic stats the review was grounded in. */
  stats: JournalStats;
  meta: LLMUsageMeta;
}

/** Internal: lift usage off a provider response into our metadata shape. */
export function toUsageMeta(res: LLMCompletionResponse): LLMUsageMeta {
  return {
    model: res.model,
    inputTokens: res.usage?.inputTokens,
    outputTokens: res.usage?.outputTokens,
  };
}
