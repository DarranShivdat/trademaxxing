// Signal explanation — high-volume language task, runs on the provider default
// (Haiku). Given a Setup, produce a plain-English explanation: what it is, why
// it qualifies, what invalidates it, what to watch, and risk warnings.
//
// The model is a language tool only: it does not place trades, recommend
// entries/exits, or predict price. The `confidence` value is reported as-is —
// never fabricated or adjusted.

import type { LLMProvider } from "@/lib/providers";
import type { Setup } from "@/lib/types";
import { prisma } from "@/lib/db";
import { getLLMProvider } from "./client";
import { asString, asStringArray, extractJsonObject } from "./json";
import { type SignalExplanation, toUsageMeta } from "./types";

const SYSTEM_PROMPT = `You are a trading-signal analyst for an educational paper-trading platform. You explain pre-computed technical trade setups in plain English. You are a language tool, not a trader.

ABSOLUTE RULES:
- NEVER place, recommend, or size a trade. Do not tell the user to buy, sell, enter, exit, or hold.
- NEVER predict future price, the outcome of the setup, or any probability of success.
- Explain ONLY the setup that the detection system already produced.
- Use ONLY the numbers and fields present in the provided setup JSON. Do NOT invent indicators, price levels, statistics, or a confidence value. The confidence is supplied — report it verbatim and never adjust or estimate it.
- If a field is absent or empty, say it is not provided rather than guessing.
- Stay factual and neutral. Always include risk warnings: this is paper trading, setups can and do fail, and nothing here is financial advice.

Respond with STRICT JSON only — no markdown, no text outside the JSON — matching exactly:
{
  "explanation": string,          // one short paragraph
  "whyQualifies": string[],       // reasons tied to the setup's fields/reasonCodes
  "whatInvalidates": string[],    // conditions that void the setup
  "whatToWatch": string[],        // what to monitor while it is live
  "riskWarnings": string[]        // risk/educational caveats
}`;

export interface ExplainSignalOptions {
  /** Inject a provider (testing / model override). Defaults to Haiku provider. */
  provider?: LLMProvider;
  /** Override the model. Omit to use the provider default (Haiku, high volume). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Build the user-turn content from a Setup. Pure — useful for tests. */
export function buildSignalUserPrompt(setup: Setup): string {
  return [
    "Explain the following trade setup. Use only these fields.",
    "",
    "```json",
    JSON.stringify(setup, null, 2),
    "```",
  ].join("\n");
}

/**
 * Produce a plain-English explanation of a setup. Uses the provider default
 * model (Haiku) unless overridden.
 */
export async function explainSignal(
  setup: Setup,
  options: ExplainSignalOptions = {},
): Promise<SignalExplanation> {
  const provider = options.provider ?? getLLMProvider();

  const response = await provider.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildSignalUserPrompt(setup) }],
    model: options.model, // undefined => provider default (Haiku)
    maxTokens: options.maxTokens ?? 1500,
    temperature: options.temperature ?? 0.2,
  });

  const parsed = extractJsonObject<Record<string, unknown>>(response.content);

  return {
    explanation: asString(parsed.explanation),
    whyQualifies: asStringArray(parsed.whyQualifies),
    whatInvalidates: asStringArray(parsed.whatInvalidates),
    whatToWatch: asStringArray(parsed.whatToWatch),
    riskWarnings: asStringArray(parsed.riskWarnings),
    meta: toUsageMeta(response),
  };
}

/**
 * Persist an explanation against a signal as an LLM `SignalReview`.
 *
 * `verdict` is "EXPLAINED" — a neutral marker. The LLM does NOT approve or
 * reject trades; this row records a language artifact, not a decision. The full
 * structured explanation is stored as JSON in `raw`. The signal is marked
 * REVIEWED in the same transaction.
 */
export async function persistSignalExplanation(
  signalId: string,
  explanation: SignalExplanation,
) {
  const rationale =
    explanation.explanation.slice(0, 2000) || "(no explanation text)";

  const [review] = await prisma.$transaction([
    prisma.signalReview.create({
      data: {
        signalId,
        reviewer: "LLM",
        verdict: "EXPLAINED",
        rationale,
        raw: JSON.stringify(explanation),
      },
    }),
    prisma.signal.update({
      where: { id: signalId },
      data: { status: "REVIEWED" },
    }),
  ]);

  return review;
}
