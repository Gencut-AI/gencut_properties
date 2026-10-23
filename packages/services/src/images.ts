/**
 * Image generation behind a provider interface, configured like the text
 * ModelRouter: the model is chosen by configuration (GENCUT_IMAGE_MODEL) and
 * every image is priced from the provider's published list.
 */
import { type MediaContentType, sniffImageType } from '@gencut/core';
import { ModelCallError } from './models.ts';

/**
 * Published prices, US dollars per generated image at 1K resolution.
 * Source: https://ai.google.dev/gemini-api/docs/pricing (read 23 Oct 2026).
 */
export const IMAGE_PRICES: Readonly<Record<string, number>> = {
  'google:gemini-nano-banana-2.1': 0.0336,
  'google:gemini-3.1-flash-lite-image': 0.0336,
  'google:gemini-3.1-flash-image': 0.067,
};

export const DEFAULT_IMAGE_MODEL = 'google:gemini-nano-banana-2.1';

export interface ImageRequest {
  readonly prompt: string;
  readonly aspectRatio: '1:1' | '4:5' | '16:9';
}

export interface ImageResult {
  readonly bytes: Uint8Array;
  readonly contentType: MediaContentType;
}

export interface ImageProvider {
  readonly name: string;
  generate(model: string, request: ImageRequest): Promise<ImageResult>;
}

export interface GeneratedImage extends ImageResult {
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number;
  readonly latencyMs: number;
}

/** One configured image model, with its price. */
export class ImageGenerator {
  readonly provider: string;
  readonly model: string;
  readonly priceUsd: number;
  private readonly impl: ImageProvider;
  private readonly now: () => number;

  constructor(opts: { provider: ImageProvider; model: string; priceUsd?: number; now?: () => number }) {
    this.impl = opts.provider;
    this.provider = opts.provider.name;
    this.model = opts.model;
    const price = opts.priceUsd ?? IMAGE_PRICES[`${this.provider}:${this.model}`];
    if (price === undefined) throw new Error(`No published price configured for ${this.provider}:${this.model}.`);
    this.priceUsd = price;
    this.now = opts.now ?? (() => performance.now());
  }

  async generate(request: ImageRequest): Promise<GeneratedImage> {
    const started = this.now();
    const image = await this.impl.generate(this.model, request);
    return { ...image, provider: this.provider, model: this.model, costUsd: this.priceUsd, latencyMs: Math.max(0, Math.round(this.now() - started)) };
  }
}

/**
 * Google Gemini image models over the Interactions API, with fetch. The key is
 * sent only in the request header and never appears in errors.
 */
export class GoogleImageProvider implements ImageProvider {
  readonly name = 'google';
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async generate(model: string, request: ImageRequest): Promise<ImageResult> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          model,
          input: request.prompt,
          response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: request.aspectRatio, image_size: '1K' },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ModelCallError('google', `Could not reach the Google API (${e instanceof Error ? e.name : 'error'}).`);
    }
    const body = (await res.json().catch(() => null)) as GoogleInteraction | null;
    if (!res.ok) {
      const detail = (body?.error?.message ?? '').split(this.apiKey).join('[key]').replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new ModelCallError('google', `Google API returned ${res.status}${body?.error?.status ? ` (${body.error.status})` : ''}${detail ? `: ${detail}` : '.'}`, res.status);
    }
    // The image is the last image block of the model's output steps.
    const blocks = (body?.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []);
    const image = blocks.filter((b) => b.type === 'image' && typeof b.data === 'string' && b.data.length > 0).at(-1);
    if (!image?.data) {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      throw new ModelCallError('google', `Google returned no image (status ${body?.status ?? 'unknown'})${text ? `: ${text}` : '.'}`);
    }
    const bytes = new Uint8Array(Buffer.from(image.data, 'base64'));
    const contentType = sniffImageType(bytes);
    if (!contentType) throw new ModelCallError('google', 'Google returned data that is not a PNG, JPEG or WebP image.');
    return { bytes, contentType };
  }
}

interface GoogleInteraction {
  status?: string;
  steps?: { type?: string; content?: { type?: string; data?: string; text?: string; mime_type?: string }[] }[];
  error?: { status?: string; message?: string };
}

/** Replays recorded images, for tests and development without spending. */
export class RecordedImageProvider implements ImageProvider {
  readonly name: string;
  readonly calls: { model: string; request: ImageRequest }[] = [];
  private readonly results: (ImageResult | Error)[];

  constructor(results: (ImageResult | Error)[], name = 'google') {
    this.results = [...results];
    this.name = name;
  }

  async generate(model: string, request: ImageRequest): Promise<ImageResult> {
    this.calls.push({ model, request });
    const next = this.results.shift();
    if (!next) throw new ModelCallError(this.name, 'No recorded image left.');
    if (next instanceof Error) throw next;
    return next;
  }
}

/** The production image generator, or null when no key is configured (image generation stays off). */
export function imageGeneratorFromEnv(env: Record<string, string | undefined> = process.env): ImageGenerator | null {
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const spec = env.GENCUT_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
  const i = spec.indexOf(':');
  const provider = spec.slice(0, i);
  if (provider !== 'google') throw new Error(`Image provider ${provider} is not supported.`);
  return new ImageGenerator({ provider: new GoogleImageProvider(key), model: spec.slice(i + 1) });
}
