// POST /api/detect — run the detection pipeline (API / cron entry point).
//
// Body (all optional):
//   {
//     "symbol": "XAU/USD",
//     "timeframe": "1h",        // 1min | 5min | 15min | 1h | 4h | 1day
//     "explain": false,          // also generate LLM explanations per signal
//     "accountEquity": 10000,
//     "maxTradesPerDay": 2
//   }
//
// Returns the RunDetectionResult (counts + persisted signal summaries). This is
// the same code path the `npm run detect` CLI uses — see src/lib/pipeline.
//
// Cron: point a scheduler (Vercel Cron, GitHub Action, etc.) at this route on
// the cadence you want fresh signals (e.g. once per closed bar).

import { NextResponse } from "next/server";
import { TIMEFRAMES, type Timeframe } from "@/lib/types";
import { runDetection } from "@/lib/pipeline/detect";

// Detection touches the DB and the LLM — never statically cache it.
export const dynamic = "force-dynamic";

interface Body {
  symbol?: string;
  timeframe?: string;
  explain?: boolean;
  explainModel?: string;
  accountEquity?: number;
  riskPerTradePct?: number;
  maxTradesPerDay?: number;
  tradesToday?: number;
}

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty / non-JSON body => run with defaults
  }

  if (body.timeframe && !TIMEFRAMES.includes(body.timeframe as Timeframe)) {
    return NextResponse.json(
      { error: `Invalid timeframe. One of: ${TIMEFRAMES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const result = await runDetection({
      symbol: body.symbol,
      timeframe: body.timeframe as Timeframe | undefined,
      explain: body.explain,
      explainModel: body.explainModel,
      accountEquity: body.accountEquity,
      riskPerTradePct: body.riskPerTradePct,
      maxTradesPerDay: body.maxTradesPerDay,
      tradesToday: body.tradesToday,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Detection failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
