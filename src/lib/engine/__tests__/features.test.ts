import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFeaturesAt, precomputeFeatures } from "../features";
import { bar, candles } from "./helpers";

test("computeFeaturesAt: out-of-range index returns null", () => {
  const cs = candles([bar(1, 2)]);
  assert.equal(computeFeaturesAt(cs, -1), null);
  assert.equal(computeFeaturesAt(cs, 5), null);
});

test("bullish engulfing detected", () => {
  const cs = candles([
    bar(10, 9), // bearish
    { open: 8.8, close: 10.2, high: 10.3, low: 8.7 }, // engulfs prior body
  ]);
  const f = computeFeaturesAt(cs, 1)!;
  assert.ok(f.patterns.includes("BULLISH_ENGULFING"));
});

test("inside bar detected", () => {
  const cs = candles([
    { open: 10, close: 11, high: 12, low: 8 },
    { open: 10.2, close: 10.5, high: 11, low: 9 }, // contained
  ]);
  const f = computeFeaturesAt(cs, 1)!;
  assert.ok(f.patterns.includes("INSIDE_BAR"));
});

test("bullish rejection (long lower wick) detected", () => {
  const cs = candles([
    { open: 10, close: 10.1, high: 10.2, low: 8.0 }, // tiny body, long lower wick
  ]);
  const f = computeFeaturesAt(cs, 0)!;
  assert.ok(f.patterns.includes("BULLISH_REJECTION"));
});

test("prev session high/low uses the prior UTC day", () => {
  // 24 hourly bars on day 1 (high up to 30), then day 2 bars.
  const day1 = Array.from({ length: 24 }, (_, i) => ({
    open: 10 + i,
    close: 10 + i,
    high: 11 + i, // max high on day1 = 11+23 = 34
    low: 9 + i, // min low on day1 = 9
  }));
  const day2 = [bar(40, 41)];
  const cs = candles([...day1, ...day2]);
  const f = computeFeaturesAt(cs, cs.length - 1)!;
  assert.equal(f.prevSessionHigh, 34);
  assert.equal(f.prevSessionLow, 9);
});

test("break of structure: close above last swing high is bullish BOS", () => {
  // Build a pivot high then break above it.
  const cs = candles([
    bar(10, 10, 11, 9),
    bar(10, 10, 11, 9),
    bar(13, 13, 15, 12), // pivot high 15 at idx 2
    bar(11, 11, 12, 10),
    bar(11, 11, 12, 10), // confirms pivot (idx 4)
    bar(15, 16, 16.5, 14), // closes above 15 -> bullish BOS
  ]);
  const f = computeFeaturesAt(cs, 5)!;
  assert.equal(f.lastSwingHigh, 15);
  assert.ok(f.breakOfStructure.bullish);
  assert.equal(f.breakOfStructure.brokenLevel, 15);
});

// ---------------------------------------------------------------------------
// PRECOMPUTE EQUIVALENCE — the optimization's correctness contract.
//
// The backtester reads precomputeFeatures(candles)[n] instead of recomputing
// computeFeaturesAt(candles, n) per bar. That is only sound if the two are
// IDENTICAL at every n. If a "precompute then index in" ever leaked future
// data (a swing confirmed by later bars, a zone built from future touches, a
// prevSession peeking at a day still in progress), this deep-equal would catch
// it. A divergence at ANY bar fails the test — the optimization is wrong.
// ---------------------------------------------------------------------------

/**
 * A long, lumpy multi-day series: a base drift with periodic spikes/dips so it
 * produces real swing pivots, S/R zones, BOS, and patterns; >200 bars so EMA200
 * is defined; 1h bars so it crosses many UTC-day boundaries (exercises
 * prevSession rollover). Deterministic — no randomness.
 */
function lumpyMultiDay(len: number) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < len; i++) {
    const open = price;
    // Gentle trend with an oscillation plus a sharper move every few bars to
    // carve out local highs/lows that confirm as swings.
    const drift = 0.15;
    const wobble = Math.sin(i / 3) * 1.2;
    const spike = i % 7 === 0 ? 2.5 : i % 11 === 0 ? -2.2 : 0;
    price = open + drift + wobble + spike;
    const close = price;
    const high = Math.max(open, close) + 0.4 + (i % 5 === 0 ? 0.8 : 0);
    const low = Math.min(open, close) - 0.4 - (i % 6 === 0 ? 0.7 : 0);
    bars.push({ open, high, low, close });
  }
  return candles(bars);
}

test("PRECOMPUTE EQUIVALENCE: precomputeFeatures[n] deep-equals computeFeaturesAt(candles, n) for every n", () => {
  const cs = lumpyMultiDay(260);
  const pre = precomputeFeatures(cs);

  assert.equal(pre.length, cs.length);
  // Spot-check the fixture actually exercises the interesting paths, so the
  // equivalence isn't vacuously over null/empty features.
  const last = pre[cs.length - 1]!;
  assert.ok(last.ema200 !== null, "fixture should be long enough for EMA200");
  assert.ok(last.swings.length > 0, "fixture should produce swings");
  assert.ok(
    last.resistanceZones.length > 0 || last.supportZones.length > 0,
    "fixture should produce S/R zones",
  );
  assert.ok(last.prevSessionHigh !== null, "fixture should span >1 UTC day");

  for (let n = 0; n < cs.length; n++) {
    assert.deepEqual(
      pre[n],
      computeFeaturesAt(cs, n),
      `precomputed feature[${n}] differs from computeFeaturesAt — lookahead/leak or drift`,
    );
  }
});

test("PRECOMPUTE EQUIVALENCE: holds under non-default feature options", () => {
  const cs = lumpyMultiDay(220);
  const opts = { swingLeft: 3, swingRight: 3, zoneLookback: 6, zoneAtrMult: 0.75 };
  const pre = precomputeFeatures(cs, opts);
  for (let n = 0; n < cs.length; n++) {
    assert.deepEqual(
      pre[n],
      computeFeaturesAt(cs, n, opts),
      `precomputed feature[${n}] differs under custom options at n=${n}`,
    );
  }
});

test("precomputeFeatures: empty input yields empty array", () => {
  assert.deepEqual(precomputeFeatures([]), []);
});
