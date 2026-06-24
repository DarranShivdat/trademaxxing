// Lazily-constructed default LLM provider.
//
// Built on demand so that importing the analyst module never requires an API
// key (keeps unit tests and prompt-only code paths importable). Callers may
// inject their own provider for testing or to swap models — see the `provider`
// option on explainSignal / reviewJournal.

import { AnthropicProvider, type LLMProvider } from "@/lib/providers";

let cached: LLMProvider | undefined;

/** The process-wide default provider (Anthropic, Haiku default model). */
export function getLLMProvider(): LLMProvider {
  if (!cached) {
    cached = new AnthropicProvider();
  }
  return cached;
}
