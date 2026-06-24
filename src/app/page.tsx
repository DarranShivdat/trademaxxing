import {
  MOCK_INSTRUMENTS,
  MOCK_RULE_STATUS,
  MOCK_TRADES,
  quoteFor,
} from "@/lib/dashboard/mock";
import { pnlInRForDay, rMultiple } from "@/lib/dashboard/metrics";
import {
  formatDateTime,
  formatPrice,
  formatR,
  formatTime,
} from "@/lib/dashboard/format";
import {
  Card,
  DirectionBadge,
  StatTile,
  Table,
  Td,
  Th,
  TradeStatusBadge,
  VerdictBadge,
  signTone,
} from "@/components/ui";

export default function Home() {
  const now = new Date();
  const todayR = pnlInRForDay(MOCK_TRADES, now);
  const openTrades = MOCK_TRADES.filter((t) => t.status === "OPEN");
  const closedToday = MOCK_TRADES.filter(
    (t) =>
      t.closedAt &&
      t.closedAt.getUTCDate() === now.getUTCDate() &&
      t.closedAt.getUTCMonth() === now.getUTCMonth(),
  );
  const wins = closedToday.filter((t) => (t.pnl ?? 0) > 0).length;

  const worstRule = MOCK_RULE_STATUS.find((r) => r.decision.verdict === "REJECTED");

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-sm text-neutral-500">
          Live instruments, today&apos;s result, and risk-rule status.
        </p>
      </header>

      {/* Top-line stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Today's P/L"
          value={formatR(todayR)}
          sub={`${closedToday.length} closed · ${wins}W ${closedToday.length - wins}L`}
          tone={todayR > 0 ? "pos" : todayR < 0 ? "neg" : "neutral"}
        />
        <StatTile
          label="Open Trades"
          value={openTrades.length}
          sub={`${MOCK_INSTRUMENTS.length} instruments tracked`}
        />
        <StatTile
          label="Active Instruments"
          value={MOCK_INSTRUMENTS.length}
          sub={MOCK_INSTRUMENTS.map((i) => i.symbol).join(" · ")}
        />
        <StatTile
          label="Rule Status"
          value={worstRule ? worstRule.decision.verdict : "OK"}
          sub={worstRule ? worstRule.rule : "All rules within limits"}
          tone={worstRule ? "neg" : "pos"}
        />
      </div>

      {/* Instruments */}
      <Card title="Active Instruments">
        <Table>
          <thead>
            <tr>
              <Th>Symbol</Th>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th align="right">Price</Th>
              <Th align="right">As of</Th>
            </tr>
          </thead>
          <tbody>
            {MOCK_INSTRUMENTS.map((inst) => {
              const quote = quoteFor(inst.symbol);
              return (
                <tr key={inst.symbol} className="hover:bg-neutral-900/40">
                  <Td mono className="font-semibold text-neutral-100">
                    {inst.symbol}
                  </Td>
                  <Td className="text-neutral-400">{inst.name}</Td>
                  <Td>
                    <span className="text-[11px] uppercase tracking-wide text-neutral-500">
                      {inst.type}
                    </span>
                  </Td>
                  <Td align="right" mono className="text-neutral-100">
                    {quote ? formatPrice(quote.price, inst.quotePrecision) : "—"}
                  </Td>
                  <Td align="right" mono className="text-neutral-600">
                    {quote ? formatTime(quote.timestamp) : "—"}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Open positions */}
        <Card title="Open Positions">
          {openTrades.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-neutral-600">
              No open positions.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Symbol</Th>
                  <Th>Side</Th>
                  <Th align="right">Entry</Th>
                  <Th align="right">Stop</Th>
                  <Th align="right">Target</Th>
                  <Th align="right">Opened</Th>
                </tr>
              </thead>
              <tbody>
                {openTrades.map((t) => (
                  <tr key={t.id} className="hover:bg-neutral-900/40">
                    <Td mono className="font-semibold">
                      {t.symbol}
                    </Td>
                    <Td>
                      <DirectionBadge direction={t.direction} />
                    </Td>
                    <Td align="right" mono>
                      {formatPrice(t.entry)}
                    </Td>
                    <Td align="right" mono className="text-rose-400/80">
                      {formatPrice(t.stopLoss)}
                    </Td>
                    <Td align="right" mono className="text-emerald-400/80">
                      {formatPrice(t.target)}
                    </Td>
                    <Td align="right" mono className="text-neutral-600">
                      {formatTime(t.openedAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {/* Rule status */}
        <Card title="Risk-Rule Status">
          <ul className="divide-y divide-neutral-800/60">
            {MOCK_RULE_STATUS.map((r) => (
              <li
                key={r.rule}
                className="flex items-start justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-medium text-neutral-200">
                    {r.rule}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {r.decision.reasons.join(" · ")}
                  </div>
                </div>
                <VerdictBadge verdict={r.decision.verdict} />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Recently closed */}
      <Card title="Closed Today">
        <Table>
          <thead>
            <tr>
              <Th>Symbol</Th>
              <Th>Side</Th>
              <Th align="right">Entry</Th>
              <Th align="right">Exit</Th>
              <Th align="right">Result</Th>
              <Th align="right">Closed</Th>
              <Th align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            {closedToday.length === 0 ? (
              <tr>
                <Td align="center" className="text-neutral-600">
                  <span className="block py-6">No trades closed today.</span>
                </Td>
              </tr>
            ) : (
              closedToday.map((t) => {
                const r = rMultiple(t);
                return (
                  <tr key={t.id} className="hover:bg-neutral-900/40">
                    <Td mono className="font-semibold">
                      {t.symbol}
                    </Td>
                    <Td>
                      <DirectionBadge direction={t.direction} />
                    </Td>
                    <Td align="right" mono>
                      {formatPrice(t.entry)}
                    </Td>
                    <Td align="right" mono>
                      {t.exitPrice !== undefined ? formatPrice(t.exitPrice) : "—"}
                    </Td>
                    <Td
                      align="right"
                      mono
                      className={r !== null ? signTone(r) : ""}
                    >
                      {formatR(r)}
                    </Td>
                    <Td align="right" mono className="text-neutral-600">
                      {t.closedAt ? formatDateTime(t.closedAt) : "—"}
                    </Td>
                    <Td align="right">
                      <TradeStatusBadge status={t.status} />
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
