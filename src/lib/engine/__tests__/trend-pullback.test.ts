import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "@/lib/types";
import { detectTrendPullbackAt } from "../setups/trend-pullback";
import { bar, candles } from "./helpers";
import type { Bar } from "./helpers";

/**
 * A realistic uptrend that carves a distinct swing-high (overhead resistance),
 * then a pullback into the EMA band printing a confirmed swing low, then a
 * bullish resumption candle whose entry sits >= 2R below the resistance — so a
 * structural target exists. Extra future bars follow so we can prove they are
 * ignored.
 */
function uptrendWithPullback(): Candle[] {
  const bars: Bar[] = [];
  let price = 100;
  // ~196 bars of a steady uptrend so EMA20/50/200 are stacked under price.
  for (let i = 0; i < 196; i++) {
    const open = price;
    price += 0.6;
    const close = price;
    bars.push({ open, high: close + 0.2, low: open - 0.2, close });
  }
  // idx 196: a distinct peak (spike high) — the overhead resistance / target.
  bars.push({ open: 217.6, close: 219.1, high: 228, low: 217.4 });
  // idx 197-198: pullback with lower highs (confirms the peak as a swing high).
  bars.push({ open: 219.1, close: 214, high: 219.3, low: 213.5 });
  bars.push({ open: 214, close: 211, high: 214.2, low: 210.5 });
  // idx 199: the pullback bottom (lowest low) — into the EMA20/50 band.
  bars.push({ open: 211, close: 210, high: 211.2, low: 209.5 });
  // idx 200: higher-low recovery bar (confirms the swing low at idx 199).
  bars.push({ open: 210, close: 211.5, high: 211.8, low: 209.8 });
  // idx 201: bullish confirmation candle. Entry (~213) sits >= 2R below the
  // ~228 resistance, so a structural target exists.
  bars.push({ open: 211.5, close: 214, high: 214.5, low: 210.8 });
  price = 214;
  // Future bars — must never influence a detection made earlier.
  for (let i = 0; i < 12; i++) {
    const open = price;
    price += i % 2 === 0 ? 1.5 : -0.8;
    const close = price;
    bars.push({ open, high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close });
  }
  return candles(bars);
}

test("detectTrendPullbackAt: fires a valid LONG on a trend pullback", () => {
  const cs = uptrendWithPullback();
  const fired: number[] = [];
  for (let n = 0; n < cs.length; n++) {
    if (detectTrendPullbackAt(cs, n)) fired.push(n);
  }
  assert.ok(fired.length > 0, "expected at least one trend-pullback setup");

  const setup = detectTrendPullbackAt(cs, fired[0])!;
  assert.equal(setup.direction, "LONG");
  assert.equal(setup.symbol, "XAU/USD");
  assert.ok(setup.stopLoss < setup.entryZone.low, "stop must sit below entry");
  assert.ok(setup.target > setup.entryZone.high, "target must sit above entry");
  assert.ok(setup.riskReward >= 2, `riskReward ${setup.riskReward} must be >= 2`);
  assert.ok(setup.confidence > 0 && setup.confidence <= 1);
  assert.ok(setup.reasonCodes.includes("TREND_UP"));
});

test("NO LOOKAHEAD: detection at N is identical with or without future candles", () => {
  const full = uptrendWithPullback();
  // Find a firing index that has real future candles after it in `full`.
  let n = -1;
  for (let i = 0; i < full.length - 5; i++) {
    if (detectTrendPullbackAt(full, i)) {
      n = i;
      break;
    }
  }
  assert.ok(n >= 0, "needed a firing index with future candles after it");

  const resultWithFuture = detectTrendPullbackAt(full, n);
  const resultTruncated = detectTrendPullbackAt(full.slice(0, n + 1), n);
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
    detectTrendPullbackAt(tampered, n),
    resultTruncated,
    "fabricated future candles changed the result — lookahead leak!",
  );
});

test("HONEST CONFIDENCE: equals the weighted sum of the recorded checks", () => {
  const cs = uptrendWithPullback();
  let n = -1;
  for (let i = 0; i < cs.length; i++) {
    if (detectTrendPullbackAt(cs, i)) {
      n = i;
      break;
    }
  }
  const setup = detectTrendPullbackAt(cs, n)!;
  const checks = setup.rawFeatures.confidenceBreakdown as {
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
  // At least the trend check must have passed for any setup to exist.
  assert.ok(checks.find((c) => (c as any).name === "trendAligned")?.passed);
});

test("REJECT when structure offers no 2R target (no synthetic fallback)", () => {
  // Same trend + pullback + confirmation as the firing fixture, but the
  // confirmation candle closes ABOVE the only swing high — price is at fresh
  // highs, so there is no overhead resistance to target. The detector must
  // return null rather than manufacture a 2R target.
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 196; i++) {
    const open = price;
    price += 0.6;
    const close = price;
    bars.push({ open, high: close + 0.2, low: open - 0.2, close });
  }
  bars.push({ open: 217.6, close: 219.1, high: 220, low: 217.4 }); // peak high 220
  bars.push({ open: 219.1, close: 216, high: 219.3, low: 215.5 });
  bars.push({ open: 216, close: 214, high: 216.2, low: 213.5 });
  bars.push({ open: 214, close: 213, high: 214.2, low: 212.5 }); // shallow bottom
  bars.push({ open: 213, close: 214.5, high: 214.8, low: 212.8 });
  // Confirmation candle closes at 221 — above the 220 swing high (fresh highs).
  bars.push({ open: 214.5, close: 221, high: 221.5, low: 214.0 });
  const cs = candles(bars);

  // Sanity: the only swing high (220) is now below the entry (~221), so there
  // is genuinely no resistance above — and the detector rejects.
  for (let n = 0; n < cs.length; n++) {
    assert.equal(detectTrendPullbackAt(cs, n), null);
  }
});

test("no setup in a clean downtrend", () => {
  const bars: Bar[] = [];
  let price = 300;
  for (let i = 0; i < 220; i++) {
    const open = price;
    price -= 0.6;
    const close = price;
    bars.push({ open, high: open + 0.2, low: close - 0.2, close });
  }
  const cs = candles(bars);
  for (let n = 0; n < cs.length; n++) {
    assert.equal(detectTrendPullbackAt(cs, n), null);
  }
});
