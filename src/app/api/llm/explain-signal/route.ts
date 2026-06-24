// POST /api/llm/explain-signal
//
// Body (one of):
//   { "signalId": "..." }            -> load the signal, explain its setup, and
//                                       persist a SignalReview (unless persist:false)
//   { "setup": { ...Setup } }        -> explain an ad-hoc setup (not persisted)
//
// Optional: { "persist": boolean, "model": string }
//
// Returns the structured SignalExplanation. The LLM is a language tool only —
// no trade is placed and no price is predicted.

import { NextResponse } from "next/server";
import type { Setup } from "@/lib/types";
import { prisma } from "@/lib/db";
import { explainSignal, persistSignalExplanation } from "@/lib/llm";

interface Body {
  signalId?: string;
  setup?: Setup;
  persist?: boolean;
  model?: string;
}

function looksLikeSetup(value: unknown): value is Setup {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.symbol === "string" &&
    (s.direction === "LONG" || s.direction === "SHORT")
  );
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let setup: Setup;
  let signalId: string | undefined = body.signalId;

  if (signalId) {
    const signal = await prisma.signal.findUnique({ where: { id: signalId } });
    if (!signal) {
      return NextResponse.json({ error: "Signal not found" }, { status: 404 });
    }
    try {
      const parsed = JSON.parse(signal.setup) as unknown;
      if (!looksLikeSetup(parsed)) {
        return NextResponse.json(
          { error: "Stored signal.setup is not a valid Setup" },
          { status: 422 },
        );
      }
      setup = parsed;
    } catch {
      return NextResponse.json(
        { error: "Stored signal.setup is not valid JSON" },
        { status: 422 },
      );
    }
  } else if (looksLikeSetup(body.setup)) {
    setup = body.setup;
  } else {
    return NextResponse.json(
      { error: "Provide a `signalId` or a valid `setup` object" },
      { status: 400 },
    );
  }

  let explanation;
  try {
    explanation = await explainSignal(setup, { model: body.model });
  } catch (err) {
    return NextResponse.json(
      { error: `Explanation failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // Persist only when tied to a real signal (the FK requires a signalId).
  let reviewId: string | undefined;
  if (signalId && body.persist !== false) {
    try {
      const review = await persistSignalExplanation(signalId, explanation);
      reviewId = review.id;
    } catch (err) {
      return NextResponse.json(
        { error: `Persist failed: ${(err as Error).message}`, explanation },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ signalId, reviewId, explanation });
}
