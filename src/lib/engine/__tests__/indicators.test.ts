import { test } from "node:test";
import assert from "node:assert/strict";
import { atr, ema, lastDefined, rsi, swingPoints } from "../indicators";
import { candles, fromCloses } from "./helpers";

const approx = (a: number | null, b: number, eps = 1e-6) => {
  assert.ok(a !== null, "expected a value, got null");
  assert.ok(Math.abs((a as number) - b) < eps, `${a} !~= ${b}`);
};

test("ema: null before period, SMA seed at period-1", () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  approx(out[2], 2); // SMA(1,2,3)
  // k = 2/4 = 0.5; ema3 = 4*0.5 + 2*0.5 = 3
  approx(out[3], 3);
  // ema4 = 5*0.5 + 3*0.5 = 4
  approx(out[4], 4);
});

test("ema: constant series equals the constant", () => {
  const out = ema(new Array(50).fill(7), 20);
  approx(lastDefined(out), 7);
});

test("atr: Wilder smoothing matches manual computation", () => {
  // Ranges chosen so TR is easy: each bar H-L = 2, no gaps.
  const cs = candles(
    Array.from({ length: 20 }, (_, i) => ({
      open: 100 + i,
      close: 100 + i,
      high: 101 + i,
      low: 99 + i,
    })),
  );
  const out = atr(cs, 14);
  // TR for i>=1: high-low = 2 (gap effects cancel since close==open==mid).
  // Actually TR = max(2, |high-prevClose|, |low-prevClose|).
  // prevClose = 100+(i-1); high=101+i => high-prevClose = 2; low-prevClose=0.
  // So TR = 2 for all. ATR converges to 2.
  approx(out[14], 2);
  approx(lastDefined(out), 2);
  assert.equal(out[13], null);
});

test("rsi: monotonic rise gives 100", () => {
  const out = rsi(Array.from({ length: 20 }, (_, i) => i + 1), 14);
  approx(out[14]!, 100);
});

test("rsi: monotonic fall gives 0", () => {
  const out = rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14);
  approx(out[14]!, 0);
});

test("rsi: alternating equal gains/losses ~ 50", () => {
  const seq: number[] = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {
    p += i % 2 === 0 ? 1 : -1;
    seq.push(p);
  }
  const out = rsi(seq, 14);
  const v = lastDefined(out)!;
  assert.ok(Math.abs(v - 50) < 5, `rsi ${v} not near 50`);
});

test("swingPoints: detects a clear pivot high and low with confirmedAt", () => {
  // index:   0   1   2(high) 3   4
  const cs = candles([
    { open: 10, close: 10, high: 11, low: 9 },
    { open: 11, close: 11, high: 12, low: 10 },
    { open: 13, close: 13, high: 15, low: 12 }, // pivot high at 2
    { open: 11, close: 11, high: 12, low: 10 },
    { open: 10, close: 10, high: 11, low: 9 },
  ]);
  const sw = swingPoints(cs, 2, 2);
  const high = sw.find((s) => s.type === "HIGH");
  assert.ok(high, "expected a swing high");
  assert.equal(high!.index, 2);
  assert.equal(high!.price, 15);
  assert.equal(high!.confirmedAt, 4); // 2 + rightBars(2)
});

test("swingPoints: pivot near the unconfirmed tail is excluded", () => {
  // A high at the last index can't be confirmed (no right bars).
  const cs = fromCloses([1, 2, 3, 4, 9]); // last bar is highest but at the edge
  const sw = swingPoints(cs, 2, 2);
  assert.ok(!sw.some((s) => s.index === 4), "tail pivot must not be confirmed");
});
