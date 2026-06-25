import { test } from "node:test";
import assert from "node:assert/strict";
import { bar, candles } from "@/lib/engine/__tests__/helpers";
import type { Setup } from "@/lib/types";
import { simulateTrade, type BacktestTrade } from "../run";
import { computeBacktestStats } from "../metrics";
import { applyCost, tradeCostR, stopDistance, type CostModel } from "../cost";

// A resolved trade with a chosen R, mirroring run.test.ts' rTrade helper so the
// price-pnl path and the R-field path resolve to the same R. entry 100, risk 10.
let seq = 0;
function rTrade(r: number, direction: "LONG" | "SHORT" = "LONG"): BacktestTrade {
  seq += 1;
  const entry = 100;
  const risk = 10;
  const isWin = r > 0;
  const stopLoss = direction === "LONG" ? entry - risk : entry + risk;
  const target =
    direction === "LONG" ? entry + Math.abs(r) * risk : entry - Math.abs(r) * risk;
  const winExit = direction === "LONG" ? entry + r * risk : entry - r * risk;
  return {
    direction,
    entryIndex: seq,
    entryTime: new Date(2026, 0, 1, seq),
    exitIndex: seq + 1,
    exitTime: new Date(2026, 0, 1, seq + 1),
    entry,
    stopLoss,
    target,
    riskReward: Math.abs(r),
    outcome: isWin ? "WIN" : "LOSS",
    exitPrice: isWin ? winExit : stopLoss,
    r: isWin ? r : -1,
    confidence: 0.7,
    ambiguousBar: false,
  };
}

function openTrade(): BacktestTrade {
  seq += 1;
  return {
    direction: "LONG",
    entryIndex: seq,
    entryTime: new Date(2026, 0, 1, seq),
    entry: 100,
    stopLoss: 90,
    target: 120,
    riskReward: 2,
    outcome: "OPEN",
    r: null,
    confidence: 0.7,
    ambiguousBar: false,
  };
}

// ---------------------------------------------------------------------------
// tradeCostR — price→R conversion is per-trade by stop distance.
// ---------------------------------------------------------------------------

test("tradeCostR: R model is the flat cost, independent of stop distance", () => {
  const model: CostModel = { kind: "r", perTradeR: 0.05 };
  assert.equal(tradeCostR(rTrade(2), model), 0.05);
  // A wider stop doesn't change a flat-R cost.
  const wide = { ...rTrade(2), stopLoss: 50 }; // distance 50
  assert.equal(tradeCostR(wide, model), 0.05);
});

test("tradeCostR: price model divides price cost by THIS trade's stop distance", () => {
  const model: CostModel = { kind: "price", priceUnits: 0.4 };
  // entry 100, stop 90 → distance 10 → 0.4 / 10 = 0.04R.
  assert.ok(Math.abs(tradeCostR(rTrade(2), model) - 0.04) < 1e-12);
  // Same $0.40 on a tighter $3 stop is a bigger R hit: 0.4 / 3 ≈ 0.1333R.
  const tight = { ...rTrade(2), stopLoss: 97 }; // distance 3
  assert.equal(stopDistance(tight), 3);
  assert.ok(Math.abs(tradeCostR(tight, model) - 0.4 / 3) < 1e-12);
});

test("tradeCostR: degenerate zero stop distance charges nothing (guard)", () => {
  const degenerate = { ...rTrade(2), stopLoss: 100 }; // distance 0
  assert.equal(tradeCostR(degenerate, { kind: "price", priceUnits: 1 }), 0);
});

// ---------------------------------------------------------------------------
// applyCost — both winners and losers pay; both metric paths stay in agreement.
// ---------------------------------------------------------------------------

test("applyCost: zero cost is an identity on R (no-op deduction)", () => {
  const trades = [rTrade(2), rTrade(-1), rTrade(2, "SHORT")];
  const out = applyCost(trades, { kind: "r", perTradeR: 0 });
  out.forEach((t, i) => assert.equal(t.r, trades[i].r));
});

test("applyCost: a WIN and a LOSS both pay the cost (R model)", () => {
  const [win, loss] = applyCost([rTrade(2), rTrade(-1)], {
    kind: "r",
    perTradeR: 0.05,
  });
  assert.ok(Math.abs((win.r as number) - 1.95) < 1e-12, "win: 2 − 0.05");
  assert.ok(Math.abs((loss.r as number) - -1.05) < 1e-12, "loss: −1 − 0.05");
  // Outcome labels survive — the target/stop was still touched.
  assert.equal(win.outcome, "WIN");
  assert.equal(loss.outcome, "LOSS");
});

test("applyCost: does not mutate the input trades", () => {
  const trades = [rTrade(2), rTrade(-1)];
  const snapshot = trades.map((t) => ({ r: t.r, exitPrice: t.exitPrice }));
  applyCost(trades, { kind: "price", priceUnits: 0.4 });
  trades.forEach((t, i) => {
    assert.equal(t.r, snapshot[i].r);
    assert.equal(t.exitPrice, snapshot[i].exitPrice);
  });
});

test("applyCost: OPEN trades pass through untouched", () => {
  const open = openTrade();
  const [out] = applyCost([open], { kind: "r", perTradeR: 0.1 });
  assert.equal(out.r, null);
  assert.equal(out.outcome, "OPEN");
  assert.equal(out.exitPrice, undefined);
});

test("applyCost: SHORT exit shifts UP (worse fill), LONG exit shifts DOWN", () => {
  const [long] = applyCost([rTrade(2, "LONG")], { kind: "price", priceUnits: 0.4 });
  const [short] = applyCost([rTrade(2, "SHORT")], { kind: "price", priceUnits: 0.4 });
  // LONG win exit was entry+20 = 120 → 119.6 (sold lower).
  assert.ok(Math.abs((long.exitPrice as number) - 119.6) < 1e-9);
  // SHORT win exit was entry−20 = 80 → 80.4 (bought back higher).
  assert.ok(Math.abs((short.exitPrice as number) - 80.4) < 1e-9);
});

// ---------------------------------------------------------------------------
// METRIC AGREEMENT — the central invariant: after costs, the price-pnl path
// (avgR) and the R-field path (expectancy) must STILL agree, exactly as the
// uncosted run does. This is what proves we charged both paths identically.
// ---------------------------------------------------------------------------

test("applyCost: avgR (price path) and expectancy (R path) agree after costs", () => {
  const trades = [
    rTrade(2),
    rTrade(2),
    rTrade(-1),
    rTrade(2, "SHORT"),
    rTrade(-1, "SHORT"),
  ];
  const net = applyCost(trades, { kind: "r", perTradeR: 0.05 });
  const s = computeBacktestStats(net);
  // The two independently-derived numbers must coincide (as in run.test.ts).
  assert.ok(
    Math.abs(s.avgR - s.expectancy) < 1e-9,
    `avgR ${s.avgR} != expectancy ${s.expectancy}`,
  );
});

test("applyCost: net expectancy = gross expectancy − mean per-trade cost (R model)", () => {
  // 8 wins +2, 2 losses −1 ⇒ gross expectancy 1.4. Flat 0.05R cost ⇒ 1.35.
  const trades = [
    ...Array.from({ length: 8 }, () => rTrade(2)),
    ...Array.from({ length: 2 }, () => rTrade(-1)),
  ];
  const gross = computeBacktestStats(trades);
  const net = computeBacktestStats(applyCost(trades, { kind: "r", perTradeR: 0.05 }));
  assert.ok(Math.abs(gross.expectancy - 1.4) < 1e-9);
  assert.ok(Math.abs(net.expectancy - 1.35) < 1e-9);
});

test("applyCost: price-model net edge matches the mean cost/R over a mixed-stop pool", () => {
  // Two wins with DIFFERENT stop distances, same $0.40 cost → different R hits.
  //   trade A: stop 90 (dist 10) → 0.04R ; trade B: stop 96 (dist 4) → 0.10R
  //   gross expectancy = 2 ; mean cost = (0.04+0.10)/2 = 0.07 ; net = 1.93
  const a = rTrade(2); // dist 10
  const b = { ...rTrade(2), stopLoss: 96 }; // dist 4
  const net = computeBacktestStats(applyCost([a, b], { kind: "price", priceUnits: 0.4 }));
  assert.ok(Math.abs(net.expectancy - 1.93) < 1e-9, `got ${net.expectancy}`);
});

// ---------------------------------------------------------------------------
// END-TO-END through simulateTrade output — cost applied to real simulated R.
// ---------------------------------------------------------------------------

function fakeSetup(overrides: Partial<Setup> = {}): Setup {
  return {
    symbol: "XAU/USD",
    timeframe: "1h",
    direction: "LONG",
    entryZone: { low: 99, high: 100 },
    stopLoss: 95,
    target: 110,
    riskReward: 2,
    invalidation: "test",
    confidence: 0.7,
    reasonCodes: ["TREND_UP"],
    rawFeatures: {},
    ...overrides,
  };
}

test("applyCost: charges a real simulated WIN — entry 100, stop 95, $1 cost ⇒ 0.2R off", () => {
  // Stop distance 5 → $1 cost = 0.2R. Win was +2R → net +1.8R.
  const cs = candles([bar(100, 100, 100, 100), bar(100, 109, 111, 96)]);
  const win = simulateTrade(cs, 0, fakeSetup());
  assert.equal(win.r, 2);
  const [net] = applyCost([win], { kind: "price", priceUnits: 1 });
  assert.ok(Math.abs((net.r as number) - 1.8) < 1e-9, `got ${net.r}`);
});
