"use client";

import { useState } from "react";
import type { SignalExplanation } from "@/lib/llm";
import type { SignalRow } from "@/lib/dashboard/data";
import { formatDateTime, formatPct, formatPrice } from "@/lib/dashboard/format";
import {
  Card,
  DirectionBadge,
  SignalStatusBadge,
  VerdictBadge,
} from "@/components/ui";

export function SignalsClient({ rows }: { rows: SignalRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <Header />
        <Card>
          <p className="px-4 py-12 text-center text-sm text-neutral-500">
            No signals yet. Run the detection job to scan candles for setups:{" "}
            <code className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-neutral-300">
              npm run detect
            </code>{" "}
            or <code className="rounded bg-neutral-800/70 px-1.5 py-0.5 font-mono text-neutral-300">POST /api/detect</code>.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Header />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {rows.map((row) => (
          <SignalCard key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold">Signals</h1>
      <p className="text-sm text-neutral-500">
        Detected setups with their pre-trade risk verdict. Accept opens a paper
        trade; reject discards the signal.
      </p>
    </header>
  );
}

function SignalCard({ row }: { row: SignalRow }) {
  const { setup } = row;
  const [status, setStatus] = useState(row.status);
  const [explanation, setExplanation] = useState<SignalExplanation | null>(
    row.explanation,
  );
  const [showExplanation, setShowExplanation] = useState(row.explanation != null);
  const [busy, setBusy] = useState<null | "review" | "explain">(null);
  const [error, setError] = useState<string | null>(null);

  const expired = status === "EXPIRED";
  const decided = status !== "NEW";

  async function review(action: "accept" | "reject") {
    setBusy("review");
    setError(null);
    try {
      const res = await fetch(`/api/signals/${row.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`Review failed (${res.status})`);
      setStatus(action === "accept" ? "REVIEWED" : "EXPIRED");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function fetchExplanation() {
    setBusy("explain");
    setError(null);
    try {
      const res = await fetch("/api/llm/explain-signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalId: row.id }),
      });
      const data = (await res.json()) as {
        explanation?: SignalExplanation;
        error?: string;
      };
      if (!res.ok || !data.explanation) {
        throw new Error(data.error ?? `Explain failed (${res.status})`);
      }
      setExplanation(data.explanation);
      setShowExplanation(true);
      if (status === "NEW") setStatus("REVIEWED");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // First click fetches; subsequent clicks just toggle visibility (no refetch).
  function toggleExplain() {
    if (explanation) {
      setShowExplanation((v) => !v);
    } else {
      void fetchExplanation();
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono text-neutral-200">{row.symbol}</span>
          <span className="text-neutral-600">{row.timeframe}</span>
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          {row.verdict && <VerdictBadge verdict={row.verdict.verdict} />}
          <SignalStatusBadge status={status} />
        </div>
      }
      className={expired ? "opacity-60" : ""}
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <DirectionBadge direction={row.direction} />
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-neutral-500">
              Confidence
            </div>
            <div className="font-mono text-sm tabular-nums text-neutral-200">
              {formatPct(row.confidence)}
            </div>
          </div>
        </div>

        {/* Levels */}
        <div className="grid grid-cols-4 gap-2 rounded-md border border-neutral-800 bg-neutral-950/40 p-2.5 text-center">
          <Level
            label="Entry"
            value={`${formatPrice(setup.entryZone.low)}–${formatPrice(setup.entryZone.high)}`}
          />
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

        {/* Risk reasons */}
        {row.verdict && (
          <div className="text-xs text-neutral-500">
            <span className="text-neutral-600">Risk:</span>{" "}
            {row.verdict.reasons.join(" · ")}
          </div>
        )}

        {/* LLM explanation */}
        {explanation && showExplanation && (
          <Explanation explanation={explanation} />
        )}

        {error && <div className="text-xs text-rose-400">{error}</div>}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-neutral-600">
            {formatDateTime(row.createdAt)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={toggleExplain}
              disabled={busy !== null}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 transition-colors hover:border-sky-500/50 hover:bg-sky-500/10 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "explain"
                ? "…"
                : !explanation
                  ? "Explain"
                  : showExplanation
                    ? "Hide explanation"
                    : "Show explanation"}
            </button>
            {explanation && (
              <button
                type="button"
                onClick={fetchExplanation}
                disabled={busy !== null}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 transition-colors hover:border-sky-500/50 hover:bg-sky-500/10 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Re-explain
              </button>
            )}
            <button
              type="button"
              onClick={() => review("reject")}
              disabled={busy !== null || decided}
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "EXPIRED" ? "Rejected" : "Reject"}
            </button>
            <button
              type="button"
              onClick={() => review("accept")}
              disabled={busy !== null || decided}
              className="rounded-md bg-emerald-500/90 px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "review"
                ? "…"
                : status === "REVIEWED"
                  ? "Accepted"
                  : "Accept"}
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Explanation({ explanation }: { explanation: SignalExplanation }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950/40 p-3 text-xs">
      <p className="text-neutral-300">{explanation.explanation}</p>
      <ExplanationList label="Why it qualifies" items={explanation.whyQualifies} />
      <ExplanationList label="What invalidates it" items={explanation.whatInvalidates} />
      <ExplanationList label="What to watch" items={explanation.whatToWatch} />
      <ExplanationList label="Risk warnings" items={explanation.riskWarnings} />
      <div className="text-[10px] text-neutral-600">
        Explained by {explanation.meta.model}
      </div>
    </div>
  );
}

function ExplanationList({ label, items }: { label: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-600">
        {label}
      </div>
      <ul className="ml-3 list-disc text-neutral-400">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
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
