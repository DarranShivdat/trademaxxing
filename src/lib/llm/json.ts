// Defensive JSON extraction from a model's text response.
//
// The LLMProvider contract is a plain text-in/text-out `complete()` — it does
// not expose structured-output constraints. So we prompt the model for strict
// JSON and parse robustly here: strip code fences, then parse the outermost
// brace-delimited object. This keeps the provider contract untouched.

/**
 * Parse a JSON object out of model text. Throws if no valid object is found —
 * callers decide how to surface that (the API routes return 502).
 */
export function extractJsonObject<T = unknown>(text: string): T {
  const cleaned = stripCodeFences(text).trim();

  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall through to brace-slicing.
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not contain a JSON object");
  }

  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from LLM response: ${(err as Error).message}`,
    );
  }
}

function stripCodeFences(text: string): string {
  // Remove a leading ```json / ``` fence and a trailing ``` fence if present.
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
}

/** Coerce an unknown value into a string array, dropping non-strings. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Coerce an unknown value into a trimmed string, with a fallback. */
export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
