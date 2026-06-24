// Risk engine. The hard rules that gate whether a `Setup` may become a trade.
//
// Pure: `evaluateRisk(setup, context)` is a function of its inputs only. It
// returns the frozen `RiskDecision` shape (verdict + reasons). Position sizing
// is exposed separately via `positionSize` so callers can show the number.

import type { EntryZone, RiskDecision, Setup } from "@/lib/types";

/** A previously-issued signal we must not duplicate. */
export interface ExistingSignal {
  direction: Setup["direction"];
  entryZone: EntryZone;
}

export interface RiskContext {
  /** Account equity in account currency. */
  accountEquity: number;
  /** Max risk per trade as a percent of equity. Default 1 (= 1%). */
  riskPerTradePct?: number;
  /** Trades already taken today. */
  tradesToday: number;
  /** Max trades per day. Default 2. */
  maxTradesPerDay?: number;
  /** Minimum acceptable reward-to-risk. Default 2. */
  minRiskReward?: number;
  /** Open/pending signals to dedupe against (same direction + zone overlap). */
  existingSignals?: ExistingSignal[];
  /** Current spread in price units. */
  spread?: number;
  /** Max acceptable spread in price units (warn beyond it). */
  maxSpread?: number;
  /** High-impact news risk active (warn). */
  newsRisk?: boolean;
  /** Warn when setup confidence is below this. Default 0.5. */
  minConfidence?: number;
}

const DEFAULTS = {
  riskPerTradePct: 1,
  maxTradesPerDay: 2,
  minRiskReward: 2,
  minConfidence: 0.5,
} as const;

/**
 * Evaluate a setup against the hard risk rules.
 *
 * Verdict aggregation: any blocking rule → REJECTED; otherwise any soft flag →
 * WARNING; otherwise APPROVED. `reasons` always explains every rule that fired.
 */
export function evaluateRisk(setup: Setup, context: RiskContext): RiskDecision {
  const ctx = { ...DEFAULTS, ...context };
  const rejects: string[] = [];
  const warnings: string[] = [];

  // 1. Daily trade cap.
  if (ctx.tradesToday >= ctx.maxTradesPerDay) {
    rejects.push(
      `Daily trade limit reached (${ctx.tradesToday}/${ctx.maxTradesPerDay}).`,
    );
  }

  // 2. Reward-to-risk floor.
  if (setup.riskReward < ctx.minRiskReward) {
    rejects.push(
      `Reward-to-risk ${fmt(setup.riskReward)} below minimum ${fmt(ctx.minRiskReward)}.`,
    );
  }

  // 3. Risk distance must be positive and well-defined for sizing.
  const entry = entryPrice(setup);
  const riskPerUnit = Math.abs(entry - setup.stopLoss);
  if (riskPerUnit <= 0) {
    rejects.push("Invalid stop: entry and stop-loss are equal.");
  }

  // 4. No duplicate signal in the same zone (same direction + overlapping zone).
  if (ctx.existingSignals?.some(
    (s) =>
      s.direction === setup.direction && zonesOverlap(s.entryZone, setup.entryZone),
  )) {
    rejects.push("Duplicate signal: an open signal already covers this zone.");
  }

  // --- Soft flags (warnings) ---
  if (ctx.spread !== undefined && ctx.maxSpread !== undefined && ctx.spread > ctx.maxSpread) {
    warnings.push(`Spread ${fmt(ctx.spread)} exceeds max ${fmt(ctx.maxSpread)}.`);
  }
  if (ctx.newsRisk) {
    warnings.push("High-impact news risk active.");
  }
  if (setup.confidence < ctx.minConfidence) {
    warnings.push(
      `Confidence ${fmt(setup.confidence)} below preferred ${fmt(ctx.minConfidence)}.`,
    );
  }

  if (rejects.length > 0) {
    return { verdict: "REJECTED", reasons: rejects.concat(warnings) };
  }

  // Position is sized to risk exactly `riskPerTradePct`% of equity — the 1%
  // rule is satisfied by construction. Report the figure for transparency.
  const size = positionSize(setup, ctx.accountEquity, ctx.riskPerTradePct);
  const riskAmount = (ctx.accountEquity * ctx.riskPerTradePct) / 100;
  const sizing = `Size ${fmt(size)} units risking ${fmt(riskAmount)} (${fmt(ctx.riskPerTradePct)}% of equity).`;

  if (warnings.length > 0) {
    return { verdict: "WARNING", reasons: warnings.concat(sizing) };
  }
  return { verdict: "APPROVED", reasons: [sizing] };
}

/**
 * Units to trade so that hitting the stop loses exactly `riskPct`% of equity.
 * Returns 0 when the risk distance is non-positive (caller will have rejected).
 */
export function positionSize(
  setup: Setup,
  accountEquity: number,
  riskPct: number = DEFAULTS.riskPerTradePct,
): number {
  const riskPerUnit = Math.abs(entryPrice(setup) - setup.stopLoss);
  if (riskPerUnit <= 0) return 0;
  const riskAmount = (accountEquity * riskPct) / 100;
  return riskAmount / riskPerUnit;
}

/** Mid of the entry zone — the representative fill price. */
function entryPrice(setup: Setup): number {
  return (setup.entryZone.low + setup.entryZone.high) / 2;
}

function zonesOverlap(a: EntryZone, b: EntryZone): boolean {
  return a.low <= b.high && b.low <= a.high;
}

function fmt(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
