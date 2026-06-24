// Analytics derived from trade results. This is display-side aggregation over
// PaperTrade[] (win rate, R multiples, drawdown, groupings) — NOT trade
// detection or risk logic, which live in other modules. Everything here is a
// pure function of its inputs.

import type { PaperTrade } from "@/lib/types";

/**
 * A PaperTrade paired with the display-only metadata the dashboard groups by.
 * `PaperTrade` (the contract shape) intentionally carries no setup name, so the
 * "best/worst setup" view needs this thin wrapper. Real data would join this in
 * from the originating Signal's Setup.
 */
export interface TradeRow {
  trade: PaperTrade;
  /** Strategy/setup label, e.g. "London ORB" — sourced from the signal upstream. */
  setupName: string;
}

export type TradingSession = "Asian" | "London" | "New York";

/**
 * Bucket a trade into a trading session from its open time (UTC hour). Pure
 * presentation grouping — approximate session windows for forex/gold.
 */
export function sessionOf(openedAt: Date): TradingSession {
  const h = openedAt.getUTCHours();
  if (h >= 0 && h < 7) return "Asian";
  if (h >= 7 && h < 13) return "London";
  return "New York"; // 13:00–24:00 UTC
}

/** Risk per unit in price terms (distance from entry to stop). */
function riskPerUnit(trade: PaperTrade): number {
  return Math.abs(trade.entry - trade.stopLoss);
}

/**
 * Realized result expressed in R (reward-to-risk multiples). Returns null when
 * the trade is not closed or risk is undefined (zero stop distance / size).
 */
export function rMultiple(trade: PaperTrade): number | null {
  if (trade.status !== "CLOSED" || trade.pnl === undefined) return null;
  const riskAmount = riskPerUnit(trade) * trade.size;
  if (riskAmount <= 0) return null;
  return trade.pnl / riskAmount;
}

function isClosed(trade: PaperTrade): boolean {
  return trade.status === "CLOSED" && trade.pnl !== undefined;
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** Sum of R over trades closed on the same UTC day as `day`. */
export function pnlInRForDay(trades: PaperTrade[], day: Date): number {
  return trades.reduce((sum, t) => {
    if (!t.closedAt || !isSameUtcDay(t.closedAt, day)) return sum;
    const r = rMultiple(t);
    return r === null ? sum : sum + r;
  }, 0);
}

export interface GroupStat {
  key: string;
  trades: number;
  totalR: number;
  avgR: number;
  winRate: number;
}

export interface TradeStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  avgR: number;
  profitFactor: number;
  /** Max peak-to-trough drawdown of the cumulative-R equity curve (in R). */
  maxDrawdownR: number;
  bestSetup: GroupStat | null;
  worstSetup: GroupStat | null;
  bestSession: GroupStat | null;
  worstSession: GroupStat | null;
}

function groupStats(
  rows: { key: string; trade: PaperTrade }[],
): GroupStat[] {
  const byKey = new Map<string, PaperTrade[]>();
  for (const { key, trade } of rows) {
    if (!isClosed(trade)) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(trade);
    byKey.set(key, arr);
  }

  const stats: GroupStat[] = [];
  for (const [key, trades] of byKey) {
    const rs = trades.map(rMultiple).filter((r): r is number => r !== null);
    if (rs.length === 0) continue;
    const totalR = rs.reduce((a, b) => a + b, 0);
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    stats.push({
      key,
      trades: trades.length,
      totalR,
      avgR: totalR / rs.length,
      winRate: wins / trades.length,
    });
  }
  return stats;
}

function pickExtremes(
  stats: GroupStat[],
): { best: GroupStat | null; worst: GroupStat | null } {
  if (stats.length === 0) return { best: null, worst: null };
  const sorted = [...stats].sort((a, b) => b.avgR - a.avgR);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

/** Compute the full analytics summary from a set of trade rows. */
export function computeStats(rows: TradeRow[]): TradeStats {
  const trades = rows.map((r) => r.trade);
  const closed = trades.filter(isClosed);
  const open = trades.filter((t) => t.status === "OPEN");

  const rs = closed.map(rMultiple).filter((r): r is number => r !== null);
  const totalR = rs.reduce((a, b) => a + b, 0);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0).length;

  const grossProfit = closed
    .map((t) => t.pnl ?? 0)
    .filter((p) => p > 0)
    .reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(
    closed
      .map((t) => t.pnl ?? 0)
      .filter((p) => p < 0)
      .reduce((a, b) => a + b, 0),
  );

  // Max drawdown over the cumulative-R equity curve, ordered by close time.
  const ordered = [...closed].sort(
    (a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0),
  );
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of ordered) {
    const r = rMultiple(t);
    if (r === null) continue;
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  const setupStats = groupStats(
    rows.map((r) => ({ key: r.setupName, trade: r.trade })),
  );
  const sessionStats = groupStats(
    rows.map((r) => ({ key: sessionOf(r.trade.openedAt), trade: r.trade })),
  );
  const setups = pickExtremes(setupStats);
  const sessions = pickExtremes(sessionStats);

  return {
    totalTrades: trades.length,
    openTrades: open.length,
    closedTrades: closed.length,
    wins,
    losses,
    winRate: closed.length ? wins / closed.length : 0,
    totalR,
    avgR: rs.length ? totalR / rs.length : 0,
    profitFactor: grossLoss === 0 ? Infinity : grossProfit / grossLoss,
    maxDrawdownR,
    bestSetup: setups.best,
    worstSetup: setups.worst,
    bestSession: sessions.best,
    worstSession: sessions.worst,
  };
}
