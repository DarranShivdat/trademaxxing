import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bar } from "@/lib/engine/__tests__/helpers";
import { bar, candles } from "@/lib/engine/__tests__/helpers";
import type { Candle, Setup } from "@/lib/types";
import { detectTrendPullbackAt } from "@/lib/engine/setups/trend-pullback";
import { runBacktest, simulateTrade, type BacktestTrade } from "../run";
import { computeBacktestStats, profitFactorR } from "../metrics";

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

test("STREAMING EQUIVALENCE: streamed-feature backtest is bit-identical to fresh per-bar detection", () => {
  // The backtester streams feature[n] (computed incrementally, one live at a
  // time) and feeds it to the detector. This must produce EXACTLY the result a
  // detector that ignores the fed feature and recomputes computeFeaturesAt per
  // bar would — i.e. streaming changed memory, not numbers. A divergence here
  // (a desynced index, a leaked/stale feature) fails the bit-identical contract.
  const full = uptrendWithPullback();

  const streamed = runBacktest(full); // default detector: uses the streamed feature
  const fresh = runBacktest(full, {
    // feature=undefined forces detectTrendPullbackAt to compute fresh from
    // candles[0..n], the independent ground truth.
    detect: (c, n) => detectTrendPullbackAt(c, n),
  });

  assert.ok(streamed.trades.length > 0, "fixture should produce trades");
  assert.deepEqual(
    streamed,
    fresh,
    "streamed-feature backtest diverged from fresh per-bar detection — not bit-identical",
  );
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

// ---------------------------------------------------------------------------
// METRICS — hand-built regression cases over known R sequences.
//
// These pin expectancy / win rate / avg R / profitFactorR to values computed
// by hand, independent of the detector, so the formulas can't silently drift.
// Trades are constructed directly with a known R; price fields are filled so
// the price-derived path (computeStats: pnl = exitPrice−entry over risk) yields
// the SAME R as the R-field path, proving the two agree.
// ---------------------------------------------------------------------------

let trSeq = 0;
/** Resolved trade with a chosen R (win: +rr, loss: −1). risk = 10, entry = 100. */
function rTrade(r: number): BacktestTrade {
  trSeq += 1;
  const entry = 100;
  const risk = 10;
  const stopLoss = entry - risk;
  const isWin = r > 0;
  return {
    direction: "LONG",
    entryIndex: trSeq,
    entryTime: new Date(2026, 0, 1, trSeq),
    exitIndex: trSeq + 1,
    exitTime: new Date(2026, 0, 1, trSeq + 1),
    entry,
    stopLoss,
    target: entry + Math.abs(r) * risk,
    riskReward: Math.abs(r),
    outcome: isWin ? "WIN" : "LOSS",
    exitPrice: isWin ? entry + r * risk : stopLoss,
    r: isWin ? r : -1,
    confidence: 0.7,
    ambiguousBar: false,
  };
}

/**
 * SHORT counterpart of `rTrade`: stop ABOVE entry, target BELOW. A win exits at
 * the target (below entry), a loss at the stop (above entry) — so the price-pnl
 * path (entry−exit for a short) must still resolve to +rr / −1. risk = 10.
 */
function rTradeShort(r: number): BacktestTrade {
  trSeq += 1;
  const entry = 100;
  const risk = 10;
  const stopLoss = entry + risk; // above entry for a short
  const isWin = r > 0;
  return {
    direction: "SHORT",
    entryIndex: trSeq,
    entryTime: new Date(2026, 0, 1, trSeq),
    exitIndex: trSeq + 1,
    exitTime: new Date(2026, 0, 1, trSeq + 1),
    entry,
    stopLoss,
    target: entry - Math.abs(r) * risk, // below entry for a short
    riskReward: Math.abs(r),
    outcome: isWin ? "WIN" : "LOSS",
    exitPrice: isWin ? entry - r * risk : stopLoss,
    r: isWin ? r : -1,
    confidence: 0.7,
    ambiguousBar: false,
  };
}
/** Unresolved (open) trade — must be excluded from every resolved metric. */
function openTrade(): BacktestTrade {
  trSeq += 1;
  return {
    direction: "LONG",
    entryIndex: trSeq,
    entryTime: new Date(2026, 0, 1, trSeq),
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

test("HIGH WIN RATE EDGE: 8W(+2R)/2L(-1R) → expectancy 1.4, profitFactorR 8", () => {
  // The flagged case. Hand math:
  //   winRate .8, avgWinR 2, avgLossR -1
  //   expectancy = .8*2 + .2*(-1) = 1.4 ; avgR = (16-2)/10 = 1.4
  //   profitFactorR = (8*2)/(2*1) = 8  — large but CORRECT, not inflated.
  const trades = [
    ...Array.from({ length: 8 }, () => rTrade(2)),
    ...Array.from({ length: 2 }, () => rTrade(-1)),
  ];
  const s = computeBacktestStats(trades);
  assert.equal(s.winRate, 0.8);
  assert.equal(s.avgWinR, 2);
  assert.equal(s.avgLossR, -1);
  assert.ok(Math.abs(s.expectancy - 1.4) < 1e-9);
  assert.ok(Math.abs(s.avgR - 1.4) < 1e-9);
  assert.ok(Math.abs(s.expectancy - s.avgR) < 1e-9);
  assert.equal(profitFactorR(trades), 8);
});

test("MIXED riskReward: expectancy decomposition still equals avg R", () => {
  // wins +3,+3,+1 ; losses -1,-1 (n=5)
  //   avgWinR = 7/3, avgLossR = -1, winRate .6
  //   expectancy = .6*(7/3) + .4*(-1) = 1.0 ; avgR = (7-2)/5 = 1.0
  //   profitFactorR = 7/2 = 3.5
  const trades = [rTrade(3), rTrade(3), rTrade(1), rTrade(-1), rTrade(-1)];
  const s = computeBacktestStats(trades);
  assert.ok(Math.abs(s.avgWinR - 7 / 3) < 1e-9);
  assert.equal(s.avgLossR, -1);
  assert.equal(s.winRate, 0.6);
  assert.ok(Math.abs(s.expectancy - 1.0) < 1e-9);
  assert.ok(Math.abs(s.avgR - 1.0) < 1e-9);
  assert.ok(Math.abs(s.expectancy - s.avgR) < 1e-9);
  assert.equal(profitFactorR(trades), 3.5);
});

test("ALL WINS: expectancy = avgWinR, profitFactorR = Infinity (no losing R)", () => {
  const trades = [rTrade(2), rTrade(2), rTrade(2)];
  const s = computeBacktestStats(trades);
  assert.equal(s.winRate, 1);
  assert.equal(s.expectancy, 2);
  assert.equal(s.avgLossR, 0);
  assert.equal(profitFactorR(trades), Infinity);
});

test("OPEN trades are excluded from resolved metrics and profitFactorR", () => {
  const trades = [rTrade(2), rTrade(-1), openTrade(), openTrade()];
  const s = computeBacktestStats(trades);
  assert.equal(s.closedTrades, 2);
  assert.equal(s.openUnresolved, 2);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.expectancy, 0.5);
  assert.equal(profitFactorR(trades), 2); // opens don't touch gross win/loss
});

test("EMPTY / all-open: zeros not NaN; profitFactorR([]) = 0", () => {
  const s = computeBacktestStats([openTrade(), openTrade()]);
  assert.equal(s.winRate, 0);
  assert.equal(s.expectancy, 0);
  assert.equal(s.avgR, 0);
  assert.equal(profitFactorR([]), 0);
});

// ---------------------------------------------------------------------------
// SHORT DIRECTION — the bug class that made breakout-retest / ny-reversal
// (both trade SHORT) report contradictory metrics while trend-pullback
// (LONG-only) stayed self-consistent. Two independent direction-blind bugs:
//   1. simulateTrade hardcoded LONG stop/target geometry, so every short
//      resolved as an instant ambiguous LOSS (r = -1).
//   2. toPaperTrade booked pnl = exit-entry, so a short stopped out ABOVE entry
//      counted as a WIN in the price-pnl path (win rate / avg R columns).
// The two paths inverted shorts in OPPOSITE directions, leaving avgR ≈ -expect.
// ---------------------------------------------------------------------------

test("SHORT simulateTrade: target BELOW entry is a WIN (+riskReward)", () => {
  // Short at 100, stop 105 (above), target 90 (below), rr 2. Price falls into
  // the target without ever trading up through the stop.
  const setup = fakeSetup({ direction: "SHORT", stopLoss: 105, target: 90 });
  const series = candles([
    { open: 100, high: 100, low: 100, close: 100 }, // entry bar
    { open: 99, high: 100, low: 95, close: 96 }, // drifting down, no touch
    { open: 96, high: 97, low: 89, close: 90 }, // low 89 <= target 90 → WIN
  ]);
  const trade = simulateTrade(series, 0, setup);
  assert.equal(trade.outcome, "WIN");
  assert.equal(trade.exitPrice, 90);
  assert.equal(trade.r, 2);
  assert.equal(trade.ambiguousBar, false);
});

test("SHORT simulateTrade: stop ABOVE entry is a LOSS (-1)", () => {
  const setup = fakeSetup({ direction: "SHORT", stopLoss: 105, target: 90 });
  const series = candles([
    { open: 100, high: 100, low: 100, close: 100 }, // entry bar
    { open: 101, high: 106, low: 100, close: 104 }, // high 106 >= stop 105 → LOSS
  ]);
  const trade = simulateTrade(series, 0, setup);
  assert.equal(trade.outcome, "LOSS");
  assert.equal(trade.exitPrice, 105);
  assert.equal(trade.r, -1);
});

test("METRIC INVARIANT: reported win rate + avg win/loss must imply expectancy (shorts)", () => {
  // A short-heavy pool with a known R distribution: 7 wins (+2R), 3 losses (-1R).
  //   winRate 0.7, avgWinR 2, avgLossR -1
  //   expectancy = 0.7*2 + 0.3*(-1) = 1.1 ; avgR = (14-3)/10 = 1.1
  // Pre-fix this pool reported a flipped win rate (shorts stopped out scored as
  // wins) and an expectancy of the OPPOSITE sign to avgR — exactly the bug.
  const trades = [
    ...Array.from({ length: 7 }, () => rTradeShort(2)),
    ...Array.from({ length: 3 }, () => rTradeShort(-1)),
  ];
  const s = computeBacktestStats(trades);

  // The reported win rate / avg win / avg loss must reconstruct the reported
  // expectancy. This is the contradiction guard: any path that flips a short's
  // sign breaks one side of this equality.
  const implied = s.winRate * s.avgWinR + (1 - s.winRate) * s.avgLossR;
  assert.ok(
    Math.abs(implied - s.expectancy) < 1e-9,
    `winRate ${s.winRate} · avgWinR ${s.avgWinR} + lossRate · avgLossR ${s.avgLossR} ` +
      `= ${implied} but expectancy = ${s.expectancy}`,
  );
  // AvgR (price-pnl path) and Expect (R-field path) must agree, as they do for
  // LONG-only trend-pullback. For shorts the two paths previously negated.
  assert.ok(
    Math.abs(s.avgR - s.expectancy) < 1e-9,
    `avgR ${s.avgR} != expectancy ${s.expectancy} (paths disagree on shorts)`,
  );
  // And the concrete hand values.
  assert.equal(s.winRate, 0.7);
  assert.equal(s.avgWinR, 2);
  assert.equal(s.avgLossR, -1);
  assert.ok(Math.abs(s.expectancy - 1.1) < 1e-9);
  assert.equal(profitFactorR(trades), (7 * 2) / 3);
});

test("METRIC INVARIANT holds for a mixed LONG+SHORT pool", () => {
  // 2 long wins (+2), 1 long loss (-1), 2 short wins (+2), 3 short losses (-1).
  //   wins 4 @ +2, losses 4 @ -1, n=8 → winRate .5, expectancy .5, avgR .5
  const trades = [
    rTrade(2),
    rTrade(2),
    rTrade(-1),
    rTradeShort(2),
    rTradeShort(2),
    rTradeShort(-1),
    rTradeShort(-1),
    rTradeShort(-1),
  ];
  const s = computeBacktestStats(trades);
  const implied = s.winRate * s.avgWinR + (1 - s.winRate) * s.avgLossR;
  assert.ok(Math.abs(implied - s.expectancy) < 1e-9);
  assert.ok(Math.abs(s.avgR - s.expectancy) < 1e-9);
  assert.equal(s.winRate, 0.5);
  assert.ok(Math.abs(s.expectancy - 0.5) < 1e-9);
});
