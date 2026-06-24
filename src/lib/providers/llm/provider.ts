// Thin abstraction over a chat-completion call. Swap providers (Anthropic
// today) without touching consumers.

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMCompletionRequest {
  messages: LLMMessage[];
  /** System prompt. Merged with any `system`-role entries in `messages`. */
  system?: string;
  /** Override the provider's default model. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMCompletionResponse {
  /** Concatenated text content of the response. */
  content: string;
  /** The model that actually served the response. */
  model: string;
  stopReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LLMProvider {
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}
