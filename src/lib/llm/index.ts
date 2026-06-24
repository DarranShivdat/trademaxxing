// Barrel for the LLM analyst layer. Import from "@/lib/llm".
//
// Language tasks only — these helpers never place trades or predict price.

export { getLLMProvider } from "./client";
export {
  explainSignal,
  persistSignalExplanation,
  buildSignalUserPrompt,
  type ExplainSignalOptions,
} from "./explain-signal";
export {
  reviewJournal,
  persistDailyReview,
  computeJournalStats,
  buildJournalUserPrompt,
  toUtcDay,
  JOURNAL_REVIEW_MODEL,
  type ReviewJournalOptions,
} from "./review-journal";
export type {
  SignalExplanation,
  JournalReview,
  JournalStats,
  LLMUsageMeta,
} from "./types";
