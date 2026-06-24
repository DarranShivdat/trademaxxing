// =============================================================================
// MOCK DATA — clearly labeled placeholder data for the dashboard.
//
// The real pipeline (detection -> risk review -> paper execution) is built by
// other agents and not yet wired up. Until it is, the dashboard renders this
// deterministic, hand-authored dataset so it stands alone with no DB required.
//
// Everything here is produced as shapes from "@/lib/types" — the dashboard
// never sees a non-contract shape. Swap these functions for typed API routes /
// Prisma reads once the pipeline lands; the page components don't change.
// =============================================================================

import type {
  Instrument,
  PaperTrade,
  PriceQuote,
  RiskDecision,
  Setup,
  Signal,
} from "@/lib/types";
import type { TradeRow } from "./metrics";

// --- time helpers (relative to render time, so "today" stays meaningful) -----

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

/** A time `daysAgo` days back, pinned to a given UTC hour (for session demos). */
function atUtcHour(daysAgo: number, utcHour: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(utcHour, 0, 0, 0);
  return d;
}

// --- instruments -------------------------------------------------------------

export const MOCK_INSTRUMENTS: Instrument[] = [
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
  },
  {
    symbol: "GBP/USD",
    name: "British Pound / US Dollar",
    type: "FOREX",
    basePrecision: 5,
    quotePrecision: 5,
  },
];

export const MOCK_QUOTES: PriceQuote[] = [
  { symbol: "XAU/USD", price: 2356.42, timestamp: ago(12_000) },
  { symbol: "EUR/USD", price: 1.0842, timestamp: ago(9_000) },
  { symbol: "GBP/USD", price: 1.2718, timestamp: ago(15_000) },
];

export function quoteFor(symbol: string): PriceQuote | undefined {
  return MOCK_QUOTES.find((q) => q.symbol === symbol);
}

// --- signals -----------------------------------------------------------------

let signalSeq = 0;
function makeSignal(
  partial: Omit<Signal, "id" | "confidence" | "setup"> & {
    setup: Omit<Setup, "symbol" | "timeframe" | "direction" | "confidence">;
    confidence: number;
  },
): Signal {
  const id = `sig_${String(++signalSeq).padStart(3, "0")}`;
  const setup: Setup = {
    symbol: partial.symbol,
    timeframe: partial.timeframe,
    direction: partial.direction,
    confidence: partial.confidence,
    ...partial.setup,
  };
  return {
    id,
    symbol: partial.symbol,
    timeframe: partial.timeframe,
    direction: partial.direction,
    setup,
    confidence: partial.confidence,
    status: partial.status,
    createdAt: partial.createdAt,
  };
}

export const MOCK_SIGNALS: Signal[] = [
  makeSignal({
    symbol: "XAU/USD",
    timeframe: "15min",
    direction: "LONG",
    confidence: 0.78,
    status: "NEW",
    createdAt: ago(8 * MIN),
    setup: {
      entryZone: { low: 2354.0, high: 2356.5 },
      stopLoss: 2349.5,
      target: 2368.0,
      riskReward: 2.4,
      invalidation: "15m close below 2349.50",
      reasonCodes: ["EMA_RECLAIM", "LONDON_BREAKOUT", "VOL_EXPANSION"],
      rawFeatures: { ema20: 2353.1, ema50: 2351.4, atr14: 3.2, rsi14: 61 },
    },
  }),
  makeSignal({
    symbol: "EUR/USD",
    timeframe: "1h",
    direction: "SHORT",
    confidence: 0.64,
    status: "NEW",
    createdAt: ago(26 * MIN),
    setup: {
      entryZone: { low: 1.0838, high: 1.0846 },
      stopLoss: 1.0869,
      target: 1.0782,
      riskReward: 2.1,
      invalidation: "1h close above 1.08690",
      reasonCodes: ["SUPPLY_RETEST", "RSI_BEAR_DIV"],
      rawFeatures: { ema20: 1.0851, rsi14: 47, atr14: 0.0021 },
    },
  }),
  makeSignal({
    symbol: "XAU/USD",
    timeframe: "5min",
    direction: "SHORT",
    confidence: 0.52,
    status: "REVIEWED",
    createdAt: ago(70 * MIN),
    setup: {
      entryZone: { low: 2361.0, high: 2362.5 },
      stopLoss: 2366.0,
      target: 2351.0,
      riskReward: 2.0,
      invalidation: "Reclaim of 2366.00",
      reasonCodes: ["LIQUIDITY_SWEEP", "FVG_FILL"],
      rawFeatures: { atr14: 2.8, rsi14: 72 },
    },
  }),
  makeSignal({
    symbol: "GBP/USD",
    timeframe: "15min",
    direction: "LONG",
    confidence: 0.71,
    status: "REVIEWED",
    createdAt: ago(2 * HOUR + 10 * MIN),
    setup: {
      entryZone: { low: 1.271, high: 1.2722 },
      stopLoss: 1.2688,
      target: 1.2772,
      riskReward: 2.6,
      invalidation: "15m close below 1.26880",
      reasonCodes: ["RANGE_BREAKOUT", "TREND_ALIGNED"],
      rawFeatures: { ema20: 1.2705, rsi14: 58 },
    },
  }),
  makeSignal({
    symbol: "XAU/USD",
    timeframe: "1h",
    direction: "LONG",
    confidence: 0.4,
    status: "EXPIRED",
    createdAt: ago(5 * HOUR),
    setup: {
      entryZone: { low: 2340.0, high: 2342.0 },
      stopLoss: 2333.0,
      target: 2360.0,
      riskReward: 2.5,
      invalidation: "1h close below 2333.00",
      reasonCodes: ["TREND_PULLBACK"],
      rawFeatures: { ema50: 2338.0, rsi14: 44 },
    },
  }),
];

/**
 * The risk-review verdict the (future) risk agent would attach to a signal.
 * Keyed by signal id; signals without an entry are still under review (NEW).
 */
export const MOCK_SIGNAL_VERDICTS: Record<string, RiskDecision> = {
  sig_003: {
    verdict: "APPROVED",
    reasons: ["Within daily risk budget", "R:R >= 2.0", "No news blackout"],
  },
  sig_004: {
    verdict: "APPROVED",
    reasons: ["Within daily risk budget", "Trend aligned on 1h"],
  },
  sig_005: {
    verdict: "REJECTED",
    reasons: ["Setup invalidated before fill", "Confidence below 0.50 floor"],
  },
};

// --- paper trades ------------------------------------------------------------

let tradeSeq = 0;

/**
 * Build a CLOSED paper trade from a desired R result. `pnl`/`exitPrice` are
 * derived so they stay internally consistent with entry/stop/size.
 */
function closedTrade(args: {
  symbol: string;
  direction: PaperTrade["direction"];
  entry: number;
  stopLoss: number;
  riskReward: number;
  size: number;
  resultR: number;
  openedAt: Date;
  holdMs: number;
  setupName: string;
  signalId?: string;
}): TradeRow {
  const riskPerUnit = Math.abs(args.entry - args.stopLoss);
  const target =
    args.direction === "LONG"
      ? args.entry + riskPerUnit * args.riskReward
      : args.entry - riskPerUnit * args.riskReward;
  const pnl = args.resultR * riskPerUnit * args.size;
  const exitPrice =
    args.direction === "LONG"
      ? args.entry + pnl / args.size
      : args.entry - pnl / args.size;
  const trade: PaperTrade = {
    id: `pt_${String(++tradeSeq).padStart(3, "0")}`,
    symbol: args.symbol,
    direction: args.direction,
    entry: round(args.entry, 5),
    stopLoss: round(args.stopLoss, 5),
    target: round(target, 5),
    size: args.size,
    riskReward: args.riskReward,
    status: "CLOSED",
    openedAt: args.openedAt,
    closedAt: new Date(args.openedAt.getTime() + args.holdMs),
    exitPrice: round(exitPrice, 5),
    pnl: round(pnl, 2),
    signalId: args.signalId,
  };
  return { trade, setupName: args.setupName };
}

function openTrade(args: {
  symbol: string;
  direction: PaperTrade["direction"];
  entry: number;
  stopLoss: number;
  riskReward: number;
  size: number;
  openedAt: Date;
  setupName: string;
  signalId?: string;
}): TradeRow {
  const riskPerUnit = Math.abs(args.entry - args.stopLoss);
  const target =
    args.direction === "LONG"
      ? args.entry + riskPerUnit * args.riskReward
      : args.entry - riskPerUnit * args.riskReward;
  const trade: PaperTrade = {
    id: `pt_${String(++tradeSeq).padStart(3, "0")}`,
    symbol: args.symbol,
    direction: args.direction,
    entry: round(args.entry, 5),
    stopLoss: round(args.stopLoss, 5),
    target: round(target, 5),
    size: args.size,
    riskReward: args.riskReward,
    status: "OPEN",
    openedAt: args.openedAt,
    signalId: args.signalId,
  };
  return { trade, setupName: args.setupName };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const MOCK_TRADE_ROWS: TradeRow[] = [
  // --- today (drives Home "today's P/L in R") ---
  closedTrade({
    symbol: "XAU/USD",
    direction: "LONG",
    entry: 2348.5,
    stopLoss: 2344.0,
    riskReward: 2.4,
    size: 1,
    resultR: 2.4,
    openedAt: atUtcHour(0, 8),
    holdMs: 95 * MIN,
    setupName: "London ORB",
    signalId: "sig_004",
  }),
  closedTrade({
    symbol: "EUR/USD",
    direction: "SHORT",
    entry: 1.087,
    stopLoss: 1.0888,
    riskReward: 2.0,
    size: 100000,
    resultR: -1.0,
    openedAt: atUtcHour(0, 9),
    holdMs: 40 * MIN,
    setupName: "Supply Retest",
  }),
  closedTrade({
    symbol: "XAU/USD",
    direction: "SHORT",
    entry: 2362.0,
    stopLoss: 2366.0,
    riskReward: 2.2,
    size: 1,
    resultR: 1.1,
    openedAt: atUtcHour(0, 14),
    holdMs: 55 * MIN,
    setupName: "Liquidity Sweep",
  }),
  // --- still open ---
  openTrade({
    symbol: "XAU/USD",
    direction: "LONG",
    entry: 2355.0,
    stopLoss: 2350.0,
    riskReward: 2.5,
    size: 1,
    openedAt: ago(40 * MIN),
    setupName: "Trend Pullback",
  }),
  openTrade({
    symbol: "GBP/USD",
    direction: "LONG",
    entry: 1.2715,
    stopLoss: 1.2692,
    riskReward: 2.6,
    size: 100000,
    openedAt: ago(2 * HOUR),
    setupName: "Range Breakout",
    signalId: "sig_004",
  }),
  // --- prior days, spread across sessions/setups ---
  closedTrade({
    symbol: "XAU/USD",
    direction: "LONG",
    entry: 2331.0,
    stopLoss: 2326.0,
    riskReward: 2.5,
    size: 1,
    resultR: 2.5,
    openedAt: atUtcHour(1, 8),
    holdMs: 120 * MIN,
    setupName: "London ORB",
  }),
  closedTrade({
    symbol: "XAU/USD",
    direction: "SHORT",
    entry: 2344.0,
    stopLoss: 2349.0,
    riskReward: 2.0,
    size: 1,
    resultR: -1.0,
    openedAt: atUtcHour(1, 15),
    holdMs: 35 * MIN,
    setupName: "Liquidity Sweep",
  }),
  closedTrade({
    symbol: "EUR/USD",
    direction: "LONG",
    entry: 1.0795,
    stopLoss: 1.078,
    riskReward: 2.2,
    size: 100000,
    resultR: 1.8,
    openedAt: atUtcHour(1, 3),
    holdMs: 180 * MIN,
    setupName: "Asian Range Fade",
  }),
  closedTrade({
    symbol: "GBP/USD",
    direction: "LONG",
    entry: 1.2666,
    stopLoss: 1.2648,
    riskReward: 2.6,
    size: 100000,
    resultR: 2.6,
    openedAt: atUtcHour(2, 9),
    holdMs: 140 * MIN,
    setupName: "Range Breakout",
  }),
  closedTrade({
    symbol: "XAU/USD",
    direction: "SHORT",
    entry: 2370.0,
    stopLoss: 2375.0,
    riskReward: 2.0,
    size: 1,
    resultR: -1.0,
    openedAt: atUtcHour(2, 14),
    holdMs: 25 * MIN,
    setupName: "Trend Pullback",
  }),
  closedTrade({
    symbol: "XAU/USD",
    direction: "LONG",
    entry: 2358.0,
    stopLoss: 2353.0,
    riskReward: 2.4,
    size: 1,
    resultR: -1.0,
    openedAt: atUtcHour(3, 8),
    holdMs: 50 * MIN,
    setupName: "London ORB",
  }),
  closedTrade({
    symbol: "EUR/USD",
    direction: "SHORT",
    entry: 1.0905,
    stopLoss: 1.092,
    riskReward: 2.0,
    size: 100000,
    resultR: 2.0,
    openedAt: atUtcHour(3, 16),
    holdMs: 210 * MIN,
    setupName: "Supply Retest",
  }),
  closedTrade({
    symbol: "XAU/USD",
    direction: "LONG",
    entry: 2342.0,
    stopLoss: 2337.5,
    riskReward: 2.3,
    size: 1,
    resultR: 1.6,
    openedAt: atUtcHour(4, 3),
    holdMs: 240 * MIN,
    setupName: "Asian Range Fade",
  }),
  closedTrade({
    symbol: "GBP/USD",
    direction: "SHORT",
    entry: 1.2742,
    stopLoss: 1.276,
    riskReward: 2.2,
    size: 100000,
    resultR: -1.0,
    openedAt: atUtcHour(4, 15),
    holdMs: 30 * MIN,
    setupName: "Liquidity Sweep",
  }),
];

export const MOCK_TRADES: PaperTrade[] = MOCK_TRADE_ROWS.map((r) => r.trade);

// --- rule status (Home) ------------------------------------------------------

/** Named risk-rule states, rendered as the contract's RiskDecision shape. */
export interface RuleStatus {
  rule: string;
  decision: RiskDecision;
}

export const MOCK_RULE_STATUS: RuleStatus[] = [
  {
    rule: "Daily loss limit",
    decision: {
      verdict: "APPROVED",
      reasons: ["Day at +2.50R of -3.00R floor"],
    },
  },
  {
    rule: "Max concurrent trades",
    decision: { verdict: "APPROVED", reasons: ["2 of 3 slots used"] },
  },
  {
    rule: "News blackout",
    decision: {
      verdict: "WARNING",
      reasons: ["US CPI in 47m — entries paused 15m prior"],
    },
  },
  {
    rule: "Correlation exposure",
    decision: {
      verdict: "REJECTED",
      reasons: ["EUR/USD + GBP/USD long exceeds USD-short cap"],
    },
  },
];

// --- distinct filter values (Paper Trades page) ------------------------------

export const MOCK_SETUP_NAMES: string[] = Array.from(
  new Set(MOCK_TRADE_ROWS.map((r) => r.setupName)),
).sort();

export const MOCK_SYMBOLS: string[] = Array.from(
  new Set(MOCK_TRADE_ROWS.map((r) => r.trade.symbol)),
).sort();
