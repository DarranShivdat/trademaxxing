/**
 * Run the detection pipeline over candles already in the DB and persist
 * surviving signals (with their risk decision). Thin CLI wrapper around
 * `runDetection` in src/lib/pipeline/detect.ts.
 *
 *   npm run detect
 *   npm run detect -- --timeframe 15min --symbol "XAU/USD"
 *   npm run detect -- --explain            # also generate LLM explanations
 *   npm run detect -- --equity 25000 --max-trades 3
 *
 * Idempotent: re-running does not duplicate signals for bars already detected.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import type { Timeframe } from "../src/lib/types";
import { runDetection } from "../src/lib/pipeline/detect";
import { prisma } from "../src/lib/db";

const TIMEFRAMES: Timeframe[] = ["1min", "5min", "15min", "1h", "4h", "1day"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const symbol = arg("symbol") ?? "XAU/USD";
  const tfArg = arg("timeframe");
  if (tfArg && !TIMEFRAMES.includes(tfArg as Timeframe)) {
    throw new Error(`Invalid --timeframe "${tfArg}". One of: ${TIMEFRAMES.join(", ")}`);
  }
  const timeframe = (tfArg as Timeframe) ?? "1h";
  const explain = flag("explain");
  const equity = arg("equity");
  const maxTrades = arg("max-trades");

  console.log(
    `Detecting ${symbol} ${timeframe}${explain ? " (with LLM explanations)" : ""}…`,
  );

  const result = await runDetection({
    symbol,
    timeframe,
    explain,
    accountEquity: equity ? Number(equity) : undefined,
    maxTradesPerDay: maxTrades ? Number(maxTrades) : undefined,
  });

  console.log(
    `  candles scanned: ${result.candles}\n` +
      `  setups detected: ${result.detected}\n` +
      `  rejected by risk: ${result.rejected}\n` +
      `  skipped (already detected): ${result.skipped}\n` +
      `  persisted: ${result.persisted}`,
  );
  for (const s of result.signals) {
    console.log(
      `    + ${s.signalId} ${s.direction} conf=${s.confidence.toFixed(2)} ` +
        `${s.verdict}${s.explained ? " explained" : ""} @ ${s.barTime}`,
    );
  }
  console.log("Detection complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
