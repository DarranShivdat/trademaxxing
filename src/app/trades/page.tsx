// Paper Trades page — server component. Reads real paper trades from the DB
// (falling back to the mock log when none are logged yet) and passes them to
// the client island that owns the filter UI.

import { getTradeData } from "@/lib/dashboard/data";
import { TradesClient } from "./trades-client";

export const dynamic = "force-dynamic";

export default async function TradesPage() {
  const { rows, isMock } = await getTradeData();

  const setupNames = Array.from(new Set(rows.map((r) => r.setupName))).sort();
  const symbols = Array.from(new Set(rows.map((r) => r.trade.symbol))).sort();

  return (
    <TradesClient
      tradeRows={rows}
      setupNames={setupNames}
      symbols={symbols}
      isMock={isMock}
    />
  );
}
