// Transaction-cost model for the backtester — a PURE, POST-TRADE deduction.
//
// This module does not detect, simulate, or re-price anything. It takes trades
// the existing backtester already produced (see ./run.ts) and charges each one a
// real-world transaction cost (spread + slippage), returning NEW trades with the
// cost baked in. Detection, the no-lookahead contract, intrabar resolution and
// the metric formulas (./metrics.ts) are all untouched — feed `applyCost`'s
// output straight into `computeBacktestStats` and every metric reflects costs.
//
// WHY COST IS MODELLED AS A WORSE EXIT FILL.
//   A transaction cost is, physically, getting filled at a worse price: you buy
//   a hair above and sell a hair below the "clean" price the chart shows. So we
//   push each resolved trade's exit AGAINST the position by the cost in price
//   units — a LONG exits lower, a SHORT exits higher. This single adjustment
//   keeps BOTH of computeBacktestStats' paths consistent for free:
//     • the price-pnl path (computeStats → rMultiple = pnl / risk) sees the
//       worse exit, so avg R / win rate / profit factor / drawdown all drop;
//     • the R-field path (expectancy / avgWinR / avgLossR) reads `r`, which we
//       recompute to the identical net value.
//   Charging it any other way (e.g. only touching `r`) would desync the two
//   paths and break the metric-agreement invariant the tests pin.
//
// COST-IN-R VS COST-IN-PRICE (and why price is the honest default).
//   Cost expressed as a flat fraction of R (`--cost-r 0.05`) pretends every
//   trade risks the same number of price units — it does not. The SAME $0.40
//   spread is 0.13R on a trade with a $3 stop but only 0.03R on one with a $13
//   stop. So the price model converts a fixed price cost to R PER TRADE using
//   that trade's own stop distance |entry − stopLoss| (its 1R), which is why it
//   is the default. The R model is kept for quick what-ifs and for sweeping the
//   curve in directly-comparable R units.

import type { BacktestTrade } from "./run";

/**
 * How a transaction cost is specified.
 *
 *  • `r`     — a flat cost in R applied to every trade (e.g. 0.05R). Simple, but
 *              ignores that a fixed money/price cost is a different fraction of R
 *              for tight vs wide stops.
 *  • `price` — a cost in PRICE units (the instrument's quote units, e.g. dollars
 *              for XAU/USD): the round-turn spread + slippage you actually pay.
 *              Converted to R per trade via the trade's own stop distance. This
 *              is the honest default — see the module header.
 */
export type CostModel =
  | { kind: "r"; perTradeR: number }
  | { kind: "price"; priceUnits: number };

/** A trade's 1R in price units: the entry→stop distance. 0 if degenerate. */
export function stopDistance(trade: BacktestTrade): number {
  return Math.abs(trade.entry - trade.stopLoss);
}

/**
 * The transaction cost charged to a single trade, expressed in R.
 *
 * R model: the flat `perTradeR`, unchanged. Price model: `priceUnits` divided by
 * the trade's stop distance — so a fixed price cost is a larger R hit on a
 * tight-stop trade than a wide-stop one. Returns 0 for a degenerate zero-distance
 * stop (the risk engine rejects those upstream, so this is just a guard).
 */
export function tradeCostR(trade: BacktestTrade, model: CostModel): number {
  if (model.kind === "r") return model.perTradeR;
  const dist = stopDistance(trade);
  if (dist <= 0) return 0;
  return model.priceUnits / dist;
}

/** The cost charged to a single trade, expressed in PRICE units (the fill shift). */
function tradeCostPrice(trade: BacktestTrade, model: CostModel): number {
  if (model.kind === "price") return model.priceUnits;
  // R model: a flat R cost is `perTradeR` of this trade's own 1R in price terms.
  return model.perTradeR * stopDistance(trade);
}

/**
 * Charge `model`'s transaction cost to every RESOLVED trade and return new
 * trades — the input array and its trades are never mutated.
 *
 * Both winners and losers pay (a worse exit fill applies regardless of outcome),
 * so a +2R win books less and a −1R loss books worse. The cost is applied as an
 * adverse shift to `exitPrice` (LONG down, SHORT up) and `r` is recomputed to the
 * matching net value, keeping computeBacktestStats' price-pnl and R-field paths
 * in agreement. OUTCOME LABELS (WIN/LOSS) are intentionally preserved: hitting
 * the target is a real market event; cost erodes the booked R, it doesn't undo
 * the touch. (Winners clear ≥2R given the engine's reward-to-risk floor, so at
 * realistic/swept cost levels a win's net R stays positive and win/loss counts
 * are stable. The price model's per-trade R cost = priceUnits/stopDistance is
 * unbounded, though, so an abnormally tight stop — or a very large flat R cost —
 * CAN drive a marginal win negative; both metric paths derive win/loss from the
 * NET sign, so such a flip is reflected consistently, never desyncing them.)
 *
 * OPEN/unresolved trades pass through untouched — they have no realized R to
 * charge and are excluded from every resolved metric anyway.
 */
export function applyCost(
  trades: BacktestTrade[],
  model: CostModel,
): BacktestTrade[] {
  return trades.map((t) => {
    if (t.outcome === "OPEN" || t.r === null || t.exitPrice === undefined) {
      return t;
    }
    const costR = tradeCostR(t, model);
    const costPrice = tradeCostPrice(t, model);
    const isLong = t.direction === "LONG";
    // Worse fill: long sells lower, short buys back higher.
    const exitPrice = isLong ? t.exitPrice - costPrice : t.exitPrice + costPrice;
    return { ...t, exitPrice, r: t.r - costR };
  });
}
