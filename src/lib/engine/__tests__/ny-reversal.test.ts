import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@/lib/types";
import { detectNyReversalAt } from "../setups/ny-reversal";
import { computeFeaturesAt } from "../features";
import { bar, candles } from "./helpers";
import type { Bar } from "./helpers";

/** Reflect a bar around price K: turns the SHORT fixture into its LONG mirror. */
const REFLECT = 220;
function reflect(b: Bar): Bar {
  return {
    open: REFLECT - b.open,
    close: REFLECT - b.close,
    high: REFLECT - b.low,
    low: REFLECT - b.high,
  };
}

/**
 * Day 0 (bars 0..23, one UTC day) sets the prior-session high ~110.5 and a
 * single distinct low ~95 (the only swing low / overhead-for-shorts support).
 * Day 1 sweeps above 110.5 and fails, closing back below on a bearish engulfing
 * — the session-sweep reversal. Built so a SHORT targeting the prior-session
 * low clears 2R.
 */
function shortSweepBars(): Bar[] {
  const bars: Bar[] = [
    // --- day 0: high 110.5 (idx4), sharp single low 95 (idx9), slow recovery ---
    { open: 105, close: 107, high: 107.3, low: 104.7 }, // 0
    { open: 107, close: 109, high: 109.3, low: 106.7 }, // 1
    { open: 109, close: 110, high: 110.4, low: 108.7 }, // 2
    { open: 110, close: 109, high: 110.2, low: 108.5 }, // 3
    { open: 109, close: 110, high: 110.5, low: 108.5 }, // 4  session high 110.5
    { open: 110, close: 108, high: 110.3, low: 107.5 }, // 5
    { open: 108, close: 106, high: 108.3, low: 105.5 }, // 6
    { open: 106, close: 103, high: 106.3, low: 102.5 }, // 7
    { open: 103, close: 98, high: 103.2, low: 96.5 }, // 8
    { open: 98, close: 96, high: 98.3, low: 95.0 }, // 9  session low 95 (swing low)
    { open: 96, close: 97, high: 97.3, low: 95.5 }, // 10  monotonic recovery (no swing lows)
    { open: 97, close: 98, high: 98.3, low: 96.5 }, // 11
    { open: 98, close: 99, high: 99.3, low: 97.5 }, // 12
    { open: 99, close: 100, high: 100.3, low: 98.5 }, // 13
    { open: 100, close: 101, high: 101.3, low: 99.5 }, // 14
    { open: 101, close: 102, high: 102.3, low: 100.5 }, // 15
    { open: 102, close: 103, high: 103.3, low: 101.5 }, // 16
    { open: 103, close: 104, high: 104.3, low: 102.5 }, // 17
    { open: 104, close: 105, high: 105.3, low: 103.5 }, // 18
    { open: 105, close: 106, high: 106.3, low: 104.5 }, // 19
    { open: 106, close: 107, high: 107.3, low: 105.5 }, // 20
    { open: 107, close: 108, high: 108.3, low: 106.5 }, // 21
    { open: 108, close: 108.5, high: 108.8, low: 107.5 }, // 22
    { open: 108.5, close: 108, high: 108.9, low: 107.5 }, // 23
    // --- day 1: approach, sweep above 110.5, fail and reverse below it ---
    { open: 108, close: 109, high: 109.3, low: 107.5 }, // 24
    { open: 109, close: 110, high: 110.4, low: 108.5 }, // 25
    { open: 110, close: 111, high: 112.5, low: 109.5 }, // 26  SWEEP high 112.5
    { open: 111, close: 108, high: 111.2, low: 107.5 }, // 27  bearish engulfing reversal
  ];
  // Future day-1 bars — must never influence the detection at bar 27.
  let price = 108;
  for (let i = 0; i < 6; i++) {
    const open = price;
    price += i % 2 === 0 ? -1.2 : 0.7;
    bars.push({
      open,
      close: price,
      high: Math.max(open, price) + 0.3,
      low: Math.min(open, price) - 0.3,
    });
  }
  return bars;
}

function firstFiring(cs: Candle[]): number {
  for (let n = 0; n < cs.length; n++) {
    if (detectNyReversalAt(cs, n)) return n;
  }
  return -1;
}

test("detectNyReversalAt: fires a valid SHORT on a failed sweep of the prior session high", () => {
  const cs = candles(shortSweepBars());
  const n = firstFiring(cs);
  assert.ok(n >= 0, "expected at least one NY-reversal setup");

  const setup = detectNyReversalAt(cs, n)!;
  assert.equal(setup.direction, "SHORT");
  assert.equal(setup.symbol, "XAU/USD");
  assert.ok(setup.stopLoss > setup.entryZone.high, "stop must sit above entry");
  assert.ok(setup.target < setup.entryZone.low, "target must sit below entry");
  assert.ok(setup.riskReward >= 2, `riskReward ${setup.riskReward} must be >= 2`);
  assert.ok(setup.confidence > 0 && setup.confidence <= 1);
  assert.ok(setup.reasonCodes.includes("SWEEP_HIGH"));
  assert.ok(setup.reasonCodes.includes("REVERSAL_CONFIRM"));

  // Stop sits beyond the swept extreme, and 1R is at least 1xATR.
  const f = computeFeaturesAt(cs, n)!;
  const sweepExtreme = setup.rawFeatures.sweepExtreme as number;
  assert.ok(setup.stopLoss >= sweepExtreme - 1e-9, "stop must protect the sweep extreme");
  const entry = setup.rawFeatures.entry as number;
  assert.ok(
    setup.stopLoss - entry >= f.atr14! - 1e-9,
    `1R (${setup.stopLoss - entry}) must be >= 1xATR (${f.atr14})`,
  );
});

test("detectNyReversalAt: fires a valid LONG on a failed sweep of the prior session low (mirror)", () => {
  const cs = candles(shortSweepBars().map(reflect));
  const n = firstFiring(cs);
  assert.ok(n >= 0, "expected at least one mirrored NY-reversal setup");

  const setup = detectNyReversalAt(cs, n)!;
  assert.equal(setup.direction, "LONG");
  assert.ok(setup.stopLoss < setup.entryZone.low, "stop must sit below entry");
  assert.ok(setup.target > setup.entryZone.high, "target must sit above entry");
  assert.ok(setup.riskReward >= 2, `riskReward ${setup.riskReward} must be >= 2`);
  assert.ok(setup.reasonCodes.includes("SWEEP_LOW"));
  assert.ok(setup.reasonCodes.includes("REVERSAL_CONFIRM"));
});

test("NO LOOKAHEAD: detection at N is identical with or without future candles", () => {
  const full = candles(shortSweepBars());
  let n = -1;
  for (let i = 0; i < full.length - 3; i++) {
    if (detectNyReversalAt(full, i)) {
      n = i;
      break;
    }
  }
  assert.ok(n >= 0, "needed a firing index with future candles after it");

  const resultWithFuture = detectNyReversalAt(full, n);
  const resultTruncated = detectNyReversalAt(full.slice(0, n + 1), n);
  assert.deepEqual(
    resultWithFuture,
    resultTruncated,
    "future candles changed the result — lookahead leak!",
  );

  const crazyFuture = candles([
    bar(9999, 10000, 10001, 9998),
    bar(1, 0.5, 2, 0.1),
    bar(500, 600, 650, 450),
  ]);
  const tampered = [...full.slice(0, n + 1), ...crazyFuture];
  assert.deepEqual(
    detectNyReversalAt(tampered, n),
    resultTruncated,
    "fabricated future candles changed the result — lookahead leak!",
  );
});

test("HONEST CONFIDENCE: equals the weighted sum of the recorded checks", () => {
  const cs = candles(shortSweepBars());
  const n = firstFiring(cs);
  const setup = detectNyReversalAt(cs, n)!;
  const checks = setup.rawFeatures.confidenceBreakdown as {
    name: string;
    passed: boolean;
    weight: number;
  }[];
  const total = checks.reduce((a, c) => a + c.weight, 0);
  const expected =
    checks.reduce((a, c) => a + (c.passed ? c.weight : 0), 0) / total;
  assert.ok(
    Math.abs(setup.confidence - expected) < 1e-9,
    "confidence is not the transparent weighted sum of its checks",
  );
  assert.ok(checks.find((c) => c.name === "sweptLiquidity")?.passed);
  assert.ok(checks.find((c) => c.name === "reversalConfirmed")?.passed);
});

/**
 * A one-bar sweep+reversal that wicks only just above the level and closes just
 * below it: the raw structural stop (beyond the sweep extreme) is microscopic,
 * so the ATR floor must widen 1R to a sane distance.
 */
function tightStopSweepBars(): Bar[] {
  const bars = shortSweepBars().slice(0, 26); // day 0 + approach
  // One-bar failed sweep: high barely above 110.5, close just back below it, so
  // the structural stop (sweep extreme + buffer) sits a hair above entry.
  bars.push({ open: 110.45, close: 110.3, high: 110.6, low: 108.8 }); // 26
  return bars;
}

test("ATR floor: a noise-tight sweep stop is widened to a sane 1R", () => {
  const cs = candles(tightStopSweepBars());
  const n = cs.length - 1;
  const f = computeFeaturesAt(cs, n)!;
  const setup = detectNyReversalAt(cs, n);
  assert.ok(setup, "fixture should fire an NY-reversal setup");

  const entry = setup!.rawFeatures.entry as number;
  const structuralStop = setup!.rawFeatures.structuralStop as number;
  const rawRisk = structuralStop - entry;
  assert.ok(
    rawRisk < f.atr14! * 0.5,
    `raw structural risk ${rawRisk} should be well under 0.5xATR (${f.atr14})`,
  );

  assert.equal(setup!.rawFeatures.stopAtrFloored, true);
  const risk = setup!.stopLoss - entry;
  assert.ok(
    Math.abs(risk - f.atr14!) < 1e-9,
    `1R (${risk}) should equal 1xATR (${f.atr14})`,
  );
});

/**
 * A genuine failed sweep, but the prior session low sits only just below entry
 * (shallow day-0 range), so the nearest structural target cannot clear 2R. The
 * detector must reject rather than reach for a synthetic target.
 */
function noTargetSweepBars(): Bar[] {
  const bars: Bar[] = [];
  // Day 0: shallow range 106..110.5 (prevSessionLow ~106, just below entry).
  for (let i = 0; i < 24; i++) {
    const hi = i === 4 ? 110.5 : 109 + (i % 3) * 0.3;
    const lo = i === 12 ? 106.0 : 107 + (i % 2) * 0.3;
    const open = 108 + (i % 2 === 0 ? -0.3 : 0.3);
    const close = 108 + (i % 2 === 0 ? 0.3 : -0.3);
    bars.push({ open, close, high: Math.max(hi, open, close), low: Math.min(lo, open, close) });
  }
  // Day 1: sweep above 110.5, fail back below.
  bars.push({ open: 108, close: 109, high: 109.3, low: 107.5 }); // 24
  bars.push({ open: 109, close: 110, high: 110.4, low: 108.5 }); // 25
  bars.push({ open: 110, close: 111, high: 112.5, low: 109.5 }); // 26 sweep
  bars.push({ open: 111, close: 108, high: 111.2, low: 107.5 }); // 27 reversal
  return bars;
}

test("REJECT when the nearest structural target cannot clear 2R", () => {
  const cs = candles(noTargetSweepBars());
  for (let n = 0; n < cs.length; n++) {
    assert.equal(detectNyReversalAt(cs, n), null);
  }
});

test("no setup when price never sweeps the prior session extreme", () => {
  const bars = shortSweepBars().slice(0, 24); // day 0
  // Day 1 ranges entirely below the prior session high — no sweep, no reversal.
  for (let i = 0; i < 6; i++) {
    bars.push({ open: 107, close: 107.5, high: 108.5, low: 106.5 });
  }
  const cs = candles(bars);
  for (let n = 0; n < cs.length; n++) {
    assert.equal(detectNyReversalAt(cs, n), null);
  }
});
