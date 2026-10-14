/**
 * ModelRouter: maps the roles domain code asks for to a provider and model in
 * configuration, prices every call, and records it in `model_runs`.
 *
 * Model names live here (configuration), never in packages/core. Change a
 * route with an environment variable, e.g. GENCUT_MODEL_CREATIVE=
 * "anthropic:claude-opus-5-5", without a code change.
 */
import {
  MODEL_ROLES,
  type ModelPricing,
  type ModelRequest,
  type ModelResponse,
  type ModelRole,
  type ModelUsage,
  costUsd,
} from '@gencut/core';
import type { Db } from './db.ts';

/**
 * Published prices, US dollars per million tokens.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (read 14 Oct 2026).
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPricing>> = {
  'anthropic:claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'anthropic:claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  'anthropic:claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 },
};

export const DEFAULT_ROUTES: Readonly<Record<ModelRole, string>> = {
  reasoning: 'anthropic:claude-sonnet-5-5',
  creative: 'anthropic:claude-sonnet-5-5',
  fast: 'anthropic:claude-haiku-5-5',
};

export interface ProviderReply {
  readonly text: string;
  readonly usage: ModelUsage;
}

export interface ModelProvider {
  readonly name: string;
  complete(model: string, request: ModelRequest): Promise<ProviderReply>;
}

export class ModelCallError extends Error {
  readonly provider: string;
  readonly status: number | null;
  constructor(provider: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'ModelCallError';
    this.provider = provider;
    this.status = status;
  }
}

export interface RoutedResponse extends ModelResponse {
  readonly costUsd: number;
}

export class ModelRouter {
  private readonly providers: Readonly<Record<string, ModelProvider>>;
  private readonly routes: Readonly<Record<ModelRole, string>>;
  private readonly prices: Readonly<Record<string, ModelPricing>>;
  private readonly now: () => number;

  constructor(opts: {
    providers: Record<string, ModelProvider>;
    routes?: Partial<Record<ModelRole, string>>;
    prices?: Record<string, ModelPricing>;
    now?: () => number;
  }) {
    this.providers = opts.providers;
    this.routes = { ...DEFAULT_ROUTES, ...opts.routes };
    this.prices = { ...MODEL_PRICES, ...opts.prices };
    this.now = opts.now ?? (() => performance.now());
    for (const role of MODEL_ROLES) {
      const { provider, model } = this.route(role);
      if (!this.prices[`${provider}:${model}`]) throw new Error(`No published price configured for ${provider}:${model}.`);
    }
  }

  /** Provider and model for a role, e.g. { provider: 'anthropic', model: '…' }. */
  route(role: ModelRole): { provider: string; model: string } {
    const spec = this.routes[role];
    const i = spec.indexOf(':');
    return { provider: spec.slice(0, i), model: spec.slice(i + 1) };
  }

  async complete(request: ModelRequest): Promise<RoutedResponse> {
    const { provider, model } = this.route(request.role);
    const impl = this.providers[provider];
    if (!impl) throw new ModelCallError(provider, `Provider ${provider} is not configured.`);
    const started = this.now();
    const reply = await impl.complete(model, request);
    const latencyMs = Math.max(0, Math.round(this.now() - started));
    const price = this.prices[`${provider}:${model}`];
    return {
      ...reply,
      provider,
      model,
      latencyMs,
      costUsd: price ? costUsd(reply.usage, price) : 0,
    };
  }
}

/** Anthropic Messages API over fetch. The key is sent only in the request header and never logged. */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async complete(model: string, request: ModelRequest): Promise<ProviderReply> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          // The instructions are identical on every call, so they are cached.
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: request.user }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ModelCallError('anthropic', `Could not reach the Anthropic API (${e instanceof Error ? e.name : 'error'}).`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { type?: string } } | null;
      throw new ModelCallError('anthropic', `Anthropic API returned ${res.status}${body?.error?.type ? ` (${body.error.type})` : ''}.`, res.status);
    }
    const body = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const u = body.usage ?? {};
    return {
      text,
      usage: {
        // Anthropic reports cached and newly cached input separately from input_tokens.
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** A provider that replays recorded replies, for tests and development without spending. */
export class RecordedProvider implements ModelProvider {
  readonly name: string;
  readonly calls: { model: string; request: ModelRequest }[] = [];
  private readonly replies: (ProviderReply | Error)[];

  constructor(replies: (ProviderReply | Error)[], name = 'anthropic') {
    this.replies = [...replies];
    this.name = name;
  }

  async complete(model: string, request: ModelRequest): Promise<ProviderReply> {
    this.calls.push({ model, request });
    const next = this.replies.shift();
    if (!next) throw new ModelCallError(this.name, 'No recorded reply left.');
    if (next instanceof Error) throw next;
    return next;
  }
}

/** The production router, or null when no provider key is configured (generation stays off). */
export function modelRouterFromEnv(env: Record<string, string | undefined> = process.env): ModelRouter | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const routes: Partial<Record<ModelRole, string>> = {};
  for (const role of MODEL_ROLES) {
    const v = env[`GENCUT_MODEL_${role.toUpperCase()}`]?.trim();
    if (v) routes[role] = v;
  }
  return new ModelRouter({ providers: { anthropic: new AnthropicProvider(key) }, routes });
}

export interface ModelRunRecord {
  readonly workspaceId: string;
  readonly campaignId?: string | null;
  readonly purpose: string;
  readonly role: ModelRole;
  readonly promptVersion: string;
  readonly factKeys: readonly string[];
}

/** Record a model call (successful or failed) with its usage and cost. */
export async function recordModelRun(
  db: Db,
  r: ModelRunRecord,
  outcome: { ok: true; response: RoutedResponse } | { ok: false; provider: string; model: string; error: string },
): Promise<void> {
  const res = outcome.ok ? outcome.response : null;
  await db`
    INSERT INTO model_runs (workspace_id, campaign_id, purpose, role, provider, model, prompt_version, status,
                            input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, fact_keys, error)
    VALUES (${r.workspaceId}, ${r.campaignId ?? null}, ${r.purpose}, ${r.role},
            ${res?.provider ?? (outcome.ok ? '' : outcome.provider)}, ${res?.model ?? (outcome.ok ? '' : outcome.model)},
            ${r.promptVersion}, ${outcome.ok ? 'ok' : 'error'},
            ${res?.usage.inputTokens ?? 0}, ${res?.usage.outputTokens ?? 0}, ${res?.usage.cacheReadTokens ?? 0},
            ${res?.costUsd ?? 0}, ${res?.latencyMs ?? 0}, ${db.json([...r.factKeys] as never)},
            ${outcome.ok ? null : outcome.error.slice(0, 500)})
  `;
}
