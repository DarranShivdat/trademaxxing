import { MOCK_TRADE_ROWS } from "@/lib/dashboard/mock";
import {
  computeStats,
  rMultiple,
  sessionOf,
  type GroupStat,
  type TradeRow,
} from "@/lib/dashboard/metrics";
import { formatPct, formatR, formatRatio } from "@/lib/dashboard/format";
import { Card, StatTile, Table, Td, Th, signTone } from "@/components/ui";

export default function AnalyticsPage() {
  const stats = computeStats(MOCK_TRADE_ROWS);

  // Cumulative-R equity curve, ordered by close time (for a sparkline).
  const closed = MOCK_TRADE_ROWS.map((r) => r.trade)
    .filter((t) => t.status === "CLOSED" && t.closedAt)
    .sort((a, b) => (a.closedAt!.getTime() ?? 0) - (b.closedAt!.getTime() ?? 0));
  let cum = 0;
  const curve = closed.map((t) => {
    cum += rMultiple(t) ?? 0;
    return cum;
  });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-lg font-semibold">Analytics</h1>
        <p className="text-sm text-neutral-500">
          Performance across {stats.closedTrades} closed trades.{" "}
          <span className="text-neutral-600">(computed from mock trade log)</span>
        </p>
      </header>

      {/* Headline metrics */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Win Rate"
          value={formatPct(stats.winRate)}
          sub={`${stats.wins}W · ${stats.losses}L`}
          tone={stats.winRate >= 0.5 ? "pos" : "neutral"}
        />
        <StatTile
          label="Avg R"
          value={formatR(stats.avgR)}
          sub="per closed trade"
          tone={stats.avgR > 0 ? "pos" : "neg"}
        />
        <StatTile
          label="Net R"
          value={formatR(stats.totalR)}
          sub="cumulative"
          tone={stats.totalR > 0 ? "pos" : "neg"}
        />
        <StatTile
          label="Profit Factor"
          value={formatRatio(stats.profitFactor)}
          sub="gross win / loss"
          tone={stats.profitFactor >= 1 ? "pos" : "neg"}
        />
        <StatTile
          label="Max Drawdown"
          value={`-${stats.maxDrawdownR.toFixed(2)}R`}
          sub="peak-to-trough"
          tone="neg"
        />
        <StatTile
          label="Trades"
          value={stats.totalTrades}
          sub={`${stats.openTrades} open`}
        />
      </div>

      {/* Equity curve */}
      <Card title="Equity Curve (cumulative R)">
        <div className="p-4">
          <EquityCurve points={curve} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="By Setup">
          <ExtremesNote best={stats.bestSetup} worst={stats.worstSetup} />
          <GroupTable
            rows={groupBy(MOCK_TRADE_ROWS, (r) => r.setupName)}
            bestKey={stats.bestSetup?.key}
            worstKey={stats.worstSetup?.key}
            header="Setup"
          />
        </Card>

        <Card title="By Session">
          <ExtremesNote best={stats.bestSession} worst={stats.worstSession} />
          <GroupTable
            rows={groupBy(MOCK_TRADE_ROWS, (r) =>
              sessionLabel(r.trade.openedAt),
            )}
            bestKey={stats.bestSession?.key}
            worstKey={stats.worstSession?.key}
            header="Session"
          />
        </Card>
      </div>
    </div>
  );
}

// --- helpers -----------------------------------------------------------------

function sessionLabel(d: Date): string {
  return sessionOf(d);
}

/** Aggregate closed-trade R stats per group key — same math computeStats uses. */
function groupBy(
  rows: TradeRow[],
  keyOf: (r: TradeRow) => string,
): GroupStat[] {
  const map = new Map<string, { rs: number[]; wins: number; n: number }>();
  for (const row of rows) {
    if (row.trade.status !== "CLOSED" || row.trade.pnl === undefined) continue;
    const r = rMultiple(row.trade);
    if (r === null) continue;
    const key = keyOf(row);
    const g = map.get(key) ?? { rs: [], wins: 0, n: 0 };
    g.rs.push(r);
    g.n += 1;
    if ((row.trade.pnl ?? 0) > 0) g.wins += 1;
    map.set(key, g);
  }
  return Array.from(map.entries())
    .map(([key, g]) => {
      const totalR = g.rs.reduce((a, b) => a + b, 0);
      return {
        key,
        trades: g.n,
        totalR,
        avgR: totalR / g.rs.length,
        winRate: g.wins / g.n,
      };
    })
    .sort((a, b) => b.avgR - a.avgR);
}

function ExtremesNote({
  best,
  worst,
}: {
  best: GroupStat | null;
  worst: GroupStat | null;
}) {
  if (!best || !worst) return null;
  return (
    <div className="flex gap-4 border-b border-neutral-800 px-4 py-2.5 text-xs">
      <span className="text-neutral-500">
        Best:{" "}
        <span className="font-medium text-emerald-400">{best.key}</span>{" "}
        <span className="font-mono">{formatR(best.avgR)}</span>
      </span>
      <span className="text-neutral-500">
        Worst:{" "}
        <span className="font-medium text-rose-400">{worst.key}</span>{" "}
        <span className="font-mono">{formatR(worst.avgR)}</span>
      </span>
    </div>
  );
}

function GroupTable({
  rows,
  bestKey,
  worstKey,
  header,
}: {
  rows: GroupStat[];
  bestKey?: string;
  worstKey?: string;
  header: string;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>{header}</Th>
          <Th align="right">Trades</Th>
          <Th align="right">Win %</Th>
          <Th align="right">Avg R</Th>
          <Th align="right">Net R</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => (
          <tr key={g.key} className="hover:bg-neutral-900/40">
            <Td>
              <span className="flex items-center gap-1.5">
                {g.key === bestKey && <Dot className="bg-emerald-400" />}
                {g.key === worstKey && <Dot className="bg-rose-400" />}
                <span className="text-neutral-200">{g.key}</span>
              </span>
            </Td>
            <Td align="right" mono className="text-neutral-400">
              {g.trades}
            </Td>
            <Td align="right" mono className="text-neutral-400">
              {formatPct(g.winRate, 0)}
            </Td>
            <Td align="right" mono className={signTone(g.avgR)}>
              {formatR(g.avgR)}
            </Td>
            <Td align="right" mono className={signTone(g.totalR)}>
              {formatR(g.totalR)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${className}`} />;
}

/** Minimal inline SVG sparkline of the cumulative-R curve. */
function EquityCurve({ points }: { points: number[] }) {
  if (points.length < 2) {
    return <p className="text-sm text-neutral-600">Not enough data.</p>;
  }
  const w = 600;
  const h = 120;
  const pad = 4;
  const series = [0, ...points];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (w - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const path = series
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  const last = series[series.length - 1];
  const stroke = last >= 0 ? "#34d399" : "#fb7185";
  const zeroY = y(0);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-32 w-full"
      preserveAspectRatio="none"
    >
      {/* zero baseline */}
      <line
        x1={pad}
        x2={w - pad}
        y1={zeroY}
        y2={zeroY}
        stroke="#404040"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      <path d={path} fill="none" stroke={stroke} strokeWidth={2} />
    </svg>
  );
}
