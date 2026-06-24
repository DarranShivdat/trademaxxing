import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFeaturesAt } from "../features";
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
