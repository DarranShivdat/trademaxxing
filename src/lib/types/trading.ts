// Trading vocabulary shared across every module.

import type { Timeframe } from "./market";

export type Direction = "LONG" | "SHORT";

/** Inclusive price band an entry may be taken within. */
export interface EntryZone {
  low: number;
  high: number;
}

/**
 * A proposed trade setup — the unit produced by the (future) detection agent
 * and consumed by risk + execution. `reasonCodes` and `rawFeatures` are kept
 * open so the detection/indicator agents can populate them freely.
 */
export interface Setup {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  entryZone: EntryZone;
  stopLoss: number;
  target: number;
  /** Reward-to-risk ratio. */
  riskReward: number;
  /** Human-readable condition that voids the setup. */
  invalidation: string;
  /** Model/strategy confidence, 0..1. */
  confidence: number;
  /** Machine-readable reasons the setup fired (e.g. ["EMA_CROSS", "RSI_OB"]). */
  reasonCodes: string[];
  /** Raw indicator/feature values the setup was derived from. */
  rawFeatures: Record<string, unknown>;
}

export type SignalStatus = "NEW" | "REVIEWED" | "EXPIRED";

export interface Signal {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  setup: Setup;
  confidence: number;
  status: SignalStatus;
  createdAt: Date;
}

export type TradeStatus = "OPEN" | "CLOSED" | "CANCELLED";

export interface PaperTrade {
  id: string;
  symbol: string;
  direction: Direction;
  entry: number;
  stopLoss: number;
  target: number;
  size: number;
  riskReward: number;
  status: TradeStatus;
  openedAt: Date;
  closedAt?: Date;
  exitPrice?: number;
  pnl?: number;
  signalId?: string;
}

export type RiskVerdict = "APPROVED" | "REJECTED" | "WARNING";

/** Outcome of a (future) risk check. */
export interface RiskDecision {
  verdict: RiskVerdict;
  reasons: string[];
}
