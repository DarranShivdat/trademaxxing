"use client";

import { useMemo, useState } from "react";
import type { TradeRow } from "@/lib/dashboard/metrics";
import { rMultiple, sessionOf, type TradingSession } from "@/lib/dashboard/metrics";
import { formatDateTime, formatPrice, formatR } from "@/lib/dashboard/format";
import {
  Card,
  DirectionBadge,
  EmptyRow,
  Table,
  Td,
  Th,
  TradeStatusBadge,
  signTone,
} from "@/components/ui";

const SESSIONS: (TradingSession | "All")[] = ["All", "Asian", "London", "New York"];
const STATUSES = ["All", "OPEN", "CLOSED", "CANCELLED"] as const;

export function TradesClient({
  tradeRows,
  setupNames,
  symbols,
  isMock,
}: {
  tradeRows: TradeRow[];
  setupNames: string[];
  symbols: string[];
  isMock: boolean;
}) {
  const [setup, setSetup] = useState("All");
  const [session, setSession] = useState<TradingSession | "All">("All");
  const [symbol, setSymbol] = useState("All");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("All");

  const rows = useMemo(() => {
    return tradeRows
      .filter((r) => {
        if (setup !== "All" && r.setupName !== setup) return false;
        if (symbol !== "All" && r.trade.symbol !== symbol) return false;
        if (session !== "All" && sessionOf(r.trade.openedAt) !== session) return false;
        if (status !== "All" && r.trade.status !== status) return false;
        return true;
      })
      .sort((a, b) => b.trade.openedAt.getTime() - a.trade.openedAt.getTime());
  }, [tradeRows, setup, session, symbol, status]);

  const closedR = rows
    .map((r) => rMultiple(r.trade))
    .filter((r): r is number => r !== null);
  const netR = closedR.reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Paper Trades</h1>
          <p className="text-sm text-neutral-500">
            Trade log — results expressed in R (reward-to-risk multiples).{" "}
            {isMock && (
              <span className="text-amber-500/80">
                Demo data — accept a signal to log real paper trades.
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wider text-neutral-500">
            Net (filtered)
          </div>
          <div className={`font-mono text-xl tabular-nums ${signTone(netR)}`}>
            {formatR(netR)}
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select label="Setup" value={setup} onChange={setSetup} options={["All", ...setupNames]} />
        <Select
          label="Session"
          value={session}
          onChange={(v) => setSession(v as TradingSession | "All")}
          options={SESSIONS}
        />
        <Select label="Symbol" value={symbol} onChange={setSymbol} options={["All", ...symbols]} />
        <Select
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as (typeof STATUSES)[number])}
          options={[...STATUSES]}
        />
        <div className="ml-auto flex items-end text-xs text-neutral-600">
          {rows.length} of {tradeRows.length} trades
        </div>
      </div>

      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Opened</Th>
              <Th>Symbol</Th>
              <Th>Side</Th>
              <Th>Setup</Th>
              <Th>Session</Th>
              <Th align="right">Entry</Th>
              <Th align="right">Exit</Th>
              <Th align="right">R:R</Th>
              <Th align="right">Result</Th>
              <Th align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow colSpan={10} label="No trades match these filters." />
            ) : (
              rows.map(({ trade, setupName }) => {
                const r = rMultiple(trade);
                return (
                  <tr key={trade.id} className="hover:bg-neutral-900/40">
                    <Td mono className="text-neutral-500">
                      {formatDateTime(trade.openedAt)}
                    </Td>
                    <Td mono className="font-semibold">
                      {trade.symbol}
                    </Td>
                    <Td>
                      <DirectionBadge direction={trade.direction} />
                    </Td>
                    <Td className="text-neutral-300">{setupName}</Td>
                    <Td className="text-neutral-500">{sessionOf(trade.openedAt)}</Td>
                    <Td align="right" mono>
                      {formatPrice(trade.entry)}
                    </Td>
                    <Td align="right" mono>
                      {trade.exitPrice !== undefined ? formatPrice(trade.exitPrice) : "—"}
                    </Td>
                    <Td align="right" mono className="text-neutral-500">
                      {trade.riskReward.toFixed(1)}
                    </Td>
                    <Td
                      align="right"
                      mono
                      className={`font-semibold ${r !== null ? signTone(r) : "text-neutral-600"}`}
                    >
                      {formatR(r)}
                    </Td>
                    <Td align="right">
                      <TradeStatusBadge status={trade.status} />
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}
