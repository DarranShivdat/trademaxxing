// POST /api/signals/[id]/review — human accept/reject of a detected signal.
//
// Body: { "action": "accept" | "reject" }
//
// accept -> record a HUMAN SignalReview (APPROVED), mark the signal REVIEWED,
//           and open a paper trade from the signal's setup (sized by the engine
//           via positionSize, so the 1% rule holds by construction).
// reject -> record a HUMAN SignalReview (REJECTED) and mark the signal EXPIRED.
//
// Returns the RiskVerdict vocabulary plus the opened trade id (on accept).

import { NextResponse } from "next/server";
import type { RiskVerdict, Setup } from "@/lib/types";
import { prisma } from "@/lib/db";
import { positionSize } from "@/lib/engine/risk";

// Sizing context for a manually-accepted trade. Mirrors the detection defaults.
const ACCOUNT_EQUITY = 10_000;
const RISK_PER_TRADE_PCT = 1;
const DEMO_EMAIL = "demo@trademaxxing.local";

interface ReviewBody {
  action?: "accept" | "reject";
}

function entryPrice(setup: Setup): number {
  return (setup.entryZone.low + setup.entryZone.high) / 2;
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  let body: ReviewBody = {};
  try {
    body = (await request.json()) as ReviewBody;
  } catch {
    // empty / non-JSON body -> treated as a reject below
  }

  const signal = await prisma.signal.findUnique({ where: { id: params.id } });
  if (!signal) {
    return NextResponse.json({ error: "Signal not found" }, { status: 404 });
  }

  let setup: Setup;
  try {
    setup = JSON.parse(signal.setup) as Setup;
  } catch {
    return NextResponse.json(
      { error: "Stored signal.setup is not valid JSON" },
      { status: 422 },
    );
  }

  const accept = body.action === "accept";
  const verdict: RiskVerdict = accept ? "APPROVED" : "REJECTED";

  if (!accept) {
    await prisma.$transaction([
      prisma.signalReview.create({
        data: {
          signalId: signal.id,
          reviewer: "HUMAN",
          verdict: "REJECTED",
          rationale: "Rejected by reviewer.",
        },
      }),
      prisma.signal.update({
        where: { id: signal.id },
        data: { status: "EXPIRED" },
      }),
    ]);
    return NextResponse.json({ ok: true, signalId: signal.id, verdict });
  }

  // Accept: ensure a demo user owns the paper trade.
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { email: DEMO_EMAIL, name: "Demo Trader" },
  });

  const entry = entryPrice(setup);
  const size = positionSize(setup, ACCOUNT_EQUITY, RISK_PER_TRADE_PCT);

  const [, , trade] = await prisma.$transaction([
    prisma.signalReview.create({
      data: {
        signalId: signal.id,
        reviewer: "HUMAN",
        verdict: "APPROVED",
        rationale: "Accepted by reviewer; paper trade opened.",
      },
    }),
    prisma.signal.update({
      where: { id: signal.id },
      data: { status: "REVIEWED" },
    }),
    prisma.paperTrade.create({
      data: {
        userId: user.id,
        symbol: setup.symbol,
        direction: setup.direction,
        entry,
        stopLoss: setup.stopLoss,
        target: setup.target,
        size,
        riskReward: setup.riskReward,
        status: "OPEN",
        signalId: signal.id,
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    signalId: signal.id,
    verdict,
    tradeId: trade.id,
  });
}
