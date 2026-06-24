// POST /api/llm/review-journal
//
// Body:
//   { "userId": "..." }                       -> load recent trades for the user
//   { "userId": "...", "trades": [ ...PaperTrade ] }  -> review the supplied trades
//
// Optional: { "limit": number, "date": ISO string, "persist": boolean,
//             "model": string }
//
// Returns the structured JournalReview (with the deterministic stats it was
// grounded in). Persists a DailyReview unless persist:false. Defaults to Sonnet.

import { NextResponse } from "next/server";
import type {
  Direction,
  PaperTrade,
  TradeStatus,
} from "@/lib/types";
import { prisma } from "@/lib/db";
import { persistDailyReview, reviewJournal } from "@/lib/llm";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface Body {
  userId?: string;
  trades?: unknown[];
  limit?: number;
  date?: string;
  persist?: boolean;
  model?: string;
}

/** Map a Prisma PaperTrade row (string enums, nullable fields) to the shared type. */
type PaperTradeRow = {
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
};

function rowToPaperTrade(row: PaperTradeRow): PaperTrade {
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction as Direction,
    entry: row.entry,
    stopLoss: row.stopLoss,
    target: row.target,
    size: row.size,
    riskReward: row.riskReward,
    status: row.status as TradeStatus,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? undefined,
    exitPrice: row.exitPrice ?? undefined,
    pnl: row.pnl ?? undefined,
    signalId: row.signalId ?? undefined,
  };
}

/** Coerce a client-supplied trade (dates as strings) into a PaperTrade. */
function parseClientTrade(value: unknown): PaperTrade | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.symbol !== "string") return null;
  if (t.direction !== "LONG" && t.direction !== "SHORT") return null;
  const openedAt = t.openedAt ? new Date(t.openedAt as string) : null;
  if (!openedAt || Number.isNaN(openedAt.getTime())) return null;

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const optNum = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined;
  const closedAt = t.closedAt ? new Date(t.closedAt as string) : undefined;

  return {
    id: typeof t.id === "string" ? t.id : "",
    symbol: t.symbol,
    direction: t.direction,
    entry: num(t.entry),
    stopLoss: num(t.stopLoss),
    target: num(t.target),
    size: num(t.size),
    riskReward: num(t.riskReward),
    status: (t.status as TradeStatus) ?? "OPEN",
    openedAt,
    closedAt: closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : undefined,
    exitPrice: optNum(t.exitPrice),
    pnl: optNum(t.pnl),
    signalId: typeof t.signalId === "string" ? t.signalId : undefined,
  };
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { userId } = body;

  // Resolve the trade set: client-supplied or loaded from the DB.
  let trades: PaperTrade[];
  if (Array.isArray(body.trades)) {
    trades = body.trades
      .map(parseClientTrade)
      .filter((t): t is PaperTrade => t !== null);
  } else {
    if (!userId) {
      return NextResponse.json(
        { error: "Provide `userId` (to load trades) or a `trades` array" },
        { status: 400 },
      );
    }
    const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const rows = await prisma.paperTrade.findMany({
      where: { userId },
      orderBy: { openedAt: "desc" },
      take: limit,
    });
    trades = rows.map(rowToPaperTrade);
  }

  if (trades.length === 0) {
    return NextResponse.json(
      { error: "No trades to review" },
      { status: 400 },
    );
  }

  let review;
  try {
    review = await reviewJournal(trades, { model: body.model });
  } catch (err) {
    return NextResponse.json(
      { error: `Review failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // Persist a DailyReview when we have a user to attach it to.
  let dailyReviewId: string | undefined;
  if (userId && body.persist !== false) {
    try {
      const date = body.date ? new Date(body.date) : new Date();
      const saved = await persistDailyReview(
        userId,
        review,
        Number.isNaN(date.getTime()) ? new Date() : date,
      );
      dailyReviewId = saved.id;
    } catch (err) {
      return NextResponse.json(
        { error: `Persist failed: ${(err as Error).message}`, review },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    userId,
    dailyReviewId,
    tradesReviewed: trades.length,
    review,
  });
}
