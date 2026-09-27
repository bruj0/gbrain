/**
 * Cloudflare Workers AI recipe smoke.
 *
 * Covers:
 *  - Recipe registered with expected shape (id, tier, base_url_default omission)
 *  - defaultResolveAuth returns Authorization Bearer <token> when both
 *    CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID are set
 *  - missing CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID → AIConfigError naming the recipe
 *  - resolveOpenAICompatConfig templates the URL from CF_ACCOUNT_ID onto the
 *    /v1 suffix; bge-m3 60k context stays the recommended default; the
 *    embedding batch cap mirrors the smallest BGE-EN model (512 tokens) so
 *    the recursive-halving safety net triggers correctly across the catalog
 *  - cloudflare-rerank companion recipe exists, declares the NATIVE
 *    /ai/run/@cf/baai/bge-reranker-base path (NOT /v1/rerank), and shares
 *    the same env-var contract
 *  - IRON RULE: cloudflare is NOT in the v0.32 9-recipe baseline but its
 *    defaultResolveAuth output is identical to the baseline shape, so the
 *    unified auth seam treats it the same as voyage/openai/etc.
 *
 * Reference docs:
 *  https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
 *  https://developers.cloudflare.com/workers-ai/platform/pricing/
 *  https://developers.cloudflare.com/workers-ai/platform/limits/
 *  https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe, listRecipes } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('recipe: cloudflare (embedding + chat)', () => {
  test('registered with expected shape', () => {
    const r = getRecipe('cloudflare');
    expect(r).toBeDefined();
    expect(r!.id).toBe('cloudflare');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
    // base_url_default intentionally omitted — URL is env-templated from
    // CF_ACCOUNT_ID via resolveOpenAICompatConfig, mirroring Azure's pattern.
    expect(r!.base_url_default).toBeUndefined();
    expect(r!.auth_env?.required).toEqual([
      'CLOUDFLARE_API_TOKEN',
      'CF_ACCOUNT_ID',
    ]);
  });

  test('embedding touchpoint declares bge-m3 as default with 1024 dims', () => {
    const r = getRecipe('cloudflare')!;
    expect(r.touchpoints.embedding).toBeDefined();
    const emb = r.touchpoints.embedding!;
    expect(emb.models).toContain('@cf/baai/bge-m3');
    expect(emb.models).toContain('@cf/baai/bge-large-en-v1.5');
    expect(emb.models).toContain('@cf/qwen/qwen3-embedding-0.6b');
    expect(emb.default_model).toBe('@cf/baai/bge-m3');
    expect(emb.default_dims).toBe(1024);
    // Batch cap mirrors the smallest BGE-EN context window (512 tokens) so
    // the gateway's recursive-halving safety net triggers for the
    // small/base/large models; bge-m3 (60k) and qwen3-embedding run well
    // under this budget.
    expect(emb.max_batch_tokens).toBe(512);
  });

  test('chat touchpoint declares gpt-oss-120b as the implicit Free-plan default (models[0])', () => {
    const r = getRecipe('cloudflare')!;
    expect(r.touchpoints.chat).toBeDefined();
    const chat = r.touchpoints.chat!;
    expect(chat.models).toContain('@cf/openai/gpt-oss-120b');
    // gpt-oss-120b is the implicit default (first listed); ChatTouchpoint
    // has no `default_model` field — the recipe sets models[0] as the
    // canonical default via list order, matching how every other
    // openai-compat recipe declares its chat touchpoint.
    expect(chat.models[0]).toBe('@cf/openai/gpt-oss-120b');
    // Tools work on the chat surface, but subagent loop stays refused until
    // a live abort/retry replay pin lands — same posture as minimax.
    expect(chat.supports_tools).toBe(true);
    expect(chat.supports_subagent_loop).toBe(false);
  });

  test('reranker touchpoint intentionally omitted (lives on the companion recipe)', () => {
    const r = getRecipe('cloudflare')!;
    // The compat /v1 surface has no /v1/rerank; bge-reranker-base is reached
    // via the native /ai/run/<model> path on cloudflare-rerank.ts. The
    // recipe omits the reranker block entirely — RerankerTouchpoint.models
    // is required non-empty when declared, so the omission is the right
    // way to say "this recipe does not provide rerank".
    expect(r.touchpoints.reranker).toBeUndefined();
  });

  test('default auth: both env vars set → "Bearer <token>"', () => {
    const r = getRecipe('cloudflare')!;
    const env = {
      CLOUDFLARE_API_TOKEN: 'cf-fake-token',
      CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    };
    const auth = defaultResolveAuth(r, env, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer cf-fake-token');
  });

  test('missing CLOUDFLARE_API_TOKEN → AIConfigError', () => {
    const r = getRecipe('cloudflare')!;
    const env = { CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' };
    expect(() => defaultResolveAuth(r, env, 'embedding')).toThrow(AIConfigError);
  });

  test('missing CF_ACCOUNT_ID → AIConfigError', () => {
    const r = getRecipe('cloudflare')!;
    const env = { CLOUDFLARE_API_TOKEN: 'cf-fake-token' };
    expect(() => defaultResolveAuth(r, env, 'embedding')).toThrow(AIConfigError);
  });

  test('resolveOpenAICompatConfig templates URL from CF_ACCOUNT_ID onto /v1 suffix', () => {
    const r = getRecipe('cloudflare')!;
    expect(r.resolveOpenAICompatConfig).toBeDefined();
    const cfg = r.resolveOpenAICompatConfig!({
      CLOUDFLARE_API_TOKEN: 'cf-fake-token',
      CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    });
    // The AI SDK's openai-compat adapter appends /embeddings or
    // /chat/completions to the baseURL, so we set baseURL to the /v1
    // boundary and let the SDK handle the leaf.
    expect(cfg.baseURL).toBe(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1',
    );
  });

  test('resolveOpenAICompatConfig throws when CF_ACCOUNT_ID is missing', () => {
    const r = getRecipe('cloudflare')!;
    const fn = r.resolveOpenAICompatConfig!;
    expect(() =>
      fn({ CLOUDFLARE_API_TOKEN: 'cf-fake-token' }),
    ).toThrow(AIConfigError);
  });
});

describe('recipe: cloudflare-rerank (native endpoint)', () => {
  test('registered as a separate id (not folded into cloudflare)', () => {
    const r = getRecipe('cloudflare-rerank');
    expect(r).toBeDefined();
    expect(r!.id).toBe('cloudflare-rerank');
    expect(r!.tier).toBe('openai-compat');
    expect(r!.implementation).toBe('openai-compatible');
  });

  test('reranker touchpoint declares native /ai/run/<model> path', () => {
    const r = getRecipe('cloudflare-rerank')!;
    expect(r.touchpoints.reranker).toBeDefined();
    const rer = r.touchpoints.reranker!;
    expect(rer.models).toEqual(['@cf/baai/bge-reranker-base']);
    expect(rer.default_model).toBe('@cf/baai/bge-reranker-base');
    // The whole reason this is a separate recipe: path is the native
    // /ai/run/<model> leaf, NOT /v1/rerank. Concatenated with the baseURL
    // (no /v1 suffix), the final URL is the documented Workers AI native
    // endpoint shape.
    expect(rer.path).toBe('/ai/run/@cf/baai/bge-reranker-base');
    expect(rer.max_payload_bytes).toBe(5_000_000);
  });

  test('resolveOpenAICompatConfig sets baseURL WITHOUT /v1 suffix (path includes leaf)', () => {
    const r = getRecipe('cloudflare-rerank')!;
    expect(r.resolveOpenAICompatConfig).toBeDefined();
    const cfg = r.resolveOpenAICompatConfig!({
      CLOUDFLARE_API_TOKEN: 'cf-fake-token',
      CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    });
    expect(cfg.baseURL).toBe(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef',
    );
    // Final URL when gateway concatenates ${baseURL}${path}:
    //   https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/baai/bge-reranker-base
    // which is the documented native endpoint shape.
    expect(`${cfg.baseURL}${r.touchpoints.reranker!.path}`).toBe(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/baai/bge-reranker-base',
    );
  });
});

describe('IRON RULE: cloudflare recipes register without disturbing existing baseline', () => {
  test('all v0.32 9-recipe baseline ids are still present', () => {
    const ids = new Set(listRecipes().map(r => r.id));
    for (const baseline of [
      'anthropic',
      'deepseek',
      'google',
      'groq',
      'litellm',
      'ollama',
      'openai',
      'together',
      'voyage',
    ]) {
      expect(ids.has(baseline), `baseline recipe ${baseline} missing`).toBe(true);
    }
  });

  test('cloudflare defaultResolveAuth matches the unified Bearer shape used by every other openai-compat recipe', () => {
    // The IRON RULE test (recipes-existing-regression.test.ts) walks every
    // recipe with a non-empty required[] and asserts
    //   {headerName: 'Authorization', token: 'Bearer ' + env[required[0]]}.
    // cloudflare has two required env vars (CLOUDFLARE_API_TOKEN first,
    // CF_ACCOUNT_ID second). The unified seam uses required[0] for the
    // Bearer token and the resolver hook (resolveOpenAICompatConfig) for
    // the URL. This test pins that contract on cloudflare specifically so
    // a future auth refactor can't silently regress it.
    const r = getRecipe('cloudflare')!;
    const env = {
      CLOUDFLARE_API_TOKEN: 'cf-fake-token',
      CF_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    };
    const auth = defaultResolveAuth(r, env, 'embedding');
    expect(auth.headerName).toBe('Authorization');
    expect(auth.token).toBe('Bearer cf-fake-token');
  });
});
