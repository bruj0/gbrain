import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';

/**
 * Cloudflare Workers AI reranker — native endpoint, NOT openai-compatible.
 *
 * Workers AI exposes `bge-reranker-base` only through the native
 *   POST /client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/baai/bge-reranker-base
 * endpoint, with a custom request/response shape (not the OpenAI-compat
 * `/v1/rerank`). See
 *   https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/
 *
 * This is why this is a SEPARATE recipe from cloudflare.ts. Putting
 * bge-reranker-base on the openai-compat recipe would 404 — the compat
 * surface does not expose /v1/rerank. Same account + token as the embedding
 * recipe; users wire them together with two `gbrain config set` calls.
 *
 * Pricing reference (verified 2026-09-17): bge-reranker-base is $0.003 per M
 * input tokens (283 neurons/M). Free-tier available.
 *
 * Rate limit: inherits the text-classification limit (2,000 req/min per the
 * Workers AI limits page — no separate row for rerank). Fail-open when the
 * account hits the per-day neuron budget; fallback is gbrain search in RRF
 * fusion order without rerank (already exercised by other recipes when keys
 * are missing).
 *
 * Companion recipe: ./cloudflare.ts handles embedding + chat via the
 * OpenAI-compat /v1 surface; this file handles the native reranker. The two
 * share CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN.
 */
export const cloudflareRerank: Recipe = {
  id: 'cloudflare-rerank',
  name: 'Cloudflare Workers AI (reranker, native)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  // base_url_default omitted — URL is env-templated from CF_ACCOUNT_ID.
  auth_env: {
    required: ['CLOUDFLARE_API_TOKEN', 'CF_ACCOUNT_ID'],
    setup_url: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  touchpoints: {
    reranker: {
      // Only one reranker model ships today on the Workers AI catalog; the
      // recipe is intentionally narrow so a future model addition is a
      // deliberate change rather than a silent widening.
      models: ['@cf/baai/bge-reranker-base'],
      default_model: '@cf/baai/bge-reranker-base',
      // Display hint; per-neuron billing math lives in
      // src/core/embedding-pricing.ts.
      cost_per_1m_tokens_usd: 0.003,
      price_last_verified: '2026-09-17',
      // CF AI Run payloads cap at 5 MB on the Workers AI side; mirror the
      // dashscope-rerank + llama-server-reranker budget so gateway.rerank()
      // fail-open RRF-fallback triggers at the same threshold as siblings.
      max_payload_bytes: 5_000_000,
      // Native endpoint is at /ai/run/<model>, NOT /v1/rerank. The gateway
      // concatenates ${baseURL}${path}; we set baseURL to the /client/v4
      // boundary (no /v1 suffix) and path to the model-specific leaf so the
      // final URL is
      //   https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/baai/bge-reranker-base
      path: '/ai/run/@cf/baai/bge-reranker-base',
      // Cloudflare's cross-region latency can exceed the 5s gateway default
      // on first call; same rationale as dashscope-rerank.
      default_timeout_ms: 30_000,
    },
  },
  setup_hint:
    'Same CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN as the cloudflare embedding recipe. ' +
    'Activate with `gbrain config set search.reranker.model cloudflare-rerank:@cf/baai/bge-reranker-base`. ' +
    'Embedding and rerank can run side-by-side: this recipe only sets the rerank path.',
  resolveOpenAICompatConfig(env) {
    const accountId = env.CF_ACCOUNT_ID?.trim();
    if (!accountId) {
      throw new AIConfigError(
        'Cloudflare Workers AI reranker requires CF_ACCOUNT_ID.',
        'Find it on the right sidebar of the Cloudflare dashboard home page. ' +
          'Then `export CF_ACCOUNT_ID=...` and re-run.',
      );
    }
    // baseURL intentionally has NO /v1 suffix — the path field above
    // includes the full /ai/run/<model> leaf, and the gateway concatenates
    // them as ${baseURL}${path}. This is the only recipe in the registry
    // whose path is the entire model-specific native endpoint.
    return {
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}`,
    };
  },
};
