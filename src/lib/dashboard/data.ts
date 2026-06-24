// Server-side dashboard data layer.
//
// Reads the DB through Prisma and returns the SAME "@/lib/types" shapes the
// mock module exposes, so page components render identically whether the data
// is real or mock. Server-only (imports the Prisma client) — call from server
// components or route handlers, never from a "use client" module.
//
// Mock fallback is kept ONLY where no real data exists yet (paper trades, and
// the instrument quote when a symbol has no candles). Signals are a real source
// once the detection job has run, so they never fall back to mock.

import type {
  Direction,
  Instrument,
  PaperTrade,
  PriceQuote,
  RiskDecision,
  Setup,
  SignalStatus,
  Timeframe,
  TradeStatus,
} from "@/lib/types";
import type { SignalExplanation } from "@/lib/llm";
import { prisma } from "@/lib/db";
import type { TradeRow } from "./metrics";
import { MOCK_INSTRUMENTS, MOCK_TRADE_ROWS, quoteFor } from "./mock";

/** A signal joined with its risk verdict and latest LLM explanation. */
export interface SignalRow {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  setup: Setup;
  confidence: number;
  status: SignalStatus;
  createdAt: Date;
  /** RiskDecision from the pre-trade check, or null if never evaluated. */
  verdict: RiskDecision | null;
  /** Latest stored LLM explanation, or null if not yet explained. */
  explanation: SignalExplanation | null;
}

function parse<T>(json: string | null | undefined): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** Friendly label for a setup, derived from its strategy tag. */
export function setupLabel(setup: Setup | null): string {
  const tag = setup ? (setup.rawFeatures as Record<string, unknown>)?.setup : undefined;
  if (tag === "TREND_PULLBACK") return "Trend Pullback";
  if (typeof tag === "string") return tag;
  return "Manual";
}

/** All signals, newest first, with risk verdict + latest LLM explanation. */
export async function getSignalRows(): Promise<SignalRow[]> {
  const rows = await prisma.signal.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      reviews: {
        where: { reviewer: "LLM" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  return rows.map((r) => {
    const setup = parse<Setup>(r.setup);
    const explanationRaw = r.reviews[0]?.raw ?? null;
    return {
      id: r.id,
      symbol: r.symbol,
      timeframe: r.timeframe as Timeframe,
      direction: r.direction as Direction,
      setup: setup ?? fallbackSetup(r.symbol, r.timeframe as Timeframe, r.direction as Direction),
      confidence: r.confidence,
      status: r.status as SignalStatus,
      createdAt: r.createdAt,
      verdict: parse<RiskDecision>(r.risk),
      explanation: parse<SignalExplanation>(explanationRaw),
    };
  });
}

/** A minimal placeholder Setup for the rare case a stored row won't parse. */
function fallbackSetup(symbol: string, timeframe: Timeframe, direction: Direction): Setup {
  return {
    symbol,
    timeframe,
    direction,
    entryZone: { low: 0, high: 0 },
    stopLoss: 0,
    target: 0,
    riskReward: 0,
    invalidation: "(unavailable)",
    confidence: 0,
    reasonCodes: [],
    rawFeatures: {},
  };
}

function toPaperTrade(r: {
  id: string;
  symbol: string;
  direction: string;
  entry: number;
  stopLoss: number;
  target: number;
  size: number;
  riskReward: number;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  exitPrice: number | null;
  pnl: number | null;
  signalId: string | null;
}): PaperTrade {
  return {
    id: r.id,
    symbol: r.symbol,
    direction: r.direction as Direction,
    entry: r.entry,
    stopLoss: r.stopLoss,
    target: r.target,
    size: r.size,
    riskReward: r.riskReward,
    status: r.status as TradeStatus,
    openedAt: r.openedAt,
    closedAt: r.closedAt ?? undefined,
    exitPrice: r.exitPrice ?? undefined,
    pnl: r.pnl ?? undefined,
    signalId: r.signalId ?? undefined,
  };
}

export interface TradeData {
  rows: TradeRow[];
  /** True when no real trades exist and the mock log is shown instead. */
  isMock: boolean;
}

/**
 * Paper trades as TradeRow[] (trade + setup label). Falls back to the mock
 * trade log when no real trades have been logged yet.
 */
export async function getTradeData(): Promise<TradeData> {
  const rows = await prisma.paperTrade.findMany({
    orderBy: { openedAt: "desc" },
    include: { signal: true },
  });

  if (rows.length === 0) {
    return { rows: MOCK_TRADE_ROWS, isMock: true };
  }

  const tradeRows: TradeRow[] = rows.map((r) => ({
    trade: toPaperTrade(r),
    setupName: setupLabel(r.signal ? parse<Setup>(r.signal.setup) : null),
  }));
  return { rows: tradeRows, isMock: false };
}

export interface InstrumentQuotes {
  instruments: Instrument[];
  quotes: PriceQuote[];
}

/**
 * Active instruments with a quote derived from each one's most recent candle.
 * Falls back to the mock quote for symbols that have no candles yet, and to the
 * mock instrument list when none are seeded.
 */
export async function getInstrumentsWithQuotes(): Promise<InstrumentQuotes> {
  const dbInstruments = await prisma.instrument.findMany({
    where: { active: true },
    orderBy: { symbol: "asc" },
  });

  const instruments: Instrument[] = dbInstruments.length
    ? dbInstruments.map((i) => ({
        symbol: i.symbol,
        name: i.name,
        type: i.type as Instrument["type"],
        basePrecision: i.basePrecision,
        quotePrecision: i.quotePrecision,
      }))
    : MOCK_INSTRUMENTS;

  const quotes: PriceQuote[] = [];
  for (const inst of instruments) {
    const candle = await prisma.candle.findFirst({
      where: { symbol: inst.symbol },
      orderBy: { openTime: "desc" },
    });
    if (candle) {
      quotes.push({
        symbol: inst.symbol,
        price: candle.close,
        timestamp: candle.openTime,
      });
    } else {
      const mock = quoteFor(inst.symbol);
      if (mock) quotes.push(mock);
    }
  }

  return { instruments, quotes };
}
