// STUB endpoint for accepting/rejecting a detected signal.
//
// The real handler (persist a SignalReview, open a PaperTrade on accept, run
// the risk check) is built by the execution/risk agents. For now this just
// echoes the decision back so the UI can wire its accept/reject buttons to a
// real round-trip. Returns the contract's RiskVerdict vocabulary.

import { NextResponse } from "next/server";
import type { RiskVerdict } from "@/lib/types";

interface ReviewBody {
  action?: "accept" | "reject";
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  let body: ReviewBody = {};
  try {
    body = (await request.json()) as ReviewBody;
  } catch {
    // empty / non-JSON body is fine for the stub
  }

  const verdict: RiskVerdict = body.action === "accept" ? "APPROVED" : "REJECTED";

  return NextResponse.json({
    ok: true,
    signalId: params.id,
    verdict,
    note: "stub: no trade was opened and nothing was persisted",
  });
}
