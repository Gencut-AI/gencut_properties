/**
 * The model contract. Domain code asks for a ROLE, never a model: the
 * ModelRouter (packages/services) maps roles to provider + model in
 * configuration, so a provider can be swapped without touching any rule here.
 * `pnpm lint` rejects model names in this package.
 */
export const MODEL_ROLES = ['reasoning', 'creative', 'fast'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelRequest {
  readonly role: ModelRole;
  /** Stable instructions; providers may cache them. */
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from the provider's prompt cache, billed at the cache-read rate. */
  readonly cacheReadTokens: number;
  /** Input tokens written to the prompt cache, billed at the cache-write rate. */
  readonly cacheWriteTokens?: number;
}

export interface ModelResponse {
  readonly text: string;
  readonly usage: ModelUsage;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
}

/** Prices in US dollars per million tokens, from the provider's published price list. */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  /** Defaults to 1.25 × the input price (five-minute cache). */
  readonly cacheWritePerMTok?: number;
}

/** Cost of one call in US dollars, rounded to a millionth of a dollar. */
export function costUsd(usage: ModelUsage, price: ModelPricing): number {
  const written = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - written);
  const usd =
    (uncached * price.inputPerMTok +
      usage.cacheReadTokens * price.cacheReadPerMTok +
      written * (price.cacheWritePerMTok ?? price.inputPerMTok * 1.25) +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Pull the first JSON object out of a model reply (tolerates code fences or a lead-in sentence). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model reply contains no JSON object.');
  return JSON.parse(body.slice(start, end + 1));
}
