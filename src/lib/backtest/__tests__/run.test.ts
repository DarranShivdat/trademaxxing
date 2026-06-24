import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bar } from "@/lib/engine/__tests__/helpers";
import { bar, candles } from "@/lib/engine/__tests__/helpers";
import type { Candle, Setup } from "@/lib/types";
import { detectTrendPullbackAt } from "@/lib/engine/setups/trend-pullback";
import { runBacktest, simulateTrade } from "../run";
import { computeBacktestStats } from "../metrics";

/**
 * Same fixture as the engine's trend-pullback test: a steady uptrend, a swing
 * high (overhead resistance), a pullback into the EMA band, then a bullish
 * confirmation bar that fires the setup — followed by future bars we can use to
 * prove detection never peeks ahead.
 */
function uptrendWithPullback(): Candle[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 196; i++) {
    const open = price;
    price += 0.6;
    const close = price;
    bars.push({ open, high: close + 0.2, low: open - 0.2, close });
  }
  bars.push({ open: 217.6, close: 219.1, high: 228, low: 217.4 });
  bars.push({ open: 219.1, close: 214, high: 219.3, low: 213.5 });
  bars.push({ open: 214, close: 211, high: 214.2, low: 210.5 });
  bars.push({ open: 211, close: 210, high: 211.2, low: 209.5 });
  bars.push({ open: 210, close: 211.5, high: 211.8, low: 209.8 });
  bars.push({ open: 211.5, close: 214, high: 214.5, low: 210.8 });
  price = 214;
  for (let i = 0; i < 12; i++) {
    const open = price;
    price += i % 2 === 0 ? 1.5 : -0.8;
    const close = price;
    bars.push({
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
    });
  }
  return candles(bars);
}

/** Minimal hand-built LONG setup for direct simulateTrade tests. */
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

// ---------------------------------------------------------------------------
// NO LOOKAHEAD — the central correctness guarantee.
// ---------------------------------------------------------------------------

test("NO LOOKAHEAD: backtest detection equals live detection at the same index", () => {
  const full = uptrendWithPullback();
  const result = runBacktest(full);

  assert.ok(result.trades.length > 0, "expected the fixture to produce a trade");

  // Every entry the backtest took must be a bar where the engine — given only
  // [0..N] — emits the IDENTICAL setup. Appending the real future, or wildly
  // fabricated future bars, must not change the verdict at N.
  for (const t of result.trades) {
    const n = t.entryIndex;
    const live = detectTrendPullbackAt(full.slice(0, n + 1), n);
    assert.ok(live, `engine should fire at backtest entry index ${n}`);

    assert.deepEqual(
      detectTrendPullbackAt(full, n),
      live,
      `future candles changed detection at ${n} — lookahead leak!`,
    );

    const tampered = [
      ...full.slice(0, n + 1),
      ...candles([bar(9999, 10000, 10001, 9998), bar(1, 0.5, 2, 0.1)]),
    ];
    assert.deepEqual(
      detectTrendPullbackAt(tampered, n),
      live,
      `fabricated future candles changed detection at ${n} — lookahead leak!`,
    );
  }
});

test("backtest fires at the same index the engine does standalone", () => {
  const full = uptrendWithPullback();
  // First index the engine fires at standalone.
  let firstFire = -1;
  for (let i = 0; i < full.length; i++) {
    if (detectTrendPullbackAt(full, i)) {
      firstFire = i;
      break;
    }
  }
  assert.ok(firstFire >= 0);
  const result = runBacktest(full);
  assert.equal(result.trades[0].entryIndex, firstFire);
});

// ---------------------------------------------------------------------------
// INTRABAR STOP-vs-TARGET RESOLUTION.
// ---------------------------------------------------------------------------

test("simulateTrade: target hit alone → WIN at +riskReward R", () => {
  // entry bar close = 100; next bar reaches target 110 but not stop 95.
  const cs = candles([bar(100, 100, 100, 100), bar(100, 109, 111, 96)]);
  const t = simulateTrade(cs, 0, fakeSetup());
  assert.equal(t.outcome, "WIN");
  assert.equal(t.exitPrice, 110);
  assert.equal(t.r, 2);
  assert.equal(t.exitIndex, 1);
  assert.equal(t.ambiguousBar, false);
});

test("simulateTrade: stop hit alone → LOSS at -1R", () => {
  const cs = candles([bar(100, 100, 100, 100), bar(100, 96, 101, 94)]);
  const t = simulateTrade(cs, 0, fakeSetup());
  assert.equal(t.outcome, "LOSS");
  assert.equal(t.exitPrice, 95);
  assert.equal(t.r, -1);
});

test("simulateTrade: candle spanning BOTH resolves STOP-first (conservative)", () => {
  // This bar's range [90,115] contains both stop 95 and target 110.
  const cs = candles([bar(100, 100, 100, 100), bar(100, 112, 115, 90)]);
  const t = simulateTrade(cs, 0, fakeSetup());
  assert.equal(t.outcome, "LOSS", "ambiguous bar must resolve as a loss");
  assert.equal(t.r, -1);
  assert.equal(t.ambiguousBar, true);
});

test("simulateTrade: resolves on the FIRST touching bar, not a later one", () => {
  const cs = candles([
    bar(100, 100, 100, 100), // entry
    bar(100, 101, 102, 97), // neutral — neither hit
    bar(101, 96, 102, 94), // stop hit here
    bar(96, 111, 112, 95), // a later target — must be ignored
  ]);
  const t = simulateTrade(cs, 0, fakeSetup());
  assert.equal(t.outcome, "LOSS");
  assert.equal(t.exitIndex, 2);
});

test("simulateTrade: never touched → OPEN/unresolved, excluded from R", () => {
  const cs = candles([
    bar(100, 100, 100, 100),
    bar(100, 101, 103, 97),
    bar(101, 100, 104, 96),
  ]);
  const t = simulateTrade(cs, 0, fakeSetup());
  assert.equal(t.outcome, "OPEN");
  assert.equal(t.r, null);
  assert.equal(t.exitIndex, undefined);
});

// ---------------------------------------------------------------------------
// METRICS.
// ---------------------------------------------------------------------------

test("computeBacktestStats: win rate, avg R, profit factor, expectancy", () => {
  const full = uptrendWithPullback();
  const result = runBacktest(full);
  const stats = computeBacktestStats(result.trades);

  // Resolved-trade count is reported and consistent.
  const resolved = result.trades.filter((t) => t.outcome !== "OPEN");
  assert.equal(stats.closedTrades, resolved.length);
  assert.equal(stats.wins + stats.losses, resolved.length);
  if (resolved.length > 0) {
    assert.ok(stats.winRate >= 0 && stats.winRate <= 1);
    // Expectancy is the decomposed form of avg R; they must agree.
    assert.ok(Math.abs(stats.expectancy - stats.avgR) < 1e-9);
  }
});

test("computeBacktestStats: synthetic 1W/1L gives winRate .5, expectancy .5R", () => {
  // Two resolved trades with riskReward 2: one win (+2R), one loss (-1R).
  const win = simulateTrade(
    candles([bar(100, 100, 100, 100), bar(100, 110, 111, 99)]),
    0,
    fakeSetup(),
  );
  const loss = simulateTrade(
    candles([bar(100, 100, 100, 100), bar(100, 95, 99, 94)]),
    0,
    fakeSetup(),
  );
  const stats = computeBacktestStats([win, loss]);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.avgWinR, 2);
  assert.equal(stats.avgLossR, -1);
  assert.equal(stats.expectancy, 0.5);
  assert.equal(stats.profitFactor, 2); // grossProfit 2 / grossLoss 1
  assert.equal(stats.avgR, 0.5);
});
