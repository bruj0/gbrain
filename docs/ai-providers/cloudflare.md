# Cloudflare Workers AI (embedding + chat + rerank)

Cloudflare Workers AI runs open-source models (BAAI BGE, Qwen3, GPT-OSS, Llama,
Gemma, GLM, Kimi, NVIDIA Nemotron, …) on Cloudflare's global network. Two
of the three touchpoints gbrain needs are reachable through Cloudflare's
**official OpenAI-compatible endpoint**; rerank uses a separate **native
endpoint** because Cloudflare does not expose an OpenAI-compatible `/v1/rerank`.

Two recipes ship for this provider:

| Recipe id           | Models                                      | Endpoint surface |
|---------------------|---------------------------------------------|------------------|
| `cloudflare`        | `bge-m3`, `bge-large-en-v1.5`, `qwen3-embedding-0.6b`, `bge-base-en-v1.5`, `bge-small-en-v1.5`, plus `gpt-oss-120b/20b`, `llama-3.3-70b`, `qwen3-30b-a3b`, `gemma-4-26b`, `granite-4.0-h-micro` | OpenAI-compatible `/v1/embeddings`, `/v1/chat/completions` |
| `cloudflare-rerank` | `bge-reranker-base`                          | Native `/ai/run/@cf/baai/bge-reranker-base` |

Both share the same two environment variables.

## Setup

1. **Find your `CF_ACCOUNT_ID`.** It's on the right sidebar of the Cloudflare
   dashboard home page, formatted as a 32-char hex string.

2. **Create an API token.** *My Profile → API Tokens → Create Token → Edit
   Cloudflare Workers.* Resources scope: `Workers AI: Edit` (covers run +
   read). The token value is your `CLOUDFLARE_API_TOKEN`.

3. **Pick a plan.** Embedding models are reachable on the Workers Free
   plan (10,000 free neurons/day ≈ 9.3M tokens/day of `bge-m3` at
   1,075 neurons/M input tokens). For production / 24/7 cron loops, the
   Workers Paid plan ($5/mo minimum) removes the daily request cap and
   bills overage at $0.011 per 1,000 neurons. See the Workers plan and
   Workers AI limits pages for the full table.

4. **Export env vars.**
   ```bash
   export CF_ACCOUNT_ID='0123456789abcdef0123456789abcdef'
   export CLOUDFLARE_API_TOKEN='your-token'
   ```

5. **Activate.** Two `gbrain config set` calls cover both touchpoints:
   ```bash
   gbrain config set embedding_model cloudflare:@cf/baai/bge-m3
   gbrain config set search.reranker.model cloudflare-rerank:@cf/baai/bge-reranker-base
   ```

## Pricing (verified 2026-09-17)

| Model                        | $/M input tokens | $/M output tokens | Free plan |
|------------------------------|------------------|-------------------|-----------|
| `@cf/baai/bge-small-en-v1.5` | $0.020           | —                 | ✓         |
| `@cf/baai/bge-base-en-v1.5`  | $0.067           | —                 | ✓         |
| `@cf/baai/bge-large-en-v1.5` | $0.204           | —                 | ✓         |
| `@cf/baai/bge-m3`            | $0.012           | —                 | ✓         |
| `@cf/qwen/qwen3-embedding-0.6b` | $0.012        | —                 | ✓         |
| `@cf/baai/bge-reranker-base` | $0.003           | —                 | ✓         |
| `@cf/openai/gpt-oss-120b`    | $0.35            | $0.75             | ✓         |
| `@cf/openai/gpt-oss-20b`     | $0.20            | $0.30             | ✓         |

See [developers.cloudflare.com/workers-ai/platform/pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
for the full per-model table. Some frontier chat models
(`kimi-k2.6`, `kimi-k2.7-code`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`,
`deepseek-v4-flash`, `deepseek-v4-pro`) require Workers Paid and return
HTTP 403 (internal error `5035`) on Free — see the
[2026-07-28 changelog](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/).

## Limits

- **Embedding rate limit:** 3,000 req/min per account per model
  (`bge-large-en-v1.5` is throttled to 1,500 req/min). `bge-m3`'s
  60,000-token context window means a single request carries hundreds of
  chunks for personal-brain scale, so the rate ceiling is rarely
  binding. For bulk reindex, cap `--max-concurrency` at ~30 to stay safely
  under the ceiling.
- **Free plan daily request limit:** 100,000 Worker requests/day. Resets
  at 00:00 UTC. Over-limit returns `Error 1027`.
- **Free plan daily neuron budget:** 10,000 neurons/day, **no overage**.
  Exceeding the budget returns an error.
- **Cloudflare OpenAI-compat quirk:** the `/v1/responses` path is
  supported **only** for `@cf/openai/gpt-oss-120b` and
  `@cf/openai/gpt-oss-20b`, and only non-streaming. gbrain uses the
  Chat Completions surface, not Responses, so this does not affect the
  brain.

## How it works under the hood

The `cloudflare` recipe points GBrain at:

```
https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1
```

The AI SDK's openai-compatible adapter appends `/embeddings` or
`/chat/completions` to that baseURL. Auth is the unified
`Authorization: Bearer ${CLOUDFLARE_API_TOKEN}` header (CF_ACCOUNT_ID
participates only in URL templating, not in the Bearer).

The `cloudflare-rerank` recipe points at the documented native endpoint:

```
https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-reranker-base
```

Two reasons it's a separate recipe:

1. Cloudflare does not expose `/v1/rerank` on the OpenAI-compat surface.
2. The `gateway.rerank()` call path concatenates `${baseURL}${path}`,
   and the native path lives at `/ai/run/<model>` — different shape from
   the compat `/v1/embeddings` leaf.

Both recipes share `CLOUDFLARE_API_TOKEN` and `CF_ACCOUNT_ID` so a single
token covers embedding + rerank + chat.

## Compatibility notes

- **bge-m3 is multilingual** (100+ languages) with a 60,000-token context
  window. Use it for mixed-language corpora. The smaller BGE-EN models
  cap at 512 tokens per call.
- **`gpt-oss-120b` is a reasoning model** with native tool calling
  support. The recipe declares `supports_tools: true` but
  `supports_subagent_loop: false` — the Cloudflare tool-call envelope has
  not been pinned to survive subagent-loop abort/replay yet.
- **Rerank via the compat surface would 404.** The companion
  `cloudflare-rerank` recipe exists specifically to route through the
  native endpoint. Don't try to set
  `search.reranker.model cloudflare:@cf/baai/bge-reranker-base` — use
  `cloudflare-rerank:@cf/baai/bge-reranker-base` instead.

## See also

- [Cloudflare Workers AI OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI rate limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers AI Free-plan restrictions (2026-07-28 changelog)](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)
- [bge-reranker-base model page](https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/)
- [gbrain embedding provider matrix](../integrations/embedding-providers.md)
