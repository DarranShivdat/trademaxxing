// Shared presentational primitives for the dashboard. Server-safe (no hooks).
// Dark, dense, monospace numerics — a serious monitoring-tool aesthetic.

import type { ReactNode } from "react";
import type { Direction, RiskVerdict, SignalStatus, TradeStatus } from "@/lib/types";

// --- layout cards ------------------------------------------------------------

export function Card({
  title,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-neutral-800 bg-neutral-900/50 ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            {title}
          </h2>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** A single labeled metric tile. `tone` colors the value. */
export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "pos" | "neg" | "warn";
}) {
  const toneClass =
    tone === "pos"
      ? "text-emerald-400"
      : tone === "neg"
        ? "text-rose-400"
        : tone === "warn"
          ? "text-amber-400"
          : "text-neutral-100";
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-2xl tabular-nums ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

// --- badges ------------------------------------------------------------------

function Pill({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${className}`}
    >
      {children}
    </span>
  );
}

export function DirectionBadge({ direction }: { direction: Direction }) {
  return direction === "LONG" ? (
    <Pill className="bg-emerald-500/15 text-emerald-400">▲ Long</Pill>
  ) : (
    <Pill className="bg-rose-500/15 text-rose-400">▼ Short</Pill>
  );
}

export function VerdictBadge({ verdict }: { verdict: RiskVerdict }) {
  const map: Record<RiskVerdict, string> = {
    APPROVED: "bg-emerald-500/15 text-emerald-400",
    REJECTED: "bg-rose-500/15 text-rose-400",
    WARNING: "bg-amber-500/15 text-amber-400",
  };
  return <Pill className={map[verdict]}>{verdict}</Pill>;
}

export function SignalStatusBadge({ status }: { status: SignalStatus }) {
  const map: Record<SignalStatus, string> = {
    NEW: "bg-sky-500/15 text-sky-400",
    REVIEWED: "bg-neutral-500/15 text-neutral-300",
    EXPIRED: "bg-neutral-700/40 text-neutral-500",
  };
  return <Pill className={map[status]}>{status}</Pill>;
}

export function TradeStatusBadge({ status }: { status: TradeStatus }) {
  const map: Record<TradeStatus, string> = {
    OPEN: "bg-sky-500/15 text-sky-400",
    CLOSED: "bg-neutral-500/15 text-neutral-300",
    CANCELLED: "bg-neutral-700/40 text-neutral-500",
  };
  return <Pill className={map[status]}>{status}</Pill>;
}

// --- table primitives --------------------------------------------------------

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
}) {
  return (
    <th
      className={`border-b border-neutral-800 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 text-${align}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  mono = false,
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`border-b border-neutral-800/60 px-3 py-2 text-${align} ${
        mono ? "font-mono tabular-nums" : ""
      } ${className}`}
    >
      {children}
    </td>
  );
}

/** Color a number by sign (positive emerald, negative rose). */
export function signTone(n: number): string {
  return n > 0 ? "text-emerald-400" : n < 0 ? "text-rose-400" : "text-neutral-400";
}

export function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-3 py-8 text-center text-sm text-neutral-600"
      >
        {label}
      </td>
    </tr>
  );
}
