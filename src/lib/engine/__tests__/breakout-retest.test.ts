import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@/lib/types";
import {
  detectBreakoutRetestAt,
  createBreakoutRetestScanner,
} from "../setups/breakout-retest";
import { computeFeaturesAt, precomputeFeatures } from "../features";
import { bar, candles } from "./helpers";
import type { Bar } from "./helpers";

/** Reflect a bar around price K: turns a LONG/up fixture into its SHORT mirror. */
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
 * A resistance at ~110 built from two swing highs, a clean breakout that runs
 * to a distinct ~130 swing high (the overhead target), then a deep pullback
 * that retests the broken 110 level from above and a bullish engulfing
 * confirmation that it now holds as support. Future bars follow so we can prove
 * they are ignored.
 */
function breakoutLongBars(): Bar[] {
  const bars: Bar[] = [
    // --- base: resistance ~110 (two swing highs), single swing low ~104.5 ---
    { open: 104, close: 106, high: 106.3, low: 103.7 }, // 0
    { open: 106, close: 108, high: 108.3, low: 105.7 }, // 1
    { open: 108, close: 110, high: 110.3, low: 107.7 }, // 2  peak1 ~110.3
    { open: 110, close: 108, high: 110.2, low: 107.5 }, // 3
    { open: 108, close: 106, high: 108.3, low: 105.5 }, // 4
    { open: 106, close: 105, high: 106.3, low: 104.5 }, // 5  swing low ~104.5
    { open: 105, close: 107, high: 107.3, low: 104.7 }, // 6
    { open: 107, close: 110, high: 110.4, low: 106.7 }, // 7  peak2 ~110.4
    { open: 110, close: 108, high: 110.2, low: 107.5 }, // 8
    { open: 108, close: 106, high: 108.3, low: 105.5 }, // 9
    { open: 106, close: 107, high: 107.3, low: 105.5 }, // 10
    { open: 107, close: 108, high: 108.3, low: 106.5 }, // 11
    // --- impulse breakout up to ~130 (monotonic; only 130.5 is a swing high) ---
    { open: 108, close: 113, high: 113.3, low: 107.7 }, // 12  fresh breakout
    { open: 113, close: 118, high: 118.3, low: 112.7 }, // 13
    { open: 118, close: 123, high: 123.3, low: 117.7 }, // 14
    { open: 123, close: 128, high: 128.3, low: 122.7 }, // 15
    { open: 128, close: 130, high: 130.5, low: 127.7 }, // 16  swing high ~130.5 (target)
    // --- pullback: retest the broken 110 level from above (closes stay > 110) ---
    { open: 130, close: 124, high: 130.2, low: 123.5 }, // 17
    { open: 124, close: 119, high: 124.2, low: 118.5 }, // 18
    { open: 119, close: 114, high: 119.2, low: 113.5 }, // 19
    { open: 113, close: 111.5, high: 113.2, low: 110.5 }, // 20  approaching level
    { open: 111, close: 113.5, high: 113.8, low: 110.3 }, // 21  bullish engulfing confirm
  ];
  // Future bars — must never influence a detection made at bar 21.
  let price = 113.5;
  for (let i = 0; i < 12; i++) {
    const open = price;
    price += i % 2 === 0 ? 1.6 : -0.9;
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
    if (detectBreakoutRetestAt(cs, n)) return n;
  }
  return -1;
}

test("detectBreakoutRetestAt: fires a valid LONG on a broken-resistance retest", () => {
  const cs = candles(breakoutLongBars());
  const n = firstFiring(cs);
  assert.ok(n >= 0, "expected at least one breakout-retest setup");

  const setup = detectBreakoutRetestAt(cs, n)!;
  assert.equal(setup.direction, "LONG");
  assert.equal(setup.symbol, "XAU/USD");
  assert.ok(setup.stopLoss < setup.entryZone.low, "stop must sit below entry");
  assert.ok(setup.target > setup.entryZone.high, "target must sit above entry");
  assert.ok(setup.riskReward >= 2, `riskReward ${setup.riskReward} must be >= 2`);
  assert.ok(setup.confidence > 0 && setup.confidence <= 1);
  assert.ok(setup.reasonCodes.includes("BREAKOUT_UP"));
  assert.ok(setup.reasonCodes.includes("RETEST_HOLD"));

  // ATR stop-distance floor: 1R is never tighter than 1xATR.
  const f = computeFeaturesAt(cs, n)!;
  const entry = setup.rawFeatures.entry as number;
  assert.ok(
    entry - setup.stopLoss >= f.atr14! - 1e-9,
    `1R (${entry - setup.stopLoss}) must be >= 1xATR (${f.atr14})`,
  );
});

test("detectBreakoutRetestAt: fires a valid SHORT on a broken-support retest (mirror)", () => {
  const cs = candles(breakoutLongBars().map(reflect));
  const n = firstFiring(cs);
  assert.ok(n >= 0, "expected at least one mirrored breakout-retest setup");

  const setup = detectBreakoutRetestAt(cs, n)!;
  assert.equal(setup.direction, "SHORT");
  assert.ok(setup.stopLoss > setup.entryZone.high, "stop must sit above entry");
  assert.ok(setup.target < setup.entryZone.low, "target must sit below entry");
  assert.ok(setup.riskReward >= 2, `riskReward ${setup.riskReward} must be >= 2`);
  assert.ok(setup.reasonCodes.includes("BREAKOUT_DOWN"));
  assert.ok(setup.reasonCodes.includes("RETEST_HOLD"));
});

test("NO LOOKAHEAD: detection at N is identical with or without future candles", () => {
  const full = candles(breakoutLongBars());
  let n = -1;
  for (let i = 0; i < full.length - 5; i++) {
    if (detectBreakoutRetestAt(full, i)) {
      n = i;
      break;
    }
  }
  assert.ok(n >= 0, "needed a firing index with future candles after it");

  const resultWithFuture = detectBreakoutRetestAt(full, n);
  const resultTruncated = detectBreakoutRetestAt(full.slice(0, n + 1), n);
  assert.deepEqual(
    resultWithFuture,
    resultTruncated,
    "future candles changed the result — lookahead leak!",
  );

  // Stronger: append wildly different fabricated futures and re-check.
  const crazyFuture = candles([
    bar(9999, 10000, 10001, 9998),
    bar(1, 0.5, 2, 0.1),
    bar(500, 600, 650, 450),
  ]);
  const tampered = [...full.slice(0, n + 1), ...crazyFuture];
  assert.deepEqual(
    detectBreakoutRetestAt(tampered, n),
    resultTruncated,
    "fabricated future candles changed the result — lookahead leak!",
  );
});

test("HONEST CONFIDENCE: equals the weighted sum of the recorded checks", () => {
  const cs = candles(breakoutLongBars());
  const n = firstFiring(cs);
  const setup = detectBreakoutRetestAt(cs, n)!;
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
  // The defining gates must have passed for any setup to exist.
  assert.ok(checks.find((c) => c.name === "breakoutConfirmed")?.passed);
  assert.ok(checks.find((c) => c.name === "retestHold")?.passed);
});

/**
 * Same break + retest, but the confirmation candle closes right on top of the
 * retest low, so the raw structural stop is microscopic. The ATR floor must
 * widen it to a sane 1R.
 */
function tightStopBreakoutBars(): Bar[] {
  const bars = breakoutLongBars().slice(0, 21);
  // Replace the confirmation bar with one closing barely above the level, with
  // a low equal to the retest low — a noise-tight structural stop.
  bars[20] = { open: 111, close: 110.6, high: 111.0, low: 110.4 }; // 20
  bars.push({ open: 110.5, close: 110.7, high: 110.9, low: 110.45 }); // 21 confirm near level
  return bars;
}

test("ATR floor: a noise-tight retest stop is widened to a sane 1R", () => {
  const cs = candles(tightStopBreakoutBars());
  const n = cs.length - 1;
  const f = computeFeaturesAt(cs, n)!;
  const setup = detectBreakoutRetestAt(cs, n);
  assert.ok(setup, "fixture should fire a breakout-retest setup");

  const entry = setup!.rawFeatures.entry as number;
  const structuralStop = setup!.rawFeatures.structuralStop as number;
  const rawRisk = entry - structuralStop;
  assert.ok(
    rawRisk < f.atr14! * 0.5,
    `raw structural risk ${rawRisk} should be well under 0.5xATR (${f.atr14})`,
  );

  assert.equal(setup!.rawFeatures.stopAtrFloored, true);
  const risk = entry - setup!.stopLoss;
  assert.ok(
    Math.abs(risk - f.atr14!) < 1e-9,
    `1R (${risk}) should equal 1xATR (${f.atr14})`,
  );
});

/**
 * A clean breakout + retest where, after reclaiming the level, price is at
 * fresh highs — there is no overhead resistance to target. The detector must
 * return null rather than manufacture a 2R target.
 */
function noTargetBreakoutBars(): Bar[] {
  const bars = breakoutLongBars().slice(0, 12); // base + resistance ~110 only
  // Modest breakout to ~112 with no higher structure above, then retest + hold.
  bars.push({ open: 108, close: 111.5, high: 111.7, low: 107.7 }); // 12 breakout
  bars.push({ open: 111.5, close: 110.8, high: 111.6, low: 110.3 }); // 13 retest
  bars.push({ open: 110.8, close: 112.0, high: 112.3, low: 110.5 }); // 14 confirm @ fresh highs
  return bars;
}

test("REJECT when structure offers no 2R target (no synthetic fallback)", () => {
  const cs = candles(noTargetBreakoutBars());
  for (let n = 0; n < cs.length; n++) {
    assert.equal(detectBreakoutRetestAt(cs, n), null);
  }
});

/**
 * A long, structurally rich series (deterministic — no Math.random) that cycles
 * through up/down drifts with noise, manufacturing many swing highs and lows,
 * breakouts in both directions, pullbacks, and near-duplicate levels. It grows a
 * large confirmed-swing list so the candidate set is long — exactly the regime
 * where the full scan goes quadratic and the incremental scanner must still
 * agree at every bar (long candidate lists, dedup, and the window stop bound).
 */
function richSeries(): Candle[] {
  const bars: Bar[] = [];
  let seed = 123456789; // fixed seed → deterministic series.
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let price = 100;
  const drifts = [0.4, -0.3, 0.6, -0.5, 0.2, -0.25, 0.55, -0.6, 0.3, -0.15];
  for (const drift of drifts) {
    for (let i = 0; i < 45; i++) {
      const open = price;
      price = Math.max(5, price + drift + (rng() - 0.5) * 3);
      const close = price;
      bars.push({
        open,
        close,
        high: Math.max(open, close) + rng() * 1.5,
        low: Math.min(open, close) - rng() * 1.5,
      });
    }
  }
  return candles(bars);
}

test("INCREMENTAL SCANNER: bit-identical to the full-scan detector at every bar", () => {
  const series = [
    richSeries(),
    candles(breakoutLongBars()),
    candles(breakoutLongBars().map(reflect)),
  ];
  let totalFired = 0;
  for (const cs of series) {
    // Feed BOTH the scanner and the oracle the SAME precomputed feature[n] (the
    // real backtest path), so the only thing that can differ is HOW candidates
    // are enumerated — which is precisely what the scanner changes.
    const feats = precomputeFeatures(cs);
    const scanner = createBreakoutRetestScanner();
    for (let n = 0; n < cs.length; n++) {
      const incremental = scanner.detectAt(cs, n, feats[n]);
      const fullScan = detectBreakoutRetestAt(cs, n, {}, feats[n]);
      assert.deepEqual(
        incremental,
        fullScan,
        `incremental scanner diverged from full scan at bar ${n}`,
      );
      if (fullScan) totalFired++;
    }
  }
  // Guard against a hollow null===null equivalence: the fixtures must fire, so
  // firing-path equivalence (the interesting case) is actually exercised.
  assert.ok(totalFired > 0, "expected the scanner to reproduce real firings");
});

test("no setup in a clean trend with no broken level + retest", () => {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 60; i++) {
    const open = price;
    price += 0.5;
    bars.push({ open, close: price, high: price + 0.2, low: open - 0.2 });
  }
  const cs = candles(bars);
  for (let n = 0; n < cs.length; n++) {
    assert.equal(detectBreakoutRetestAt(cs, n), null);
  }
});
