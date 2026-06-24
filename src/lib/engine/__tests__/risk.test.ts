import { test } from "node:test";
import assert from "node:assert/strict";
import type { Setup } from "@/lib/types";
import { evaluateRisk, positionSize } from "../risk";

function setup(overrides: Partial<Setup> = {}): Setup {
  return {
    symbol: "XAU/USD",
    timeframe: "1h",
    direction: "LONG",
    entryZone: { low: 2000, high: 2002 }, // mid 2001
    stopLoss: 1991, // risk 10/unit
    target: 2031, // +30 -> RR 3
    riskReward: 3,
    invalidation: "x",
    confidence: 0.8,
    reasonCodes: [],
    rawFeatures: {},
    ...overrides,
  };
}

test("APPROVED: clean setup passes with sizing reported", () => {
  const d = evaluateRisk(setup(), { accountEquity: 10000, tradesToday: 0 });
  assert.equal(d.verdict, "APPROVED");
  assert.ok(d.reasons[0].includes("Size"));
});

test("REJECTED: daily trade cap reached", () => {
  const d = evaluateRisk(setup(), { accountEquity: 10000, tradesToday: 2 });
  assert.equal(d.verdict, "REJECTED");
  assert.ok(d.reasons.some((r) => r.includes("Daily trade limit")));
});

test("REJECTED: reward-to-risk below minimum", () => {
  const d = evaluateRisk(setup({ riskReward: 1.5 }), {
    accountEquity: 10000,
    tradesToday: 0,
  });
  assert.equal(d.verdict, "REJECTED");
  assert.ok(d.reasons.some((r) => r.includes("Reward-to-risk")));
});

test("REJECTED: duplicate signal in overlapping zone, same direction", () => {
  const d = evaluateRisk(setup(), {
    accountEquity: 10000,
    tradesToday: 0,
    existingSignals: [
      { direction: "LONG", entryZone: { low: 2001, high: 2005 } },
    ],
  });
  assert.equal(d.verdict, "REJECTED");
  assert.ok(d.reasons.some((r) => r.includes("Duplicate")));
});

test("not a duplicate when direction differs", () => {
  const d = evaluateRisk(setup(), {
    accountEquity: 10000,
    tradesToday: 0,
    existingSignals: [
      { direction: "SHORT", entryZone: { low: 2001, high: 2005 } },
    ],
  });
  assert.equal(d.verdict, "APPROVED");
});

test("WARNING: wide spread, news risk, low confidence — but no hard breach", () => {
  const d = evaluateRisk(setup({ confidence: 0.3 }), {
    accountEquity: 10000,
    tradesToday: 0,
    spread: 1.0,
    maxSpread: 0.5,
    newsRisk: true,
  });
  assert.equal(d.verdict, "WARNING");
  assert.ok(d.reasons.some((r) => r.includes("Spread")));
  assert.ok(d.reasons.some((r) => r.includes("news")));
  assert.ok(d.reasons.some((r) => r.includes("Confidence")));
});

test("REJECTED takes precedence over warnings", () => {
  const d = evaluateRisk(setup({ riskReward: 1, confidence: 0.1 }), {
    accountEquity: 10000,
    tradesToday: 5,
    newsRisk: true,
  });
  assert.equal(d.verdict, "REJECTED");
});

test("positionSize risks exactly 1% of equity at the stop", () => {
  // mid entry 2001, stop 1991 => risk 10/unit. 1% of 10000 = 100. size = 10.
  const size = positionSize(setup(), 10000, 1);
  assert.ok(Math.abs(size - 10) < 1e-9, `size ${size}`);
});

test("positionSize is zero for a degenerate stop", () => {
  const s = setup({ entryZone: { low: 2000, high: 2000 }, stopLoss: 2000 });
  assert.equal(positionSize(s, 10000, 1), 0);
});
