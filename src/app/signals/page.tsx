"use client";

import { useState } from "react";
import type { RiskVerdict, Signal } from "@/lib/types";
import { MOCK_SIGNAL_VERDICTS, MOCK_SIGNALS } from "@/lib/dashboard/mock";
import { formatDateTime, formatPct, formatPrice } from "@/lib/dashboard/format";
import {
  Card,
  DirectionBadge,
  SignalStatusBadge,
  VerdictBadge,
} from "@/components/ui";

type DecisionState = RiskVerdict | "PENDING";

export default function SignalsPage() {
  // Local verdict state, seeded from the mock review verdicts. Accept/reject
  // buttons POST to the stub route and optimistically update this map.
  const [verdicts, setVerdicts] = useState<Record<string, DecisionState>>(() => {
    const init: Record<string, DecisionState> = {};
    for (const s of MOCK_SIGNALS) {
      init[s.id] = MOCK_SIGNAL_VERDICTS[s.id]?.verdict ?? "PENDING";
    }
    return init;
  });
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function review(signalId: string, action: "accept" | "reject") {
    setPendingId(signalId);
    try {
      const res = await fetch(`/api/signals/${signalId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data: { verdict?: RiskVerdict } = await res.json();
      setVerdicts((prev) => ({
        ...prev,
        [signalId]: data.verdict ?? (action === "accept" ? "APPROVED" : "REJECTED"),
      }));
    } catch {
      // Stub fallback: still reflect the user's intent locally.
      setVerdicts((prev) => ({
        ...prev,
        [signalId]: action === "accept" ? "APPROVED" : "REJECTED",
      }));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-lg font-semibold">Signals</h1>
        <p className="text-sm text-neutral-500">
          Detected setups awaiting review. Accept opens a paper trade; reject
          discards the signal.{" "}
          <span className="text-neutral-600">(buttons call a stub API)</span>
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {MOCK_SIGNALS.map((signal) => (
          <SignalCard
            key={signal.id}
            signal={signal}
            decision={verdicts[signal.id]}
            busy={pendingId === signal.id}
            onAccept={() => review(signal.id, "accept")}
            onReject={() => review(signal.id, "reject")}
          />
        ))}
      </div>
    </div>
  );
}

function SignalCard({
  signal,
  decision,
  busy,
  onAccept,
  onReject,
}: {
  signal: Signal;
  decision: DecisionState;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { setup } = signal;
  const expired = signal.status === "EXPIRED";
  const decided = decision !== "PENDING";

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono text-neutral-200">{signal.symbol}</span>
          <span className="text-neutral-600">{signal.timeframe}</span>
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          {decision === "PENDING" ? (
            <SignalStatusBadge status={signal.status} />
          ) : (
            <VerdictBadge verdict={decision} />
          )}
        </div>
      }
      className={expired ? "opacity-60" : ""}
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <DirectionBadge direction={signal.direction} />
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-neutral-500">
              Confidence
            </div>
            <div className="font-mono text-sm tabular-nums text-neutral-200">
              {formatPct(signal.confidence)}
            </div>
          </div>
        </div>

        {/* Levels */}
        <div className="grid grid-cols-4 gap-2 rounded-md border border-neutral-800 bg-neutral-950/40 p-2.5 text-center">
          <Level label="Entry" value={`${formatPrice(setup.entryZone.low)}–${formatPrice(setup.entryZone.high)}`} />
          <Level label="Stop" value={formatPrice(setup.stopLoss)} tone="neg" />
          <Level label="Target" value={formatPrice(setup.target)} tone="pos" />
          <Level label="R:R" value={`${setup.riskReward.toFixed(1)}`} />
        </div>

        {/* Reason codes */}
        <div className="flex flex-wrap gap-1.5">
          {setup.reasonCodes.map((code) => (
            <span
              key={code}
              className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400"
            >
              {code}
            </span>
          ))}
        </div>

        <div className="text-xs text-neutral-500">
          <span className="text-neutral-600">Invalidation:</span>{" "}
          {setup.invalidation}
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-neutral-600">
            {formatDateTime(signal.createdAt)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onReject}
              disabled={busy || expired}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {decided && decision === "REJECTED" ? "Rejected" : "Reject"}
            </button>
            <button
              type="button"
              onClick={onAccept}
              disabled={busy || expired}
              className="rounded-md bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "…" : decided && decision === "APPROVED" ? "Accepted" : "Accept"}
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Level({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "pos" | "neg";
}) {
  const toneClass =
    tone === "pos"
      ? "text-emerald-400"
      : tone === "neg"
        ? "text-rose-400"
        : "text-neutral-200";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-600">
        {label}
      </div>
      <div className={`font-mono text-xs tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}
