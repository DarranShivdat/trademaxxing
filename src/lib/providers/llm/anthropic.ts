import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMProvider,
} from "./provider";

/**
 * Cheap, fast default. Callers override per-request via `request.model` for
 * heavier analysis (e.g. "claude-opus-4-8"). Using the alias keeps us on the
 * latest Haiku without pinning a dated snapshot.
 */
const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  client?: Anthropic;
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(options: AnthropicProviderOptions = {}) {
    if (options.client) {
      this.client = options.client;
    } else {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "AnthropicProvider: missing API key. Set ANTHROPIC_API_KEY in .env.local.",
        );
      }
      this.client = new Anthropic({ apiKey });
    }
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  }

  async complete(
    request: LLMCompletionRequest,
  ): Promise<LLMCompletionResponse> {
    // Anthropic carries the system prompt as a separate top-level param, so
    // fold any system-role messages out of the messages array.
    const systemParts: string[] = [];
    if (request.system) systemParts.push(request.system);

    const messages: Anthropic.MessageParam[] = [];
    for (const m of request.messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const response = await this.client.messages.create({
      model: request.model ?? this.defaultModel,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(systemParts.length > 0
        ? { system: systemParts.join("\n\n") }
        : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      messages,
    });

    const content = response.content
      .filter(
        (block): block is Anthropic.TextBlock => block.type === "text",
      )
      .map((block) => block.text)
      .join("");

    return {
      content,
      model: response.model,
      stopReason: response.stop_reason ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
