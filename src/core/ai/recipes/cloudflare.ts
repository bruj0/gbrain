import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';

/**
 * Cloudflare Workers AI — embedding + chat via the official OpenAI-compatible
 * surface.
 *
 * Workers AI exposes `/v1/embeddings` and `/v1/chat/completions` at
 *   https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
 * documented at
 *   https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
 *
 * Auth is `Authorization: Bearer ${CLOUDFLARE_API_TOKEN}`. Two env vars:
 *   CF_ACCOUNT_ID  — required, the 32-char hex account ID on the right
 *                    sidebar of the Cloudflare dashboard home page.
 *   CLOUDFLARE_API_TOKEN — required, scoped to "Workers AI: Edit" (read+run
 *                    covers it; "Edit" matches what AI Gateway needs for
 *                    unified billing). Create at
 *                    My Profile → API Tokens → Edit Cloudflare Workers.
 *
 * Rerank is intentionally NOT on this recipe. The Workers AI reranker
 * (`@cf/baai/bge-reranker-base`) is reachable only through the native
 * `/ai/run/<model>` endpoint, not the OpenAI-compatible `/v1/rerank`. Putting
 * it here would 404 on the compat surface. The companion
 * `cloudflare-rerank` recipe (see ./cloudflare-rerank.ts) covers that path.
 *
 * Pricing reference (https://developers.cloudflare.com/workers-ai/platform/pricing/,
 * verified 2026-09-17): embedding costs shown here are display hints; the
 * billing math lives in src/core/embedding-pricing.ts. Per-neuron list prices:
 *   bge-small-en-v1.5    $0.020/M input tokens  (1,841 neurons/M)
 *   bge-base-en-v1.5     $0.067/M input tokens  (6,058 neurons/M)
 *   bge-large-en-v1.5    $0.204/M input tokens  (18,582 neurons/M)
 *   bge-m3               $0.012/M input tokens  (1,075 neurons/M) — multilingual, 60k ctx
 *   qwen3-embedding-0.6b $0.012/M input tokens  (1,075 neurons/M)
 *   plamo-embedding-1b   $0.019/M input tokens  (1,689 neurons/M) — Japanese
 *
 * Free-tier availability (2026-07-28 changelog): every embedding model in
 * this recipe is reachable on the Workers Free plan. The 10,000 neurons/day
 * free allocation ≈ 9.3M tokens/day of bge-m3 — generous for development.
 * Production should be on Workers Paid ($5/mo floor, 10k neurons/day free
 * then $0.011 per 1k neurons).
 *
 * Rate limit (https://developers.cloudflare.com/workers-ai/platform/limits/):
 *   Text Embeddings default 3,000 req/min per account per model;
 *   bge-large-en-v1.5 is throttled to 1,500 req/min. bge-m3's 60,000-token
 *   context window means a single request carries hundreds of chunks for
 *   personal-brain scale, so the rate ceiling is rarely binding. Use
 *   `gbrain reindex --max-concurrency` to stay safely under 3k req/min
 *   during bulk reindex.
 */
export const cloudflare: Recipe = {
  id: 'cloudflare',
  name: 'Cloudflare Workers AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  // base_url_default omitted — URL is env-templated from CF_ACCOUNT_ID.
  auth_env: {
    required: ['CLOUDFLARE_API_TOKEN', 'CF_ACCOUNT_ID'],
    setup_url: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  touchpoints: {
    embedding: {
      models: [
        '@cf/baai/bge-small-en-v1.5',
        '@cf/baai/bge-base-en-v1.5',
        '@cf/baai/bge-large-en-v1.5',
        '@cf/baai/bge-m3',
        '@cf/qwen/qwen3-embedding-0.6b',
      ],
      // New-install default: bge-m3 is the cheapest hosted multilingual
      // option and its 60k context window makes bulk embed cheap. Same 1024
      // dims as Voyage's voyage-4 default, so the recipe stays
      // cross-compatible at the column-width level (vectors are NOT
      // interchangeable across models — `gbrain migrate embeddings --dry-run`
      // before any cross-model swap).
      default_model: '@cf/baai/bge-m3',
      default_dims: 1024,
      // Display hint only. bge-m3 list price.
      cost_per_1m_tokens_usd: 0.012,
      price_last_verified: '2026-09-17',
      // bge-m3 context window is 60,000 tokens; the smaller BGE-EN models
      // cap at 512. Set the recipe budget to the floor (512) so the gateway's
      // recursive-halving safety net triggers correctly for the small models
      // when a dense payload overshoots. bge-m3 and qwen3-embedding will run
      // well under that budget on a per-call basis; chunked corpora typically
      // average 200–500 tokens per chunk.
      max_batch_tokens: 512,
      // Display estimate: BGE tokenizers run roughly 1 char ≈ 1 token on
      // mixed content. Conservative half-utilization to give the recursive
      // splitter headroom.
      chars_per_token: 1,
      safety_factor: 0.5,
    },
    // reranker intentionally omitted: the OpenAI-compat surface has no
    // /v1/rerank; bge-reranker-base is reached through the native
    // /ai/run/<model> path on the companion `cloudflare-rerank` recipe
    // (./cloudflare-rerank.ts).
    chat: {
      // Per the Cloudflare OpenAI-compat docs, MOST text generation models
      // (not just embedding models) are reachable through
      // /v1/chat/completions. gpt-oss-120b is the canonical Free-plan default
      // for `gbrain think` synthesis; the kimi-k2/glm-5.x frontier models
      // that require Paid are not listed here (gate them at the chat-touch
      // surface via a follow-up if/when subagent-loop pins land).
      models: [
        '@cf/openai/gpt-oss-120b',
        '@cf/openai/gpt-oss-20b',
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        '@cf/qwen/qwen3-30b-a3b-fp8',
        '@cf/google/gemma-4-26b-a4b-it',
        '@cf/ibm-granite/granite-4.0-h-micro',
      ],
      // Cloudflare tool-call envelope has not been pinned to survive
      // subagent-loop abort/replay; refuse the loop until a live replay pin
      // exists.
      supports_tools: true,
      supports_subagent_loop: false,
      // CF chat caching behavior is not documented as an OpenAI-style
      // automatic cache; treat as unknown to keep the prompt-cache UI
      // honest.
      supports_prompt_cache: false,
      max_context_tokens: 128_000,
      cost_per_1m_input_usd: 0.35,
      cost_per_1m_output_usd: 0.75,
      price_last_verified: '2026-09-17',
    },
  },
  setup_hint:
    'Create an API token at https://dash.cloudflare.com/profile/api-tokens ' +
    '(scoped to Workers AI: Edit). Find CF_ACCOUNT_ID on the right sidebar of ' +
    'the Cloudflare dashboard home page. Then `export CLOUDFLARE_API_TOKEN=...` ' +
    'and `export CF_ACCOUNT_ID=...` and `gbrain config set embedding_model ' +
    'cloudflare:@cf/baai/bge-m3`.',
  resolveOpenAICompatConfig(env) {
    const accountId = env.CF_ACCOUNT_ID?.trim();
    if (!accountId) {
      throw new AIConfigError(
        'Cloudflare Workers AI requires CF_ACCOUNT_ID.',
        'Find it on the right sidebar of the Cloudflare dashboard home page. ' +
          'Then `export CF_ACCOUNT_ID=...` and re-run.',
      );
    }
    // The OpenAI-compat surface is at
    //   /client/v4/accounts/{ACCOUNT_ID}/ai/v1
    // The AI SDK's openai-compatible adapter appends /embeddings or
    // /chat/completions to the baseURL, so we set baseURL to the /v1
    // boundary and let the SDK handle the suffix.
    return {
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    };
  },
};
