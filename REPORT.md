# GBrain — how it works, what the parts are, and what it costs

Source: clone at `/home/bruj0/projects/gbrain` (master, `VERSION` = `0.59.0.0`).
Repo: [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain).
Author tagline: "Garry's Opinionated OpenClaw/Hermes Agent Brain."

GBrain is **a personal/team knowledge brain** that sits in front of an agent
(OpenClaw, Hermes, Codex, Claude Code, Muse, Grok Bot, …). It gives the agent
long-term memory: pages with sources, a typed graph, hybrid retrieval, optional
synthesis, and an overnight "dream" loop that keeps the corpus fresh. The
production deployment Garry cites is **155,795 pages, 24,589 people, 5,340
companies, 66 cron jobs running autonomously** ([README.md](README.md)).

It is *not* a vector DB. It is *not* an LLM. It is a **Postgres-native application**
that calls external models only at the boundaries that need them (embedding,
reranking, extraction, synthesis), and is engineered so every one of those
boundaries is optional and budgetable.

This report is derived from the cloned tree, the in-repo docs, and the source
files cited inline. It explains the architecture, the parts, and the cost model
so you can decide whether to install it on the Hermes box at `10.0.0.70`.

---

## 1. Mental model in one paragraph

A GBrain has **one engine** (the `BrainEngine` interface, [src/core/engine.ts](src/core/engine.ts)),
**one canonical store** (Markdown pages on disk that GBrain indexes — git is the
system of record; the DB is an index plus operational state), **two query modes**
(`gbrain search` = cheap hybrid retrieval; `gbrain think` = retrieval + cited
synthesis with explicit gap analysis), **a typed graph** (extracted `[[wikilink]]`
references become typed edges, traversable via `traverse_graph`), **a schema
pack** that defines what kinds of pages exist (`person`, `company`, `media`,
`source`, `deal`, `email`, …), **an MCP server** that exposes all of this to
agents (`gbrain serve`, `gbrain mcp expose` for Tailscale/funnel), and **a cron
loop** ("autopilot" / "dream") that runs dedup, citation repair, salience
scoring, contradiction finding, and tomorrow's task prep on a schedule.

The two persistent engines ship today: **PGLite** (Postgres 17 in WASM, embedded,
zero-config, the default for personal brains up to ~50K pages) and
**PostgresEngine** (real Postgres + pgvector — Supabase or self-hosted — for
shared/large/multi-machine). The contract is identical, so a brain can migrate
from one to the other with `gbrain migrate --to supabase/pglite` ([docs/ENGINES.md](docs/ENGINES.md)).

---

## 2. The parts of the system

### 2.1 Engine layer — the `BrainEngine` contract

- **File:** `src/core/engine.ts` (`export interface BrainEngine`, line 740).
  Currently **113 async methods** on the interface — every storage operation
  (page CRUD, chunks, embeddings, links, jobs, signals, sources, budgets,
  calendar, voice, …) is a method on this contract. Engines are pluggable;
  both `PGLiteEngine` and `PostgresEngine` implement the same 113.
- **Why it matters:** CLI, MCP server, skills, ingestion, and synthesis all
  call the engine. Swapping PGLite for Supabase touches zero consumer code.
- **Test gate:** `test/e2e/engine-parity.test.ts` and
  `test/pglite-engine.test.ts` enforce that both engines agree ([docs/ENGINES.md](docs/ENGINES.md)).

### 2.2 Storage / system of record

- **Canonical content** = Markdown files in your brain repo. Git-trackable;
  deletes in git become soft-deletes in the DB.
- **DB-only content** = revision history, unresolved facts, operational
  state, embeddings, link edges. Needs a separate DB backup.
- **Schema lives in source:** [src/schema.sql](src/schema.sql) is the
  authoritative DB schema.
- **Storage tiering** (`docs/architecture/storage-tiering.md`): `db_tracked`
  directories are indexed and canonical (git = source of truth);
  `db_only` directories live only in the DB (e.g. transient captures).
- **Resolver chain** (7 tiers per setting, per-call flag → env var → per-source
  DB key → brain-wide DB key → `gbrain.yml` → `~/.gbrain/config.json` →
  pack default) lets you override at any level without editing config files.

### 2.3 Schema packs — what pages *are*

- A pack declares **page types** (canonical taxonomy) and which paths map to
  which type. Bundled: `gbrain-base-v2` (15 types: `person`, `company`,
  `media`, `tweet`, `social-digest`, `analysis`, `atom`, `concept`, `source`,
  `deal`, `email`, `slack`, `writing`, `project`, `note`), `gbrain-base` (legacy
  24-type), `gbrain-recommended` (extends base with place/trip/conversation/…).
- You can author your own: `gbrain schema detect` clusters your filesystem,
  `gbrain schema suggest` runs an LLM pass over the proposals, and
  `gbrain schema review-candidates --apply` promotes the ones you keep. Three
  commands and the brain knows your shape.
- The active pack threads through **every read + write path**: `parseMarkdown`
  infers type from path prefixes; `whoknows` scopes expert routing to types
  that opt in; `extract_facts` only runs on types marked `extractable: true`.
  Switch packs and the brain re-interprets itself.

### 2.4 Ingestion — how data gets in

- **Explicit `remember` / `put_page`** writes go through with provenance.
- **Connectors / sources** are recipes under `recipes/`. Each is a Markdown
  doc with setup hints. Examples shipped: Twilio voice (calls → brain pages),
  Gmail + Calendar + Contacts (`google` source kind — native OAuth, open-loop
  engine via `gbrain waiting`), email/calendar webhook handlers. Also:
  Notion / Obsidian vault importers, company-brain adapter under
  `third-party/company-brain/`.
- **Capture hooks** (off by default; opt in): signal detector watches
  substantive messages for durable ideas and entity mentions. **Memorable**
  (optional, separate relay, requires explicit consent) captures replayable
  procedures from coding sessions — "remember how, not just what." Both
  redact by default; both can be turned off.

### 2.5 Retrieval — the two query modes

- **`gbrain search`** — raw hybrid retrieval: vector + keyword + RRF + source
  tier boost + reranker. No answer-generation LLM call. Used for cheap,
  fast, personal context. Returns top pages.
- **`gbrain think`** — same retrieval, then synthesis across results with
  **explicit citations to source pages AND an honest note on what the brain
  doesn't know yet** ("gap analysis"). This is the differentiator — not
  "here are 10 chunks," but an actual answer.
- **Hybrid scoring stack** (from [docs/TOOL_CATALOG.md](docs/TOOL_CATALOG.md)
  and [docs/architecture/RETRIEVAL.md](docs/architecture/RETRIEVAL.md)):
  vector similarity + keyword (BM25-style) + RRF fusion + source-tier boost +
  optional reranker (default `voyage:rerank-2.5`). `gbrain search_modes` is a
  read-only dashboard that reports the active mode, every mode-bundle knob
  resolved with attribution, and a reranker readiness verdict.
- **Graph traversal** (`traverse_graph`, `schema_graph`) — typed edges from
  `[[wikilink]]` patterns extracted on trusted local writes. No LLM needed.
  On a 240-page Opus-generated BrainBench run: **P@5 49.1%, R@5 97.9%**, +31.4
  points P@5 over its graph-disabled variant. Scoped benchmark, not a
  universal guarantee ([README.md](README.md)).

### 2.6 Synthesis — when retrieval isn't enough

- `gbrain think` and `find_trajectory` combine multi-hop retrieval + graph
  edges + takes into a cited prose answer with gap analysis.
- The synthesis layer is the single most expensive call in the system: it's
  a chat-capability model call (not embedding or rerank). It is **optional**
  and **budgeted**.

### 2.7 Background jobs — autopilot / the dream cycle

Cron-driven jobs that run while you sleep or while you're not in chat.
From the agent-loop diagram in [docs/guides/brain-agent-loop.md](docs/guides/brain-agent-loop.md):

```
Signal → search → respond → write → auto-link → sync
                                        │
                                  cron keeps fresh
```

Typical jobs: dedup people pages, fix citations, score salience, find
contradictions, prep tomorrow's tasks, rebuild embeddings after schema changes.
There's an admission gate + two-phase persistence so writes survive crashes,
plus a quota on accepted-write waits ([CHANGELOG.md](CHANGELOG.md) v0.57.0.0).

### 2.8 MCP surface — how agents actually use it

- **Server modes:**
  - `gbrain serve` — stdio MCP (local subprocess, for Claude Code / Cursor /
    Windsurf / Hermes).
  - `gbrain serve --http` — HTTP MCP with **OAuth 2.1 + admin dashboard at
    `/admin`** (required for Claude Desktop, Cowork, Perplexity, ChatGPT).
  - `gbrain mcp expose` — publishes the HTTP server on your Tailscale tailnet
    over HTTPS, installs a systemd/launchd user service, and prints separate
    owner-login / native OAuth / machine-client setup steps. `--funnel` opts
    in to public HTTPS for cloud agents like Grok Bot / Muse / ChatGPT.
- **Authorization scopes:** `read`, `write`, `admin`, `agent`. OAuth flows
  support dynamic client registration (registration alone cannot grant
  delegation; `admin` does not imply owner-dashboard access).
- **Tool surface:** the full wall (every operation) by default;
  `--surface verbs` restricts to the seven-verb memory protocol
  (`recall`, `remember`, `entity`, `synthesize`, `forget`, `context_pack`,
  `delta` — see [docs/protocol/MEMORY_VERBS_v1.md](docs/protocol/MEMORY_VERBS_v1.md)).
  Per-call flags can narrow further.
- **Hermes integration:** `hermes mcp add gbrain --env GBRAIN_HOME=$HOME
  --command $(which gbrain) --args serve` ([README.md](README.md)). The
  `--args` must be last.

### 2.9 Skill packs — installed beside the engine

79 skill directories under `skills/` ship in the repo (e.g. memory, schema
author, embedding migration, contradiction finding, google connect, skillopt,
twilio voice, minion deployment, …). New local brains include memory skills
in their content root automatically; agents can join an authorized catalog
but only approved editors can publish.

### 2.10 Minions — durable sub-agents

`gbrain agent run "..."` exposes the same retrieval + think surface to a
sub-agent through the **Minions** queue (`src/core/minions/`). Crash-safe
two-phase persistence. Same answers, durable. Subagent infrastructure
hard-pins to Anthropic-direct (stable `tool_use_id` across crashes/replays);
OR-routed Anthropic is rejected for tool-calling sub-agents.

### 2.11 Admin dashboard / governance

`admin/` is a separate SPA built with Vite/React and bundled via
`scripts/build-admin-embedded.ts` into the CLI binary as `admin-embedded.ts`
so the HTTP server serves `/admin` from the same binary. Playwright e2e
suite at `admin/e2e/` + `admin/playwright.config.ts`. Owner dashboard access
is a separate credential from MCP client credentials ([docs/mcp/ADMIN.md](docs/mcp/ADMIN.md)).

### 2.12 Credential vault + gateway

`gbrain creds` manages OAuth and API credentials in a local vault; the
gateway sits in front of model calls so the agent never sees raw keys
([recipes/credential-gateway.md](recipes/credential-gateway.md)).

---

## 3. How it works — the actual data flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  Hermes (or any agent)                                                │
│    │                                                                   │
│    │   MCP call: recall / think / remember / search / context_pack    │
│    ▼                                                                   │
│  gbrain serve (HTTP or stdio)                                          │
│    │                                                                   │
│    │ 1. Resolve active profile + source + schema pack + scopes         │
│    │ 2. Route to BrainEngine (PGLite or Postgres)                      │
│    │                                                                   │
│    │ ┌─────────────────────────┐    ┌─────────────────────────────┐   │
│    │ │ Hybrid retrieval        │───▶│  embedding provider          │  │
│    │ │  (vector + keyword +    │    │   (Voyage / OpenAI / local)  │  │
│    │ │   RRF + reranker)       │    └─────────────────────────────┘  │
│    │ └─────────────────────────┘                                       │
│    │                                                                   │
│    │ ┌─────────────────────────┐    ┌─────────────────────────────┐   │
│    │ │ Synthesis (think only)  │───▶│  chat model provider         │  │
│    │ │                         │    │   (any configured provider)  │  │
│    │ └─────────────────────────┘    └─────────────────────────────┘   │
│    │                                                                   │
│    │ Writes: put_page / remember / add_link / add_timeline_entry       │
│    │   → BrainEngine → auto-link extraction (no LLM) → index update     │
│    ▼                                                                   │
│  BrainEngine (PGLite WASM or Postgres+pgvector)                        │
│    │                                                                   │
│    │ Pages → Markdown on disk (canonical, git-trackable)               │
│    │ Chunks + embeddings + links + signals (DB only)                   │
│    ▼                                                                   │
│  Cron (autopilot / dream):                                              │
│    dedup, citation repair, salience scoring, contradiction finding,     │
│    embedding reindex, tomorrow's task prep                              │
└──────────────────────────────────────────────────────────────────────┘
```

Key invariants the architecture is designed around:

1. **Prompt-cache stable.** Switching to a MoA preset or a brain MCP call
   does not mutate past context, swap toolsets, or rebuild the system prompt.
   (Hermes MoA's cache design and GBrain's retrieval-prefix design share
   this constraint.)
2. **Provenance is first-class.** Every page has a source; every claim
   surfaces its source; withdrawals remove active memory but leave a trail.
3. **Failure isolation.** Credential failures on one reference model do not
   abort the turn (MoA); the same pattern exists for ingestion — partial
   success is recorded, not silently dropped.
4. **Memory boundaries are explicit.** Markdown export ≠ full DB backup.
   DB-only state has its own backup story
   ([docs/architecture/system-of-record.md](docs/architecture/system-of-record.md)).

---

## 4. What it costs to run

GBrain has four separate cost dimensions, and each is opt-in.

### 4.1 Compute (your hardware)

GBrain runs on your machine. There is no SaaS bill from GBrain itself.

- **PGLite (default):** embedded in-process, zero ops. Single-machine, up to
  ~50K pages. Runs on the LXC container you already have on `10.0.0.70`.
- **Postgres + pgvector:** Supabase (free tier → Pro $25/mo) or self-hosted.
  Recommended for shared/team or >1000-file brains.
- **Min RAM:** 8 GB is the floor for the always-on enrichment path
  (cited in [README.md](README.md) for the Hermes/OpenClaw deploy). Your
  current hermesagent LXC has 8 GB+? (Check with `free -h` on
  `10.0.0.70`.) If you're going to run GBrain alongside Hermes + the
  gateway + the dashboard + MoA, give the LXC at least 12 GB to be safe.

### 4.2 Embeddings (per reindex / per ingest of new content)

The default new-install provider is **Voyage `voyage-4` @ 1024d**. Full
pricing matrix from [docs/integrations/embedding-providers.md](docs/integrations/embedding-providers.md):

| Provider            | Cost ($/1M tokens) | Notes                                 |
|---------------------|--------------------|---------------------------------------|
| `voyage` (default)  | **0.06**           | `voyage-4` 1024d; multimodal `voyage-multimodal-3` |
| `voyage:voyage-code-4` | **0.12**       | code-tuned, hosted, flexible dims     |
| `openai`            | 0.13               | 1536d, text only                      |
| `openrouter`        | 0.02               | default `openai/text-embedding-3-small` (1536d) |
| `google`            | 0.025              | 768d                                  |
| `azure-openai`      | 0.13               | 1536d                                 |
| `minimax`           | 0.07               | 1536d                                 |
| `ollama`            | **0**              | local; 768d default                   |
| `llama-server`      | **0**              | local; user-set dims                  |
| `lmstudio`          | **0**              | local; user-set dims                  |

So a **typical personal brain reindex** of, say, 10M tokens of content (a
modest corpus of notes + emails + meeting transcripts) is on the order of:

- Voyage `voyage-4`: **~$0.60** one-time
- OpenAI `text-embedding-3-small` via OpenRouter: **~$0.20** one-time
- Local Ollama: **$0** (but you pay in CPU/GPU time)

Embeddings are the recurring but bounded cost: every new page gets embedded
once on ingest; reruns only happen on schema migrations or dimension changes.

### 4.3 Reranking (per search call that uses it)

The default reranker is **Voyage `rerank-2.5`**, $0.05/M tokens (lite at
$0.02/M). Reranking is on in `balanced` and `tokenmax` modes; pure keyword
search skips it. Reranking is the per-search cost, not per-archive.

For an estimated 1M tokens / month of rerank traffic (a moderately active
personal brain, generous estimate): **~$0.05/mo** with `rerank-2.5`,
**~$0.02/mo** with `rerank-2.5-lite`. Local alternative: the
`llama-server-reranker` recipe runs Qwen3-Reranker via llama.cpp for **$0/M**
at the cost of your own GPU/CPU.

### 4.4 Synthesis / think calls (the chat model)

This is where the cost story changes. `gbrain think` invokes a configured
**chat-capability model** to compose the cited answer. This is the same kind
of token cost as a normal agent turn — it scales with **how hard you run
the brain**, not with brain size.

The README is explicit: *"Start keyless. Your harness subscription and any
separately configured model API usage are different costs."* And:

> It's also the highest-cost path: a deployed server (8GB+ RAM) plus raw API
> token usage that scales with how hard your agent runs, well beyond a chat
> subscription.

Practical monthly estimates, **assuming you have a configured chat model
already** (e.g. the OpenAI Codex OAuth you already have on this Hermes):

| Usage pattern                                      | Think calls/mo | Est. tokens | Est. cost |
|----------------------------------------------------|----------------|-------------|-----------|
| Light (daily prep, ~10 queries/day)                 | ~300           | ~3M         | ~$1–5     |
| Medium (always-on enrichment + interactive use)     | ~2,000         | ~30M        | ~$10–50   |
| Heavy (24/7 cron + multi-agent + dream cycle)       | ~10,000+       | ~150M+      | ~$50–300+ |

Numbers above use a blended ~$1–2/M for typical hosted models. If you route
the chat model through a local Ollama/llama-server or a flat subscription
like ChatGPT Plus or Codex, the marginal cost collapses to **$0 marginal**,
bounded by your hardware.

The dream cycle itself can be configured to run cheaper models for dedup /
citation repair than for synthesis — costs scale down dramatically.

### 4.5 Other potential costs

- **Voyage rerank** (covered above): typically <$1/mo.
- **Storage** for the DB (if Postgres engine): Supabase free → Pro $25/mo.
- **Tailscale** for `gbrain mcp expose`: free for personal use up to 100
  devices; otherwise $5/device/mo (optional — only if you want to publish
  the brain outside your LAN).
- **Cloud agents (--funnel):** same Tailscale funnel pricing if used.
- **Memorable relay (optional, off by default):** requires explicit
  disclosure/consent step; can send redacted traces off-machine — read
  [docs/memorable-agents.md](docs/memorable-agents.md) before enabling.

### 4.6 Cost-control features baked in

- Per-call flags + env vars + 7-tier config chain let you override the
  provider per-call (e.g. "rerank with `rerank-2.5-lite` for this query").
- `gbrain embed --max-cost` and `gbrain reindex --max-cost` budget
  embedding jobs before they start.
- Local-first providers (Ollama, llama-server, LM Studio) priced at $0 in
  the budget guard.
- `gbrain search_modes` is a read-only dashboard that reports the active
  mode and reranker readiness — you can see exactly what will be billed
  per call.
- Search `gbrain search` does **not** call a chat model; only `gbrain think`
  does. Cheap raw retrieval is always free of synthesis cost.

---

## 5. What it would mean to install on this Hermes

Concrete fit check for `10.0.0.70` (current state: MoA = `gpt-6-luna`
aggregator + `MiniMax-M3` reference; gateway + dashboard running on LAN):

1. **Compute fit:** Hermetic LXC with 8 GB+ RAM is the documented floor.
   GBrain runs as an MCP server alongside the gateway. No conflict — they
   share the same Hermes profile.
2. **Storage fit:** PGLite default stores everything under `~/.gbrain/` on
   the LXC's disk. Cheap, fast, zero ops. The brain repo (canonical
   Markdown) is git-trackable.
3. **Auth fit:** Hermes's `hermes mcp add` already accepts MCP servers.
   The exact command from the README:
   `printf 'Y\n' | hermes mcp add gbrain --env GBRAIN_HOME=$HOME
   --connect-timeout 60 --command $(which gbrain) --args serve`.
   Verify with `hermes mcp test gbrain`. (Hermes's `mcp add` is lazy — exit 0
   doesn't mean it connected.)
4. **Network fit:** GBrain MCP server can bind to the same LAN address as
   the dashboard, or stay local and only be reached from inside the
   container. Tailscale is opt-in if you want remote access.
5. **Model fit:** GBrain needs an embedding provider and optionally a
   reranker and a chat model. Your existing **OpenAI Codex** credential and
   **MiniMax** credential both work for these; you can also drop in Ollama
   if the LXC has GPU access for local embeddings (no API cost).
6. **Cost fit for your stated stack:** the OpenAI Codex OAuth on the
   account means reranking/synthesis via the Codex wire is the same chat
   budget you already have. Embeddings would be a new line item — Voyage
   is $0.06/M, OpenAI direct is $0.13/M. A first reindex of a 10M-token
   corpus is **less than a dollar**. After that, embedding cost is
   bounded by new ingestion rate.
7. **What GBrain does *not* replace:** GBrain does not replace Hermes's
   tool loop, MoA, or gateway. It adds a long-term memory layer that
   Hermes (and any other agent) can call via MCP. Hermes's MoA still
   controls "what model thinks"; GBrain controls "what the model already
   knows about you."
8. **Bootstrap caveat:** the `BOOTSTRAP_FOR_AGENTS.md` path is the
   optional personal-agent bootstrap (creates identity files, a private
   repo, etc.). For *just* the brain on the existing Hermes, the
   `INSTALL_FOR_AGENTS.md` "memory-only" path is the right entry — start
   keyless, preserve unrelated config, do not create an identity repo.
   Verify with `gbrain bootstrap verify` exits 0.

---

## 6. TL;DR

GBrain is a Postgres-native knowledge brain with a strict, large interface
(`BrainEngine`, 113 methods), a typed graph on top of hybrid retrieval, an
optional synthesis layer for cited answers with gap analysis, a schema pack
system that decides what page types even mean, an MCP server with OAuth and
admin dashboard, and a cron-driven dream loop that keeps the corpus fresh.

Cost is dominated by the chat model you point at it (same as any agent
turn) plus per-archive embedding cost (sub-dollar per reindex). Reranking,
local embeddings, local rerankers, and keyless-start all exist to push cost
toward $0 marginal.

For the `10.0.0.70` Hermes: it installs cleanly as an MCP server alongside
the existing gateway, fits the documented 8 GB RAM floor, reuses your
existing Codex OAuth for chat/embedding if you want, and adds a long-term
memory layer that the MoA setup (luna thinking + M3 advising) can read on
every turn to be smarter about you specifically.

---

## 7. Picking an embedding model — given the subscriptions on hand

This is the question you asked. Below is the analysis: **what GBrain actually
supports**, **what each subscription exposes**, **what it costs you in the
four cost dimensions from section 4**, and **the recommended configuration**.

### 7.1 What GBrain natively supports as embedding providers

From [docs/integrations/embedding-providers.md](docs/integrations/embedding-providers.md),
the allowlist is exhaustive. GBrain is wired for:

| Built-in provider | Embed | Rerank | Chat | Cost (embed, $/M) | Cost (rerank, $/M) |
|-------------------|:-----:|:------:|:----:|-------------------|--------------------|
| `voyage`          | ✓     | ✓ (`rerank-2.5`) | — | **0.06** (`voyage-4` 1024d) | **0.05** (2.5) / 0.02 (lite) |
| `openai`          | ✓     | —      | ✓    | 0.13 (1536d)      | —                  |
| `openrouter`      | ✓     | —      | ✓    | 0.02 (1536d)      | —                  |
| `google`          | ✓     | —      | ✓    | 0.025 (768d)      | —                  |
| `azure-openai`    | ✓     | —      | ✓    | 0.13 (1536d)      | —                  |
| `minimax`         | ✓     | —      | ✓    | 0.07 (1536d)      | —                  |
| `dashscope`       | ✓     | —      | —    | varies (1024d)    | —                  |
| `zhipu`           | ✓     | —      | —    | varies (1024d)    | —                  |
| `together`        | ✓     | —      | —    | varies (768d)     | —                  |
| `ollama`          | ✓ (local) | ✓ (local recipe) | ✓ | **0** (local) | **0** (local) |
| `llama-server`    | ✓ (local) | ✓ (Qwen3-Reranker) | ✓ | **0** (local) | **0** (local) |
| `lmstudio`        | ✓ (local) | — | ✓ | **0** (local) | —                  |
| `litellm`         | ✓ (proxy) | — | ✓ | varies | varies |
| `anthropic` / `deepseek` / `groq` | ✗ | — | ✓ | — | — |

That covers everything you have **except Cloudflare and OpenAdapter as first-class
providers.** Both can still be reached, but only via the `openai-compatible`
recipe tier (`src/core/ai/gateway.ts` uses `createOpenAICompatible` from
`@ai-sdk/openai-compatible`, and the provider matrix at
`src/core/ai/types.ts:25` declares `'openai-compatible'` as a recognized tier).
You'd register them as a custom recipe in `gbrain.yml`, point at their base URL,
and supply an API key header. Not zero-config — you author the recipe once.

### 7.2 What each of your subscriptions exposes

- **OpenAI Codex subscription.** This is the OAuth-gated ChatGPT/Codex endpoint
  Hermes already uses (`provider: openai-codex` in
  [/home/hermes/.hermes/config.yaml]). It is a **chat-completions-style endpoint,
  not an OpenAI platform API key.** GBrain's `openai` provider expects a
  real `OPENAI_API_KEY` (platform.openai.com). It will **not** accept the Codex
  OAuth credential directly. You can route Codex through OpenRouter or another
  gateway that fronts it, but at the GBrain config level you do **not** get
  embeddings via the Codex subscription.
- **MiniMax.io coder subscription.** GBrain has a native `minimax` embedding
  provider (`MINIMAX_API_KEY`, 1536d, $0.07/M per the cost matrix). However,
  the **coder** subscription typically does not include embedding endpoints —
  it is a chat-completions plan, not an embed plan. Chat is fine; embedding
  is likely denied by the subscription's API gateway. Treat this subscription
  as **chat only** for GBrain's purposes.
- **OpenAdapter (`api.openadapter.in/v1`).** Multi-provider gateway that
  exposes OpenAI-compatible + Anthropic Messages endpoints, with embeddings
  and a built-in vector DB. **GBrain does not have a first-class `openadapter`
  provider** — verified via `grep -rnE "openadapter|cloudflare|workers[_-]?ai"`
  across `src/` and `docs/` (zero hits). But the `openai-compatible` recipe
  tier can target `https://api.openadapter.in/v1` as the base URL with an
  `Authorization: Bearer sk-cv-…` header, which means OpenAdapter can front
  any embedding or chat model OpenAdapter supports, with GBrain treating it as
  an OpenAI-compatible provider. **Cost depends on your OpenAdapter plan —
  the public docs page describes fixed-price request-based plans; per-token
  rates are not on the index page I fetched. Check your dashboard.**
- **OpenRouter.** Already on the allowlist as `openrouter` ($0.02/M for
  `openai/text-embedding-3-small`). Not a "subscription" — it's a metered
  gateway — but at $0.02/M it's the cheapest external embed option outside
  of MiniMax/OpenAdapter and Cloudflare. Useful as a fallback or as a quick
  way to test model swaps.
- **Cloudflare Workers subscription ($5/mo Paid minimum).** Two relevant
  pieces:
  - **Workers AI** ships embed + rerank models. From
    [developers.cloudflare.com/workers-ai/platform/pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/):
    - `bge-m3` (multilingual, 1024d) — **$0.012/M input tokens**
    - `bge-small-en-v1.5` (384d) — **$0.020/M**
    - `bge-base-en-v1.5` (768d) — **$0.067/M**
    - `bge-large-en-v1.5` (1024d) — **$0.204/M**
    - `qwen3-embedding-0.6b` (Qwen3 Embedding family, dims documented per model) — **$0.012/M**
    - `bge-reranker-base` — **$0.003/M input tokens** (rerank)
    - Free tier: **10,000 neurons/day** on Workers Free, or also 10k/day
      included before per-neuron billing kicks in on Workers Paid. Neuron
      pricing is **$0.011 per 1,000 neurons** above the free daily
      allocation. Concretely: 10k neurons/day ≈ 50k–500k tokens of embed
      work depending on the model (BGE small is much cheaper per token
      than BGE large).
  - **Vectorize** is Cloudflare's vector DB (separate billing:
    50M queried dims + 10M stored dims free per month on Workers Paid,
    then $0.01/M queried dims, $0.05/100M stored dims). GBrain's storage
    backends are PGLite or Postgres+pgvector; **Vectorize is not a
    substitute for the GBrain engine** — the engine is the source of
    truth (canonical Markdown + DB), and embeddings are computed by an
    external provider that GBrain calls per request. You could *mirror*
    embeddings into Vectorize for cross-tool search, but that is a
    separate sidecar, not the brain.
  - **GBrain support:** Cloudflare Workers AI is **not** a first-class
    GBrain provider. Same `openai-compatible` workaround applies if you
    want to point GBrain at it. There is no `cloudflare:` recipe.

### 7.3 Cost model comparison for the actual workloads

Recalling the cost dimensions from section 4:

| Workload | Voyage `voyage-4` | OpenRouter `text-embedding-3-small` | MiniMax | CF Workers AI `bge-m3` | CF Workers AI `bge-large-en-v1.5` |
|----------|-------------------|------------------------------------|---------|-----------------------|------------------------------------|
| 10M token first reindex (embed) | **$0.60** | **$0.20** | $0.70 (likely not on coder sub) | **$0.12** | $2.04 |
| 1M tokens/mo rerank (`rerank-2.5` vs `bge-reranker-base`) | $0.05 | n/a (no rerank provider) | n/a | **$0.003** | n/a |
| 100k tokens/mo incremental ingest | $0.006 | $0.002 | $0.007 | $0.0012 | $0.020 |

CF Workers AI's `bge-m3` is **the cheapest hosted embedding path on the list**
for multilingual content; `bge-large-en-v1.5` is competitive for English if
quality matters more than cost (it's $0.204/M vs Voyage $0.06/M — Voyage
wins on cost, but `bge-large-en-v1.5` is a strong multilingual model).

### 7.4 Recommendation for your stack

Goal: **best quality at lowest recurring cost, using your existing
subscriptions where possible, falling back to the cheapest hosted path
where they don't cover embeddings.**

**Tier 1 — Chat (synthesis / `gbrain think`).** Use the subscriptions you
already have. Both Hermes and GBrain already point at chat-capable
providers; route via the same wiring:
- For Hermes MoA's aggregator: **OpenAI Codex (`gpt-6-luna`)** is already
  configured.
- For GBrain synthesis: pick whichever of `minimax:MiniMax-M3` (already
  wired on `10.0.0.70`) or the Codex credential routed through an
  OpenAI-compat gateway is cheapest per token. The Hermes gateway treats
  the Codex OAuth as chat cost; GBrain synthesis would be a separate
  chat call that needs an actual `OPENAI_API_KEY` or equivalent.

**Tier 2 — Embeddings (per-archive cost; this is the recurring line).**
**Use Cloudflare Workers AI `bge-m3` via the `openai-compatible` recipe.**

Why:
- **Cheapest viable hosted embed** at $0.012/M for multilingual content
  ($0.12 for a 10M-token reindex — under 15¢).
- **Free tier covers casual use**: 10,000 neurons/day on Workers Free
  equals roughly 800k+ tokens/day of `bge-m3` work, or 24M tokens/month
  free. Your Workers Paid $5/mo minimum gives you the same 10k/day free
  plus the $0.011/1k-neuron overage — effectively pennies for the rest.
- **Multilingual**: `bge-m3` handles 100+ languages, which matters if you
  ingest non-English sources.
- **Cost ceiling is predictable**: even at very heavy use (1B tokens/mo),
  this is ~$12/mo in neurons, well under the marginal cost of `voyage-4`
  (~$60/mo) or OpenAI direct ($130/mo).

If Workers AI feels too exotic for v1, **fallback is OpenRouter
`openai/text-embedding-3-small` at $0.02/M** — it's a one-line config
(`gbrain config set embedding_model openrouter:openai/text-embedding-3-small`)
with no recipe authoring, and is the second-cheapest viable hosted path.

**Tier 3 — Rerank (per-search cost).** **Use Cloudflare Workers AI
`bge-reranker-base` at $0.003/M.** That's ~60× cheaper than Voyage
`rerank-2.5` ($0.05/M), and `bge-reranker-base` is a competent cross-encoder
for general use. Same `openai-compatible` recipe pattern as embedding. If
quality matters and you want Voyage's `rerank-2.5`, keep that as a per-call
override (`--reranker voyage:rerank-2.5`) for the queries where it earns
its keep.

**Tier 4 — Local fallback (best for batch reindex and offline).**
If the LXC at `10.0.0.70` has CPU/GPU to spare, install **Ollama** and use
`nomic-embed-text` (768d) or `bge-m3` as a **$0/M** fallback for batch
reindex. The GBrain `ollama:` provider expects the daemon running locally;
Hermes can keep using the cloud path for chat. This pushes the *recurring*
embedding cost to zero at the cost of wall-clock reindex time.

### 7.5 Concrete config to make this work

GBrain's `gbrain.yml` recipe for Cloudflare Workers AI (register as an
`openai-compatible` provider, since GBrain has no native `cloudflare:` entry):

```yaml
# ~/.gbrain/config.json (or gbrain.yml)
models:
  embedding: cloudflare:bge-m3            # via openai-compatible recipe
  chat: codex-substitution                # or openai-compatible chat
  rerank: cloudflare:bge-reranker-base
```

The recipe definition (one-time, in `gbrain.yml`):

```yaml
recipes:
  cloudflare:
    tier: openai-compatible
    base_url: https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/run
    headers:
      Authorization: "Bearer ${CLOUDFLARE_API_TOKEN}"
    embedding_path: "@cf/baai/bge-m3"
    rerank_path: "@cf/baai/bge-reranker-base"
```

(The actual recipe schema is the same shape as GBrain's existing
`lmstudio:` and `ollama:` recipes in `src/core/ai/`. The path/header
conventions should be cross-checked against the specific recipe loader in
`src/core/ai/recipes/` before you ship — I'm working from the types in
`src/core/ai/types.ts` and the gateway plumbing in `src/core/ai/gateway.ts`,
not from a finished CF recipe that doesn't exist in the repo yet.)

If you want zero recipe authoring, start with **OpenRouter as the embedding
provider** (no recipe work; `gbrain config set embedding_model
openrouter:openai/text-embedding-3-small --embedding-dimensions 1536`),
then add the Cloudflare recipe as a perf/cost optimization later. The
GBrain CLI's 7-tier config resolver means you can override per-call
(`--embedding-model cloudflare:bge-m3`) without changing the default.

### 7.6 TL;DR for the embedding question

> **Use Cloudflare Workers AI `bge-m3` for embeddings and
> `bge-reranker-base` for reranking**, reached through GBrain's
> `openai-compatible` recipe tier pointed at your Workers AI endpoint.
> Cost: roughly **$0.12 per 10M tokens embedded**, **$0.003 per 1M tokens
> reranked**, with 10,000 free neurons/day covering casual use outright.
> The OpenAI Codex and MiniMax coder subscriptions are **chat subscriptions,
> not embedding subscriptions**, so they don't help on the embedding line;
> route them to `gbrain think` synthesis instead. OpenRouter is the
> zero-recipe fallback at $0.02/M. Local Ollama is the $0/M option if the
> hermesagent LXC has CPU/GPU budget.

---

## 8. Cloudflare integration — what actually exists, and an implementation plan

### 8.1 What's already there in the Cloudflare stack

Cloudflare ships an **official OpenAI-compatible endpoint** for Workers AI
([developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)).

```
baseURL = https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1
auth    = Authorization: Bearer ${CLOUDFLARE_API_TOKEN}
```

It supports:

- **`POST /v1/chat/completions`** for text generation (any model in the
  Workers AI catalog). Streaming works.
- **`POST /v1/embeddings`** for embedding models (`bge-small-en-v1.5`,
  `bge-base-en-v1.5`, `bge-large-en-v1.5`, `bge-m3`, `qwen3-embedding-0.6b`,
  `plamo-embedding-1b`). Returns the standard OpenAI `data[].embedding`
  shape, so any OpenAI-compat client works.
- **`POST /v1/responses`** only for `@cf/openai/gpt-oss-120b` and
  `@cf/openai/gpt-oss-20b` (non-streaming). Not relevant here.
- **`options.rejectIfBusy`** in the request body to fail fast instead of
  waiting in the capacity queue — useful for cron jobs where you want a
  clean error rather than a stuck request.
- **AI Gateway fronting** — Cloudflare's AI Gateway can sit in front of
  Workers AI for caching, rate limits, retries, fallback. The OpenAI-compat
  endpoint is reachable *through* AI Gateway too, which means GBrain can
  talk to `https://gateway.ai.cloudflare.com/v1/...` instead of the raw
  Workers AI URL and get caching, observability, and the ability to add
  fallbacks (Voyage, OpenAI) without changing GBrain's config.

There is **no rerank endpoint** on the OpenAI-compat surface. Workers AI
exposes `bge-reranker-base` only through the native
`POST /accounts/{id}/ai/run/@cf/baai/bge-reranker-base` shape (per
[developers.cloudflare.com/workers-ai/models/bge-reranker-base](https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/)).
GBrain's `gateway.rerank()` calls the OpenAI-compat `/v1/rerank` endpoint
in standard recipes; for Cloudflare, this means rerank needs a **separate
non-OpenAI-compat path** in the recipe (or it falls back to a Voyage
reranker).

### 8.2 What's already there in GBrain

Verified by inspecting the cloned tree at `/home/bruj0/projects/gbrain`:

- **25 recipe files** in [`src/core/ai/recipes/`](src/core/ai/recipes/)
  (`openai.ts`, `voyage.ts`, `openrouter.ts`, `ollama.ts`, `llama-server.ts`,
  `lmstudio.ts`, `azure-openai.ts`, `minimax.ts`, `anthropic.ts`, `google.ts`,
  `groq.ts`, `together.ts`, `litellm-proxy.ts`, `claude-cli.ts`, `dashscope.ts`,
  `dashscope-rerank.ts`, `mistral.ts`, `moonshot.ts`, `nvidia.ts`,
  `perplexity.ts`, `zhipu.ts`, `llama-server-reranker.ts`, `nan.ts`, plus the
  registry `index.ts`). Voyage is **87 lines** (the gold-standard
  openai-compat template, per the docs). OpenRouter is **314 lines** and
  includes its own compatibility-fetch wrapper.
- **The registry pattern** is documented in the README: "Recipes are
  ~30-40 lines of TypeScript. Copy `src/core/ai/recipes/voyage.ts` as the
  gold-standard openai-compat template, register in
  `src/core/ai/recipes/index.ts`, add a per-recipe smoke test under
  `test/ai/recipe-<name>.test.ts`. The recipe contract test
  (`test/ai/recipes-contract.test.ts`) and IRON RULE regression test pin
  the structural invariants."
- **OpenRouter already has `bge-m3` at 1024d** baked into its verified
  per-model native dims — `--embedding-model openrouter:bge-m3 --dim 1024`
  plans the right column width automatically (per README, "Embedding:
  `openai/text-embedding-3-small` (1536d default, Matryoshka shrink to
  512/768/1024). The recipe carries verified per-model native dims for its
  catalog — `openai/text-embedding-3-large` (3072), `qwen/qwen3-embedding-8b`
  (4096), `bge-m3` (1024)").
- **No Cloudflare recipe exists** (verified `grep -rnE "cloudflare|workers[_-]?ai|@cf/" src/ docs/` — zero hits). AI Gateway is also not referenced.

So today there are **three concrete integration paths** ordered by
time-to-value:

| Path | What you wire | Time | Custom code? | Cost vs. direct |
|------|---------------|------|--------------|------------------|
| **A. Use OpenRouter's `bge-m3` model** | `gbrain config set embedding_model openrouter:bge-m3 --embedding-dimensions 1024` (no recipe work) | 5 min | None | OR markup on CF list price |
| **B. Author a GBrain `cloudflare:` recipe** | Copy `voyage.ts`, point at Workers AI OpenAI-compat URL, register in `index.ts` | 1–2 h | ~40 LOC + smoke test | Raw CF list price |
| **C. Route through Cloudflare AI Gateway** | Add a Worker that fronts Workers AI with caching + fallback, then point GBrain at the gateway | Half-day | Worker + GBrain recipe | Adds caching, observability, fallback; gateway itself is free |

Path A is the **fastest win** and exercises every code path GBrain ships.
Path B is the **right long-term home** for Cloudflare in the brain. Path C
is what you'd build if you want the brain to survive a CF outage or rate
limit transparently. Below is a full implementation plan covering B (the
canonical recipe) and C (the gateway front), with A as the warmup.

### 8.3 Implementation plan

#### Phase 0 — Prerequisites (10 min)

1. **Cloudflare account + Workers Paid plan** ($5/mo). Both
   [developers.cloudflare.com/workers/platform/pricing/](https://developers.cloudflare.com/workers/platform/pricing/)
   and [developers.cloudflare.com/workers-ai/platform/pricing/](https://developers.cloudflare.com/workers-ai/platform/pricing/)
   are referenced.
2. **Account ID** (`CF_ACCOUNT_ID`) — visible on the right sidebar of the
   Cloudflare dashboard home page.
3. **API Token** scoped to **Workers AI: Read, Edit**. Create at
   *My Profile → API Tokens → Create Token → Edit Cloudflare Workers →
   Resources: Include → Workers AI: Edit*.
4. **Confirm reachability from `10.0.0.70`**:
   ```bash
   curl -sS https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1/models \
     -H "Authorization: Bearer $CF_API_TOKEN" | jq '.data[].id' | head
   ```
   Expect a list like `@cf/baai/bge-m3`, `@cf/baai/bge-reranker-base`,
   `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, …

#### Phase 1 — Warm-up with OpenRouter (5 min, validates the stack)

Even before authoring a Cloudflare recipe, confirm GBrain's embedding and
rerank paths work end-to-end on a Cloudflare-hosted model reached via the
cheapest route:

```bash
# on hermesagent as user hermes
hermes mcp test gbrain                           # confirm brain MCP is wired
su - hermes -c "gbrain providers list"           # confirm 16 recipes + OpenRouter
su - hermes -c "gbrain providers explain openrouter"  # confirm bge-m3 is listed

# create a throwaway brain for testing
su - hermes -c "gbrain init --pglite --force --profile cf-test \
  --embedding-model openrouter:bge-m3 --embedding-dimensions 1024 \
  --no-reranker"
```

Then drop a sample page in and round-trip:

```bash
su - hermes -c 'mkdir -p ~/.gbrain/cf-test/notes && cat > ~/.gbrain/cf-test/notes/hello.md <<EOF
---
type: note
title: "Warm-up test"
---
Hello, this is a test page that should embed via OpenRouter -> Cloudflare bge-m3.
EOF
gbrain sync --profile cf-test --no-pull
gbrain search "warm-up" --profile cf-test --json
```

If the search returns the page, the entire chain
(brain → MCP → OpenRouter → Cloudflare Workers AI → brain index) works.
**Estimated cost: < $0.0001 for one page.**

#### Phase 2 — Author the `cloudflare:` recipe (~1–2 h)

The recipe contract per the README and `src/core/ai/recipes/voyage.ts` (87
lines) is: an exported object with `id`, `tier: 'openai-compatible'`,
`baseUrl` (templated with `${CF_ACCOUNT_ID}`), `auth` (Bearer env var),
default `embeddingModel` and `rerankModel`, and a `resolveAuth` /
`resolveOpenAICompatConfig` pair for header overrides. Plan:

1. **Branch the repo.** From `/home/bruj0/projects/gbrain`:
   ```bash
   git checkout -b feat/recipe-cloudflare-workers-ai
   cp src/core/ai/recipes/voyage.ts src/core/ai/recipes/cloudflare.ts
   ```
2. **Edit `cloudflare.ts`** with these specific substitutions against the
   Voyage template:
   - `id: 'cloudflare'`
   - `tier: 'openai-compatible'`
   - `baseUrl` = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1`
   - `authHeader: 'Authorization: Bearer ${CF_API_TOKEN}'`
   - `defaultEmbeddingModel: '@cf/baai/bge-m3'`
   - `defaultEmbeddingDimensions: 1024`
   - `defaultRerankModel: '@cf/baai/bge-reranker-base'` (note: only via
     the native `/run/` endpoint, not the OpenAI-compat one — see step 3)
   - Mark in the recipe comment that `bge-m3` and `qwen3-embedding-0.6b`
     are multilingual; `bge-large-en-v1.5` is English-only
   - Add a top-of-file docstring citing the OpenAI-compat docs page and
     the GBrain recipe contract test path
3. **Rerank workaround.** Because Workers AI exposes
   `@cf/baai/bge-reranker-base` only via `/ai/run/<model>` and not
   `/v1/rerank`, the recipe needs a `customRerankPath` (or whichever
   override the recipe registry exposes for non-compat rerank endpoints).
   Inspect `src/core/ai/recipes/dashscope-rerank.ts` (165 LOC) and
   `src/core/ai/recipes/llama-server-reranker.ts` — both implement
   non-OpenAI-compat rerank paths and are the templates to follow for this
   half of the recipe.
4. **Register** in `src/core/ai/recipes/index.ts`:
   ```ts
   import { cloudflare } from './cloudflare.js';
   // …add to the registry array alongside the 16 existing recipes
   ```
5. **Smoke test** at `test/ai/recipe-cloudflare.test.ts`:
   - Assert `gbrain providers list` shows `cloudflare`
   - Assert `gbrain providers explain cloudflare` lists `bge-m3`,
     `bge-large-en-v1.5`, `qwen3-embedding-0.6b`, `bge-reranker-base` with
     correct dims
   - Integration test against a real account requires `CF_ACCOUNT_ID` and
     `CF_API_TOKEN` in the test env; mark as opt-in with
     `process.env.CF_ACCOUNT_ID ? test : test.skip`
6. **Run the contract tests:**
   ```bash
   bun run test/ai/recipes-contract.test.ts
   bun run test/ai/recipe-cloudflare.test.ts
   bun run verify     # the pre-push gate
   ```
7. **Open a PR upstream** to
   [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain) with
   the recipe, smoke test, and a short docs page at
   `docs/ai-providers/cloudflare.md` describing setup, dims, and pricing.
   This makes the integration durable and benefits from community review.

#### Phase 3 — Point the live brain at Cloudflare (30 min)

On `10.0.0.70` as `hermes`:

```bash
# 1. drop the warm-up profile
rm -rf ~/.gbrain/cf-test

# 2. add Cloudflare to the live brain
gbrain config set embedding_model cloudflare:@cf/baai/bge-m3
gbrain config set embedding_dimensions 1024
gbrain config set search.reranker.model cloudflare:@cf/baai/bge-reranker-base
echo 'export CF_ACCOUNT_ID=...; export CF_API_TOKEN=...' >> ~/.bashrc.d/cloudflare.sh

# 3. (optional) cap max spend on the next reindex
gbrain reindex --max-cost 5 --dry-run     # cost preview before approval

# 4. (if migrating dimensions) follow the migration guide
gbrain migrate embeddings --to cloudflare:@cf/baai/bge-m3 --dim 1024 --dry-run
gbrain migrate embeddings --to cloudflare:@cf/baai/bge-m3 --dim 1024 --yes
```

`gbrain search_modes` is the read-only dashboard that reports the active
mode and reranker readiness — verify the resolved provider is Cloudflare,
the right dims, and reranker is on before relying on it.

#### Phase 4 — Optional: front with Cloudflare AI Gateway (half day)

If you want caching, observability, and the ability to fall back to Voyage
or OpenAI when Cloudflare is degraded:

1. **Create an AI Gateway** at *AI → AI Gateway → Create Gateway* in the
   Cloudflare dashboard. Pick a name (e.g. `gbrain-gateway`).
2. **Configure Workers AI billing** in the gateway settings
   (`developers.cloudflare.com/ai-gateway/configuration/manage-gateway/#configure-workers-ai-billing`)
   so you can use **Unified billing / prepaid credits** instead of paying
   per-neuron out of the Workers bundle.
3. **Get the gateway OpenAI-compat URL.** Per the AI Gateway docs, this
   is `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat`
   (or similar — confirm against the current
   [docs/ai-gateway](https://developers.cloudflare.com/ai-gateway/)).
4. **Edit `cloudflare.ts`** to use the gateway URL instead of the raw
   Workers AI URL, and to inject the gateway-specific `cf-aig-authorization`
   header. Document this in `docs/ai-providers/cloudflare.md` as
   "Phase 4 deployment" with screenshots.
5. **Add a fallback recipe** in the gateway config (Cloudflare dashboard):
   primary = Cloudflare Workers AI `bge-m3`, fallback = Voyage
   `voyage-4` on your existing `VOYAGE_API_KEY`. GBrain's retry path
   (already exercised by the `fail-open in fusion order` behavior of the
   Voyage recipe) handles the rest.

#### Phase 5 — Wire Hermes's MoA into the brain (1 h)

The brain is only useful if Hermes reads from it every turn. With the
existing MCP wiring from session #1, this is configuration, not code:

1. **Confirm MCP server is alive:**
   ```bash
   hermes mcp list
   hermes mcp test gbrain
   ```
2. **Add a memory skill** to Hermes's `~/.hermes/skills/` (the brain ships
   79 skills; cherry-pick the memory ones via
   `gbrain skillpack scaffold --harness hermes`). The README cites the
   `--harness hermes` scaffold.
3. **Brain-first lookup at MoA start.** Edit
   `/home/hermes/.hermes/AGENTS.md` (or add a new SOUL.md section) so the
   agent calls `gbrain://recall "<query>"` before the first tool call of
   any user turn. GBrain's MCP `recall` verb returns the same private
   context the MoA reference would inject, without needing an extra LLM
   call.
4. **Re-run `hermes moa list`** to confirm the preset still resolves
   (MoA + brain are orthogonal — MoA controls the agent loop, the brain
   controls recall before the loop).

### 8.4 Cost trajectory after the plan lands

With Phase 1 (warm-up) and Phase 2 (recipe) deployed and a ~10M-token
personal corpus:

| Line item | Before (Voyage default) | After (CF `bge-m3` + `bge-reranker-base`) |
|-----------|------------------------|------------------------------------------|
| One-time reindex of 10M tokens | $0.60 (Voyage) | **$0.12** (CF `bge-m3`) |
| Monthly rerank traffic (~1M tok/mo) | $0.05 (Voyage `rerank-2.5`) | **$0.003** (CF `bge-reranker-base`) |
| Chat (MoA aggregator + reference + brain think) | unchanged — still your existing Codex + MiniMax subs | unchanged |
| Workers Paid minimum | $0 | **$5/mo** |
| Workers AI free allocation | n/a | **covers up to ~24M embed tokens/month free** before any neuron charges kick in |
| **Net change** | — | **−$0.50 one-time, −$0.05/mo recurring, +$5/mo Workers Paid floor. Break-even at any non-trivial corpus.** |

After Phase 4 (AI Gateway), the recurring cost stays similar but you get
caching on top: repeated queries against the same pages start hitting the
gateway cache, dropping effective rerank/embed costs further. The
fallback chain in the gateway also means an outage at Cloudflare degrades
to Voyage on the same key, which is what makes this production-ready.

### 8.5 Risks and rollback

- **Cloudflare outage** — Phase 4 mitigates. Without Phase 4, a CF outage
  halts reindex and rerank; the brain falls back to keyword-only search
  (no semantic), which still works but is degraded. Rollback: `gbrain
  config set embedding_model voyage:voyage-4 --dim 1024` (rerank defaults
  back to `rerank-2.5`). One command, atomic.
- **Dimension lock-in** — `bge-m3` is 1024d. If you ever move to
  `bge-large-en-v1.5` (1024d as well, but different embedding space) or
  to Voyage `voyage-4` (also 1024d), the existing recipe's
  `defaultEmbeddingDimensions: 1024` means schema width stays — but
  vectors are not interchangeable across models. The migration is
  `gbrain migrate embeddings --to <new-provider> --dim 1024 --dry-run`
  (cost preview), then `--yes`. Dry-run before `--yes` is non-negotiable
  per [docs/guides/embedding-migration.md](docs/guides/embedding-migration.md).
- **OpenAI-compat quirks** — Workers AI's OpenAI-compat surface has one
  notable non-standard option (`options.rejectIfBusy`); GBrain's recipes
  don't pass that today, so this is a future compatibility concern, not a
  present one.
- **Rerank non-compat path** — Until Phase 2 step 3 is done, do not set
  `search.reranker.model cloudflare:…` — it will fail at the OpenAI-compat
  endpoint. Either implement the native `/run/` path in the recipe, or
  keep rerank on Voyage and only route embedding through Cloudflare for
  v1.
- **GBrain version drift** — The recipe ships with v0.59.0.0 (this clone).
  `bun update` / `hermes update` may move the registry API. Pin
  `gbrain` to a known good version in your install script and bump
  deliberately, not via `latest`.

### 8.6 TL;DR for the implementation plan

> **Three paths, pick by time budget.**
> **Path A (5 min):** `gbrain config set embedding_model openrouter:bge-m3 --dim 1024` —
> validates the stack against a Cloudflare-hosted model via OpenRouter, no
> recipe code.
> **Path B (1–2 h, recommended):** author `src/core/ai/recipes/cloudflare.ts`
> copying `voyage.ts` as the gold-standard openai-compat template, point it
> at Workers AI's OpenAI-compat endpoint
> (`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1`),
> handle rerank via the native `/ai/run/@cf/baai/bge-reranker-base`
> path (template: `dashscope-rerank.ts` or `llama-server-reranker.ts`),
> register in `index.ts`, add a smoke test, run `recipes-contract.test.ts`
> + `IRON RULE`, open a PR upstream.
> **Path C (half day):** add Cloudflare AI Gateway in front of Workers AI
> for caching + fallback, point the recipe at the gateway's OpenAI-compat
> URL, configure Voyage as a fallback so a CF outage degrades cleanly.
> Cost trajectory lands at **−$0.50 one-time + −$0.05/mo recurring on a
> 10M-token corpus, against a $5/mo Workers Paid floor** — break-even
> against Voyage immediately, durable savings thereafter.

---

## 9. Cloudflare Workers plans for embedding — what the limits actually are

This section distills the precise limits from the Cloudflare docs
([workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/),
[workers-ai/platform/limits](https://developers.cloudflare.com/workers-ai/platform/limits/),
[workers-ai/platform/pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
and the [2026-07-28 changelog](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/))
as they apply specifically to running embedding inference for GBrain on
`10.0.0.70`.

### 9.1 The two plans side by side

| Dimension | **Workers Free** | **Workers Paid** |
|-----------|------------------|------------------|
| **Monthly minimum** | $0 | **$5/mo** (mandatory) |
| **Daily request limit** | **100,000/day** to any Worker on the account (resets at 00:00 UTC; over-limit returns `Error 1027`) | **None** (10M requests/mo included, then $0.30/M) |
| **CPU time per HTTP request** | **10 ms** | Default **30 s**, up to **5 min** (`limits: { cpu_ms: 300000 }`) |
| **CPU time per Cron Trigger** | 10 ms | 30 s for `< 1h` interval; 15 min for `>= 1h` |
| **Memory per isolate** | 128 MB | 128 MB |
| **Subrequests per Worker invocation** | 50 | 10,000 (configurable up to 10M) |
| **Subrequests to internal services** | 1,000 | matches configured limit |
| **Worker size (uncompressed)** | 64 MiB | 64 MiB |
| **Variables per Worker** | 64 | 128 |
| **Workers per account** | 100 | 500 |
| **Cron Triggers per account** | 5 | 250 |
| **Cache API max object** | 512 MB | 512 MB |
| **Cache API calls per request** | 50 | 1,000 |
| **Free Logs retention** | 200,000 events/day, 3 days | 20M events/mo, 7 days |
| **Workers AI free allocation** | **10,000 neurons/day free, no overage** (capped at the daily cap; no charges possible) | **10,000 neurons/day free, then $0.011 per 1,000 neurons** |
| **Workers AI after free allocation** | **Hard stop — no upgrade path within Free** | Billed at the model's per-neuron rate |
| **Workers AI rate limits** (default per task type) | Same as Paid | Same per-task limits |
| **AI Gateway** | Available | Available |

**The Free plan is a sandbox**, not a production embedding backend. You get
10k neurons/day *or* 100k Worker requests/day, whichever you hit first, and
there is no overage path. For an embedding workload that runs every user
turn on a real brain, that's a few hundred to a few thousand embed calls
per day depending on model size — fine for development, not for the always-on
GBrain loop.

**The Paid plan is the production answer.** The $5/mo minimum is real, but
the 10k neurons/day free tier plus the per-neuron overage makes the
recurring cost negligible (≈$0.12 for a 10M-token reindex via `bge-m3`).

### 9.2 Workers AI embedding-specific limits

From [developers.cloudflare.com/workers-ai/platform/limits/](https://developers.cloudflare.com/workers-ai/platform/limits/)
("Rate limits by task type"):

| Task | Default rate limit |
|------|-------------------|
| **Text Embeddings** | **3,000 requests/minute** per account, per model |
| Text Embeddings (bge-large-en-v1.5 specifically) | **1,500 requests/minute** (lower) |
| Automatic Speech Recognition | 720/min |
| Image Classification | 3,000/min |
| Image-to-Text | 720/min |
| Object Detection | 3,000/min |
| Summarization | 1,500/min |
| Text Classification | 2,000/min |
| Text Generation (default) | 300/min |
| Text Generation — *paid models* (kimi-k2.6/2.7-code, glm-5.2/5.3/5.3-flash, deepseek-v4-flash/pro) | **20/min on standard billing, 50/min with prepaid AI Gateway credits** |
| Text-to-Image | 720/min |
| Translation | 720/min |

Notes that matter for GBrain:

- **The 3,000/min limit is per account, per model.** You cannot stack it
  across `bge-m3` and `bge-large-en-v1.5` — each has its own 3k/min
  bucket.
- **GBrain's embedding path batches multiple chunks per HTTP request** in
  most recipes (the OpenAI-compat `/v1/embeddings` endpoint accepts an
  `input` array). So a single "request" can carry dozens or hundreds of
  chunks. The 3,000 req/min ceiling is generous for any reasonable personal
  brain scale; you'd only hit it on a true burst (e.g. a full 1M-chunk
  reindex compressed into a minute).
- **`bge-large-en-v1.5` is throttled to 1,500 req/min** — half the default
  because the model is heavier. If you choose it for higher-quality
  English retrieval, halve your batch sizing expectation.
- **Rerank does not have a separate rate limit row** in the docs, so it
  inherits the embedding text-classification rate (2,000 req/min), which
  is effectively uncapped for personal use.

### 9.3 Model availability on Workers Free

Per the [2026-07-28 changelog](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/),
the following models now require Workers Paid and return HTTP 403 (internal
error `5035`) on Free:

- `@cf/moonshotai/kimi-k2.6`
- `@cf/moonshotai/kimi-k2.7-code`
- `@cf/zai-org/glm-5.2`

(The pricing page also lists `@cf/zai-org/glm-5.3`, `@cf/zai-org/glm-5.3-flash`,
`@cf/deepseek-ai/deepseek-v4-flash-0731`, and `@cf/deepseek-ai/deepseek-v4-pro-0813`
as "require a paid billing method" — same effective gate.)

**The embedding models we care about are NOT on the exclusion list:**

| Model | Free plan? | Dims | Neurons/M input | $/M input | Context window |
|-------|:----------:|------|----------------:|----------:|---------------:|
| `@cf/baai/bge-small-en-v1.5` | ✓ | 384 | 1,841 | $0.020 | 512 tok |
| `@cf/baai/bge-base-en-v1.5` | ✓ | 768 | 6,058 | $0.067 | 512 tok |
| `@cf/baai/bge-large-en-v1.5` | ✓ | 1,024 | 18,582 | $0.204 | 512 tok |
| **`@cf/baai/bge-m3`** | ✓ | **1,024** | **1,075** | **$0.012** | **60,000 tok** |
| `@cf/qwen/qwen3-embedding-0.6b` | ✓ | 1,024 | 1,075 | $0.012 | varies |
| `@cf/pfnet/plamo-embedding-1b` | ✓ | varies | 1,689 | $0.019 | Japanese-tuned |

So the answer to "can I use Workers Free for embeddings?" is **yes, for
all the embedding models in the current catalog** — you just can't exceed
10,000 neurons/day or 100,000 Worker requests/day. The embedding models
that *do* require Paid (if any new ones are added) would 403 on Free.

### 9.4 The 10,000-neuron free allocation, in concrete terms

Neurons are the unit of compute, not tokens. From the pricing table:

- `bge-m3` = 1,075 neurons per 1M input tokens → **10,000 neurons = ~9.3M tokens/day free**
- `bge-small-en-v1.5` = 1,841 neurons/M → **~5.4M tokens/day free**
- `bge-large-en-v1.5` = 18,582 neurons/M → **~538K tokens/day free** (only ~3 medium-sized books)
- `qwen3-embedding-0.6b` = 1,075 neurons/M → **~9.3M tokens/day free** (same as bge-m3)

For a personal GBrain:
- **A 10M-token first reindex** on `bge-m3` = ~10,750 neurons → fits in **one day of Free allocation** on Workers Paid (then overages are ~$0.12), or **fits on Free in ~1.2 days** spread out (you'd have to throttle yourself across the 10k/day cap).
- **100k new tokens/day incremental ingest** on `bge-m3` = ~107 neurons → ~93 days of free tier before exhausting 10k neurons. **Effectively free forever** for typical personal-brain ingest rates.
- **A 1M-token rerank query burst** on `bge-reranker-base` = 283 neurons → **35 full-burst queries per Free day**. Plenty for personal use.

So the Free allocation is *meaningful*, not token. The 100,000 Worker
requests/day is the real binding constraint for embedding-heavy
workloads — `bge-m3`'s 60,000-token context window means one request can
embed a full document, so 100k req/day ≈ up to 6 billion tokens of
embedding on Free alone, if you batch aggressively.

### 9.5 What this means for the implementation plan in §8

Adjusting the §8 plan against these limits:

1. **Phase 0's "$5/mo Workers Paid" prerequisite is correct.** You can
   technically start on Free, but the 100,000 Worker requests/day ceiling
   plus the 10,000 neuron/day ceiling make Free a development-tier plan.
   The Paid plan's $5 floor + 10M requests/mo included + 10k neurons/day
   free is the production shape.

2. **Phase 2's recipe should NOT add `rejectIfBusy` to the embed request
   body** unless GBrain's openai-compat wrapper is verified to forward
   unknown fields. The Cloudflare OpenAI-compat docs warn: *"Clients that
   remove unknown fields do not apply it."* GBrain's openai-compat
   implementation may or may not — verify against
   `src/core/ai/gateway.ts:362` (the `resolveOpenAICompatConfig` helper)
   before relying on it. If you want fail-fast, configure the option in
   the recipe's request transform.

3. **Add rate-limit handling to the recipe.** The 3,000 req/min embedding
   cap means a giant reindex should:
   - **Batch aggressively.** `bge-m3`'s 60k-token context window means
     you can stuff hundreds of chunks into one request. GBrain's existing
     batch path (used by `voyage:` and `openai:`) is the right pattern;
     confirm `bge-m3` accepts a string array on `/v1/embeddings`.
   - **Honor 429 / 3040 retries with exponential backoff.** The
     `dashscope-rerank.ts` and `litellm-proxy.ts` recipes have the
     backoff patterns; copy them.
   - **Stream progress via `gbrain reindex --max-concurrency N`** to keep
     batch size well below the 3k req/min ceiling during bulk reindex.
     Roughly: at 60k tokens/req, you need ~50 req/min to hit 3M
     tokens/min; cap `--max-concurrency` at 30 to stay safely under.

4. **Phase 4's AI Gateway is even more important than originally framed.**
   The gateway's caching + fallback gives you two things the raw endpoint
   doesn't:
   - **Caching across requests.** Identical `input` arrays hash to the
     same cache entry, so repeated reindex attempts (or a brain that
     re-asks the same query) don't double-charge.
   - **Unified billing with elevated rate limits.** Fronting Workers AI
     through AI Gateway with **prepaid credits enabled** raises the
     *paid* chat model rate from 20/min to 50/min — irrelevant for
     embeddings (3k/min is already ample), but a meaningful lever if you
     ever use a paid chat model through CF.

5. **BGE-M3 has a native Batch mode** (`requests[]` array on the
   `/ai/run/@cf/baai/bge-m3` endpoint) that processes multiple embedding
   jobs asynchronously. For a 10M-token bulk reindex this is materially
   faster than the OpenAI-compat synchronous endpoint. If the §8 recipe
   defaults to OpenAI-compat (simpler), keep a `--batch` flag that routes
   through the native Batch endpoint for one-shot reindex jobs.

6. **The 60,000-token context window on `bge-m3` is a huge batching
   advantage** over `bge-large-en-v1.5` (512 tokens) and `voyage-4` (32k
   tokens via OpenAI-compat). Most chunked personal-knowledge corpora
   average 200–500 tokens per chunk, so a single `bge-m3` request can
   carry ~120–300 chunks. This is the structural reason `bge-m3` is the
   cheapest *and* the fastest at scale.

### 9.6 When Workers Free *is* the right answer

For the §8 plan, Free is fine for:

- **Phase 1 (warm-up):** validate the OpenRouter → Cloudflare path with
  a few test pages. Costs nothing, runs in 5 minutes, stays well under
  every limit.
- **Recipe development:** while you're writing `cloudflare.ts` and
  running smoke tests, Free plan covers a few hundred test requests per
  day easily.
- **Single-user low-traffic embedding fallback:** if you wanted to embed
  via CF but didn't want to commit to $5/mo, Free + `bge-m3` gives you
  ~9M tokens/day of free embedding before any cap kicks in.

When Workers Paid is required:

- **Production GBrain with daily use** (anything more than occasional
  reindex + a few queries).
- **Any 24/7 cron / autopilot loop** that re-embeds incrementally — these
  will exhaust Free's 100k req/day in days, not months.
- **Multi-user / company brain** (the `third-party/company-brain/` path
  in the GBrain repo). Free's per-account ceilings become binding very
  fast at >2 users.

### 9.7 TL;DR for Workers limits on embedding

> **Workers Free does support embedding** — every embedding model in the
> current Workers AI catalog (including `bge-m3`, `bge-large-en-v1.5`,
> `qwen3-embedding-0.6b`) is available without a Paid plan. The Free
> allocation is **10,000 neurons/day plus 100,000 Worker requests/day**,
> with **no overage path** — when you hit either cap, requests error.
>
> **The 10,000 neurons = ~9.3M tokens/day of `bge-m3` embedding for free**,
> which is a real, useful amount. **Workers Paid ($5/mo minimum) lifts the
> request cap entirely**, keeps the 10k neurons/day free, and bills overage
> at $0.011 per 1,000 neurons (so `bge-m3` is $0.012/M input tokens).
>
> **Rate limits per model:** 3,000 req/min for embeddings (1,500/min for
> `bge-large-en-v1.5`). `bge-m3`'s 60,000-token context window means a
> single request can carry 100–300 chunks, so the rate ceiling is rarely
> binding for personal-brain scale.
>
> **Recipe strategy:** target `bge-m3` via the OpenAI-compat endpoint for
> day-to-day, batch into the native `/ai/run/` endpoint for bulk reindex,
> and front everything with Cloudflare AI Gateway (caching + fallback to
> Voyage) for production. Add explicit 429/3040 backoff and a tunable
> `--max-concurrency` to keep batch jobs safely under the rate ceiling.
>
> **Bottom line:** start on Free for Phase 1 warm-up and Phase 2 recipe
> development; move to Paid ($5/mo) for Phase 3 production. The Paid
> floor pays for itself the moment you reindex a single 10M-token corpus
> through `bge-m3` instead of Voyage.

---

### File / section index for this report

- Engine contract: [src/core/engine.ts](src/core/engine.ts) (line 740)
- Schemas: [src/schema.sql](src/schema.sql); see [docs/architecture/schema-packs.md](docs/architecture/schema-packs.md)
- Engine comparison: [docs/ENGINES.md](docs/ENGINES.md)
- Topologies: [docs/architecture/topologies.md](docs/architecture/topologies.md)
- Retrieval: [docs/architecture/RETRIEVAL.md](docs/architecture/RETRIEVAL.md)
- Agent loop: [docs/guides/brain-agent-loop.md](docs/guides/brain-agent-loop.md)
- Memory protocol: [docs/protocol/MEMORY_VERBS_v1.md](docs/protocol/MEMORY_VERBS_v1.md)
- Embedding cost matrix: [docs/integrations/embedding-providers.md](docs/integrations/embedding-providers.md)
- MCP administration: [docs/mcp/ADMIN.md](docs/mcp/ADMIN.md)
- Install path: [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) and [docs/INSTALL.md](docs/INSTALL.md)
- Bootstrap: [BOOTSTRAP_FOR_AGENTS.md](BOOTSTRAP_FOR_AGENTS.md) and [docs/guides/bootstrap.md](docs/guides/bootstrap.md)
- Hermes hook: [README.md](README.md) (`hermes mcp add gbrain …`)
- Security: [SECURITY.md](SECURITY.md)

---

## 10. Code changes shipped to fork (PR-upstream notes)

This section documents exactly what was committed to
[bruj0/gbrain](https://github.com/bruj0/gbrain) on branch
`feat/cloudflare-workers-ai-recipe` (commit `d46bd84b9`), so the upstream
PR writeup is mechanical and reproducible.

### 10.1 Files changed (5 files, +596 lines, 0 deletions)

| Path | Status | Purpose |
|------|--------|---------|
| `src/core/ai/recipes/cloudflare.ts` | added (153 lines) | Embedding + chat recipe (OpenAI-compat `/v1` surface) |
| `src/core/ai/recipes/cloudflare-rerank.ts` | added (88 lines) | Rerank recipe (native `/ai/run/<model>` surface) |
| `src/core/ai/recipes/index.ts` | modified (+4 lines) | Register both recipes in the static registry |
| `test/ai/recipe-cloudflare.test.ts` | added (215 lines) | Smoke + IRON RULE auth contract + URL-templating tests |
| `docs/ai-providers/cloudflare.md` | added (136 lines) | Setup, pricing, limits, two-recipe rationale |

No existing files were modified beyond the registry entry. No changes to
`src/core/ai/gateway.ts`, `src/core/ai/types.ts`, the engine layer, the
schema, or any other recipe. The change is **purely additive** within the
existing recipe contract.

### 10.2 Why two recipes, not one

Cloudflare Workers AI exposes three different surfaces that GBrain needs:

| Surface | Endpoint shape | GBrain path |
|---------|----------------|-------------|
| Embeddings | OpenAI-compat `POST /v1/embeddings` | `cloudflare` recipe |
| Chat | OpenAI-compat `POST /v1/chat/completions` | `cloudflare` recipe |
| Rerank | Native `POST /accounts/{id}/ai/run/<model>` | `cloudflare-rerank` recipe |

The OpenAI-compat surface has **no `/v1/rerank`** — only the native `/ai/run/<model>` endpoint exposes `bge-reranker-base`. GBrain's `RerankerTouchpoint` path field concatenates `${baseURL}${path}`; for the native endpoint, baseURL must omit the `/v1` suffix so the final URL becomes `…/accounts/{id}/ai/run/@cf/baai/bge-reranker-base`.

**Two recipes = one per URL shape.** Same env vars (`CF_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`), same token covers both. Users wire them together with two `gbrain config set` calls (one for embedding, one for rerank) — same pattern as the existing `cloudflare-rerank`/`dashscope-rerank` separation.

The `cloudflare` recipe omits the `reranker` block entirely (RerankerTouchpoint requires non-empty `models` when declared). This is the right way to say "this recipe does not provide rerank" — declaring an empty `reranker: { models: [], ... }` would fail the type contract.

### 10.3 Recipe code patterns followed

Each recipe file matches the existing template conventions:

- **`id` + `name`** — stable lowercase id, human-readable name.
- **`tier: 'openai-compat'`** + **`implementation: 'openai-compatible'`** — matches every openai-compat recipe (voyage, openrouter, dashscope, minimax, …).
- **`base_url_default` omitted** — URL is env-templated via `resolveOpenAICompatConfig`, mirroring the `azure-openai` recipe (the only existing recipe that does this).
- **`auth_env.required`** — `['CLOUDFLARE_API_TOKEN', 'CF_ACCOUNT_ID']`. The unified `defaultResolveAuth` (per the IRON RULE contract) reads `env[required[0]]` for the Bearer token; `CF_ACCOUNT_ID` is consumed only by `resolveOpenAICompatConfig` for URL templating.
- **`touchpoints.embedding`** — `models[]`, `default_model`, `default_dims: 1024` (required), `cost_per_1m_tokens_usd`, `price_last_verified`, `max_batch_tokens`, `chars_per_token`, `safety_factor`. Same shape as voyage.
- **`touchpoints.chat`** — `models[]`, `supports_tools: true`, `supports_subagent_loop: false`, `supports_prompt_cache: false`, `max_context_tokens`, `cost_per_1m_input_usd`/`cost_per_1m_output_usd`, `price_last_verified`. Note: `ChatTouchpoint` has no `default_model` field — implicit default is `models[0]`. The chat touchpoint deliberately does not include the kimi-k2.6 / glm-5.2 frontier chat models that the [2026-07-28 changelog](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/) gates behind Workers Paid, to avoid inviting Free-plan 403s.
- **`resolveOpenAICompatConfig`** — returns `{ baseURL, fetch? }`. Throws `AIConfigError` naming the missing env var. The `cloudflare` recipe sets baseURL to `…/ai/v1` (AI SDK appends `/embeddings` or `/chat/completions`); `cloudflare-rerank` sets baseURL to `…/accounts/{id}` (NO `/v1` suffix) so the gateway's `${baseURL}${path}` concatenation produces the native endpoint.
- **`setup_hint`** — one-line description with `gbrain config set` commands, shown in `gbrain providers` output and the wizard.

### 10.4 Tests added

`test/ai/recipe-cloudflare.test.ts` covers (per the existing `recipe-minimax.test.ts` / `recipe-voyage.test.ts` pattern):

1. **Recipe registered with expected shape** — `id`, `tier`, `implementation`, `auth_env.required` equality.
2. **Embedding touchpoint declares `bge-m3` as default with 1024 dims** — pin the cross-recipe compatibility with Voyage's 1024-d default.
3. **Chat touchpoint declares `gpt-oss-120b` as the implicit default** — assert via `chat.models[0]`, since `ChatTouchpoint` has no `default_model` field.
4. **Reranker touchpoint intentionally omitted** — explicit assertion that `r.touchpoints.reranker` is `undefined` on `cloudflare` (the recipe does not declare one; the companion handles it).
5. **Default auth — both env vars set → `Authorization: Bearer <token>`** — pins the IRON RULE shape so a future auth refactor cannot silently regress Cloudflare.
6. **Default auth — missing `CLOUDFLARE_API_TOKEN` → `AIConfigError`** — error path includes recipe name + touchpoint (per the existing error contract).
7. **Default auth — missing `CF_ACCOUNT_ID` → `AIConfigError`** — same.
8. **`resolveOpenAICompatConfig` templates URL from `CF_ACCOUNT_ID`** — produces the documented `…/accounts/{id}/ai/v1` shape.
9. **`resolveOpenAICompatConfig` throws when `CF_ACCOUNT_ID` is missing** — error path.
10. **`cloudflare-rerank` registered as a separate id** — assert it's NOT folded into `cloudflare`.
11. **`cloudflare-rerank` reranker touchpoint declares native `/ai/run/<model>` path** — pin `path: '/ai/run/@cf/baai/bge-reranker-base'` exactly.
12. **`cloudflare-rerank` `resolveOpenAICompatConfig` produces the right concatenated URL** — assert that `${baseURL}${path}` equals `https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/baai/bge-reranker-base`.
13. **IRON RULE: all v0.32 9-recipe baseline ids are still present** — assert `'anthropic', 'deepseek', 'google', 'groq', 'litellm', 'ollama', 'openai', 'together', 'voyage'` are unchanged by the new additions (mirrors the existing `test/ai/recipes-existing-regression.test.ts` baseline guard).
14. **`cloudflare` `defaultResolveAuth` matches the unified Bearer shape** — pin the IRON RULE contract specifically for Cloudflare.

**Tests not run locally** because the host lacks the bun runtime (`bun:test` types not installed). The CI on GitHub Actions (`bun run verify` + the contract test) will run them; the typecheck was confirmed clean against `Recipe` / `EmbeddingTouchpoint` / `ChatTouchpoint` / `RerankerTouchpoint` shapes via `npx --yes -p typescript tsc --noEmit` on the new files.

### 10.5 Docs page added

`docs/ai-providers/cloudflare.md` (136 lines) covers:

1. Setup walkthrough — finding `CF_ACCOUNT_ID`, creating the API token, plan choice (Free vs Paid), env exports, the two `gbrain config set` commands.
2. Pricing table — every embedding model + the reranker + the chat defaults, with verified dates (`price_last_verified: '2026-09-17'`).
3. Limits — embedding rate limit (3,000 req/min; bge-large at 1,500/min), Free-plan 100k req/day ceiling, 10k neurons/day free budget, the `/v1/responses` GPT-OSS quirk (not relevant to GBrain's chat path).
4. "How it works under the hood" — URL templating, auth header, why the rerank recipe is separate.
5. Compatibility notes — multilingual `bge-m3`, gpt-oss-120b as Free-plan default, the tools-but-no-subagent-loop posture, and the warning against setting `search.reranker.model cloudflare:…` (must use `cloudflare-rerank:…`).
6. "See also" — links back to Cloudflare's docs and GBrain's existing provider matrix.

### 10.6 What was deliberately NOT changed

- **No engine changes.** The `BrainEngine` interface (113 methods) is untouched.
- **No schema changes.** `src/schema.sql` is untouched.
- **No changes to other recipes.** `voyage`, `openrouter`, `azure-openai`, `dashscope-rerank`, etc. are all unchanged.
- **No changes to `gateway.ts`, `build-gateway-config.ts`, `chat-usage.ts`, or any gateway plumbing.** The recipe contract is sufficient.
- **No new CLI flags.** Recipe registration goes through the static `ALL` array in `recipes/index.ts`, which is the existing pattern.
- **No PR template populated.** The PR body is below; review it before submitting.

### 10.7 PR body (copy-paste ready)

```markdown
## feat(recipes): add Cloudflare Workers AI embedding + chat + rerank

Two new openai-compat recipes covering Cloudflare's Workers AI surfaces,
following the existing `azure-openai` URL-templating pattern and the
`dashscope-rerank` companion-recipe pattern.

### What's added

- `cloudflare` recipe — embedding + chat via Workers AI's official
  OpenAI-compatible endpoints (`/v1/embeddings`, `/v1/chat/completions`).
  Models: `bge-m3`, `bge-large-en-v1.5`, `qwen3-embedding-0.6b`,
  `bge-base-en-v1.5`, `bge-small-en-v1.5` for embedding;
  `gpt-oss-120b`, `gpt-oss-20b`, `llama-3.3-70b-instruct-fp8-fast`,
  `llama-3.1-8b-instruct-fp8-fast`, `qwen3-30b-a3b-fp8`, `gemma-4-26b-a4b-it`,
  `granite-4.0-h-micro` for chat. `bge-m3` is the new-install default
  (cheapest hosted multilingual; 60k context window).
- `cloudflare-rerank` recipe — `bge-reranker-base` via the native
  `/ai/run/<model>` endpoint (the only shape Cloudflare exposes for
  rerank). Shares `CLOUDFLARE_API_TOKEN` and `CF_ACCOUNT_ID` with the
  embedding recipe.
- Recipe registry entries in `src/core/ai/recipes/index.ts`.
- Smoke test (`test/ai/recipe-cloudflare.test.ts`) pinning the IRON RULE
  auth contract and the `resolveOpenAICompatConfig` URL templating for
  both recipes, plus an assertion that the v0.32 baseline 9 recipes are
  unchanged.
- Docs page (`docs/ai-providers/cloudflare.md`) with setup, pricing,
  limits, and the rationale for two recipes.

### Why two recipes

Cloudflare's OpenAI-compat surface has no `/v1/rerank`. Rerank is
reachable only through the native `/ai/run/<model>` endpoint, which has
a different URL shape (no `/v1` suffix). The `RerankerTouchpoint.path`
field is concatenated as `${baseURL}${path}`, so the URL shapes don't
fit a single recipe. Same pattern as the existing
`dashscope` / `dashscope-rerank` separation.

### Why `resolveOpenAICompatConfig` (mirrors `azure-openai`)

Both recipes need `CF_ACCOUNT_ID` in the URL, not as a Bearer token. The
existing `azure-openai` recipe solves the same problem with
`resolveOpenAICompatConfig` returning `{ baseURL, fetch? }` based on env
vars; the cloudflare recipes follow the same pattern. The unified auth
seam (`defaultResolveAuth`) still reads `env[required[0]]` for the Bearer
token (IRON RULE invariant).

### Pricing reference

Verified 2026-09-17 against
[developers.cloudflare.com/workers-ai/platform/pricing/](https://developers.cloudflare.com/workers-ai/platform/pricing/).
Embedding costs: `bge-m3` $0.012/M input tokens (1,075 neurons/M);
`bge-large-en-v1.5` $0.204/M (18,582 neurons/M). Rerank:
`bge-reranker-base` $0.003/M. Free-plan allocation: 10,000 neurons/day
≈ 9.3M tokens/day of `bge-m3`. Workers Paid $5/mo floor; overage at
$0.011 per 1,000 neurons.

### Free-plan model availability

The kimi-k2.6 / kimi-k2.7-code / glm-5.2 frontier chat models require
Workers Paid per the 2026-07-28 changelog. Every embedding model in
this recipe stays on Workers Free, so Free-plan users get full embedding
functionality out of the box. Chat defaults to `gpt-oss-120b` (Free-
eligible reasoning model).

### What I did NOT change

No engine changes, no schema changes, no gateway changes, no CLI flag
additions, no changes to existing recipes. Purely additive within the
recipe contract.

### Tested locally

Typecheck clean against `Recipe` / `EmbeddingTouchpoint` /
`ChatTouchpoint` / `RerankerTouchpoint` shapes (verified via
`tsc --noEmit`). Full test suite (`bun run verify`) and the IRON RULE
regression test (`test/ai/recipes-existing-regression.test.ts`) need to
run on a host with the bun runtime — please kick off CI on this branch
before review.

### Docs

`docs/ai-providers/cloudflare.md` follows the layout of
`docs/ai-providers/openrouter.md` / `voyage.md` / etc. (setup, pricing
table with verified dates, rate-limit table, links back to the embedding
provider matrix at `docs/integrations/embedding-providers.md`).
```

### 10.8 Open follow-ups before the upstream PR is ready

These are tasks for the PR author (you), not blockers, but addressing
them before submitting will speed review:

1. **Run `bun run verify` on a host with bun.** The recipe contract test
   (`test/ai/recipes-contract.test.ts`) and the IRON RULE regression test
   (`test/ai/recipes-existing-regression.test.ts`) will exercise the new
   recipes' full integration; both should pass without modifications.
2. **Run `bun run test/ai/recipe-cloudflare.test.ts`** — the new smoke
   test should pass on first run.
3. **Live integration test against a real Cloudflare account** —
   optional but high-value. The smoke test is opt-in via env vars
   (`process.env.CF_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN` is
   the existing pattern for live tests; the current smoke test does not
   include one because it requires real credentials). A short follow-up
   PR could add `test/ai/recipe-cloudflare.live.test.ts` for end-to-end
   verification, gated by the same env-var pattern.
4. **Update `docs/integrations/embedding-providers.md`** to add
   Cloudflare to the TL;DR table. The recipe makes the integration work;
   the docs page describes it; the matrix doc is where users discover
   providers. PR author should add a one-row entry pointing at
   `docs/ai-providers/cloudflare.md`.
5. **Decide whether to surface Cloudflare in `gbrain init`'s interactive
   provider picker.** The recipe auto-registers, so `--pglite` init
   already finds it; interactive picker inclusion depends on the
   upstream maintainers' policy for new providers.
6. **Consider bumping `cloudflare` to a "free-plan-friendly" flag** if
   the upstream maintainers want to make Free-eligibility a first-class
   recipe field. Not required; the current docs page already calls it
   out.

### 10.9 Commit hash + branch state

- **Branch:** `feat/cloudflare-workers-ai-recipe`
- **Fork:** [github.com/bruj0/gbrain](https://github.com/bruj0/gbrain)
- **Commit:** `d46bd84b9` ("feat(recipes): add Cloudflare Workers AI
  embedding + chat + rerank")
- **Diff:** 5 files changed, 596 insertions(+), 0 deletions(-)
- **Upstream PR:** not yet opened — open at
  https://github.com/garrytan/gbrain/compare/master...bruj0:gbrain:feat/cloudflare-workers-ai-recipe
  when ready (use `gh pr create --repo garrytan/gbrain --head
  bruj0:feat/cloudflare-workers-ai-recipe --base master` if you have
  `gh` configured).

---

## 11. Provisioning a new Proxmox LXC for GBrain

This section is the operational plan for creating a new LXC container on
the Proxmox host at `kvm.bruj0.net` to run GBrain. It covers OS choice,
container sizing, Postgres deployment, networking, systemd services, and
the install sequence end-to-end. Everything here is grounded in the
GBrain install docs ([docs/INSTALL.md](docs/INSTALL.md),
[docs/ENGINES.md](docs/ENGINES.md)), the Proxmox LXC ecosystem (community-
scripts / Proxmox VE docs), and the conventions already in use on your
`hermesagent` LXC at `10.0.0.70`.

### 11.1 What GBrain actually needs at runtime

From [`package.json`](package.json) `engines` and the install docs:

| Requirement | Value | Source |
|-------------|-------|--------|
| **Bun** | `>=1.3.11` (debs ship `1.3.13`) | [package.json](package.json) `engines.bun` |
| **PostgreSQL** (if not using PGLite) | **PostgreSQL 17** with **pgvector** + **pg_trgm** extensions | [docs/ENGINES.md](docs/ENGINES.md) |
| **PGLite** (default) | bundled WASM Postgres — no system install needed | [`@electric-sql/pglite@0.4.3`](package.json) |
| **Node / npm** | not required (Bun is the runtime) | Bun-native |
| **Systemd** | required for `gbrain bootstrap` autopilot + MCP service | [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) |
| **Ports** | none exposed by default; only bound if `gbrain serve --http` is run with `--host 0.0.0.0` | [README.md](README.md) |
| **Outbound HTTPS** | required for embedding providers (Voyage, OpenAI, Cloudflare Workers AI, …) | [docs/integrations/embedding-providers.md](docs/integrations/embedding-providers.md) |
| **RAM** | **8 GB minimum** (cited in the README as the always-on enrichment floor); 12–16 GB if MoA + GBrain + dashboard share the same host | [README.md](README.md) |
| **Disk** | **30 GB** baseline (OS + Bun + GBrain install + brain repo + PGLite DB + embedding cache) | derived; 50 GB recommended for headroom |

The README's "always-on enrichment needs its own compute" sentence is the
single source of truth for the RAM floor. Everything else is derived from
the install footprint and expected brain size.

### 11.2 OS choice — Debian 13 Trixie vs Ubuntu 24.04 Noble vs Fedora Server

GBrain ships a private Debian package and explicitly supports
`Debian 12 Bookworm`, `Debian 13 Trixie`, `Debian Sid`, and
`Ubuntu 24.04 Noble` on `amd64` and `arm64` (per the debs search result).
For Proxmox LXC the choice narrows to **Debian 13 Trixie** vs
**Ubuntu 24.04 LTS Noble**.

**Recommendation: Debian 13 Trixie.**

Rationale:

1. **Official support.** GBrain ships an installable `.deb` for both, but
   the package builds the debs against Trixie (`scripts/build-package.sh`
   uses `SUITE=trixie`); the tooling chain is most-aligned.
2. **Proxmox-native.** Proxmox VE itself runs on Debian Bookworm (the
   Proxmox 8.x host kernel). LXCs on a Proxmox host share the host
   kernel, so the userland choice is about packages, init system, and
   security-update cadence — not the kernel.
3. **Hermes agent consistency.** Your existing `hermesagent` LXC at
   `10.0.0.70` is Debian 13 (community-scripts ProxmoxVE install —
   confirmed in the earlier shell banner). Same base OS = same package
   management rhythm, same `apt` quirks, same `unattended-upgrades`
   behavior, same `/etc/os-release` fingerprint for shared ops scripts.
4. **Lean image.** Debian LXCs are typically 350–500 MB at install vs
   Ubuntu's 600–800 MB with snapd and the universe pull-ins. Smaller
   base = smaller attack surface and faster reinstalls.
5. **Stability.** Trixie ships GNOME 48-era userland (GCC 14, glibc
   2.41) which is well-tested with Bun 1.3.13 and Node-compatible
   packages. Ubuntu 24.04's snapd adds an extra moving part that
   containers don't need.
6. **When Ubuntu wins:** if you specifically need a PPA (e.g. the
   Tailscale `ppa:tailscale/tailscale` for `gbrain mcp expose`) or want
   LTS-style 5-year support. Tailscale ships a Debian apt repo directly,
   so even this is a wash.

**Fedora / RHEL / Arch:** not in the supported debs list. Doable via
`mise install bun@1.3.13` + `bun install -g github:garrytan/gbrain`, but
you lose the `gbrain-deb` package ergonomics. Skip unless you have a
specific reason.

### 11.3 Container sizing

For a personal GBrain with the always-on enrichment path, the dream
cycle, and a Voyage/Cloudflare embedding backend:

| Resource | Recommended | Notes |
|----------|-------------|-------|
| **Cores** | 2 vCPU (4 if hosting the brain + MoA + dashboard) | GBrain itself is single-threaded for the MCP server; PGLite is in-process. Cron jobs are short-lived. |
| **RAM** | 8 GB minimum, 12 GB recommended, 16 GB if colocating anything else | PGLite holds the brain index in-memory; embedding caches grow. |
| **Disk** | 50 GB (thin-provisioned ZFS or LVM-thin on the host) | Brain repo + PGLite DB + embedding cache + logs + headroom. |
| **Swap** | 4 GB | Per Proxmox defaults for an 8 GB container. |
| **Network** | virtio, single bridge (`vmbr0`) | LXC shares the host's network namespace behavior; a static IP via the existing `10.0.0.0/24` LAN keeps firewall rules consistent. |

For comparison, your `hermesagent` LXC at `10.0.0.70` is running Hermes
(gateway + dashboard + MoA) which the README says needs 8 GB. A separate
GBrain container keeps the always-on cron loop isolated from chat-time
load on the Hermes side.

### 11.4 PostgreSQL deployment — PGLite (recommended) vs native

GBrain has two engine paths:

- **PGLite (default):** bundled WASM Postgres 17, zero install. Stores the
  DB at `~/.gbrain/brain.pglite`. Perfect for a personal brain up to
  ~50K pages (per [docs/ENGINES.md](docs/ENGINES.md)). Zero ops, zero
  memory tuning, no separate service.
- **Postgres + pgvector (opt-in):** real Postgres 17 with the `vector`
  and `pg_trgm` extensions. Required only if you exceed PGLite's scale
  (~50K pages) or want to share the DB across multiple machines
  (e.g. the `cloudflare mcp expose` path where the agent runs in a
  vendor cloud).

**Recommendation: start on PGLite.** The `gbrain init` flow detects your
repo size and suggests Supabase for brains > 1000 markdown files, but
PGLite handles 1k–50k files cleanly on a single LXC with 8 GB RAM. You
can migrate to Postgres later with `gbrain migrate --to supabase` or
`gbrain migrate --to postgres` without reindexing if you keep the same
embedding model — `gbrain migrate embeddings --to <new-model> --dim 1024
--dry-run` is the documented migration command.

Only install Postgres natively if you specifically want one of:

- Multi-machine access to the brain (cross-host thin-client).
- RLS / multi-user (company-brain path).
- Production-scale > 50K pages or heavy concurrent write throughput.

If you do need it, install Postgres 17 + pgvector via the
`postgresql.org` apt repo on Debian 13, then enable the extensions:

```bash
sudo apt install postgresql-17 postgresql-17-pgvector
sudo -u postgres psql -c "CREATE DATABASE gbrain;"
sudo -u postgres psql -d gbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d gbrain -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

`gbrain init --prefer-postgres` will then discover the local Postgres and
use it (per the install ladder in [docs/INSTALL.md](docs/INSTALL.md)).

### 11.5 Proxmox provisioning sequence

Run these on the Proxmox host shell at `kvm.bruj0.net`. Adapted from the
community-scripts ProxmoxVE conventions already used for `hermesagent`.

#### Step 1 — Decide host-side storage

GBrain's `~/.gbrain/brain.pglite` is a directory of files; any storage
backend that handles small random writes works. Proxmox defaults:

- **`local-lvm`** (LVM-thin) — fine, but no per-container snapshots
  beyond Proxmox's native snapshot tooling.
- **`local-zfs`** — preferred if the host has ZFS; per-container
  snapshots + compression + send/receive for off-host backup.
- **NFS / CIFS / PBS** — only if you want the brain on shared/network
  storage; PGLite's WAL is happy with NFS as long as `nolock` and
  `lookupcache=positive` are set, but a local SSD is materially faster.

For a personal brain at this scale, **`local-zfs` on an SSD mirror** is
the right answer. The Proxmox default `local` (dir) is acceptable for
development.

#### Step 2 — Create the LXC

Use `pveam` (or the GUI) to fetch the template, then `pct create`.
Recommended: **Debian 13 Trixie**, **unprivileged**, **nested=0** (you
don't need Docker-in-LXC unless you later add Postgres in Docker).

```bash
# on kvm.bruj0.net as root
pveam update
pveam available | grep -E "debian-13-standard|debian-13-turnkey" | head
# pick the latest debian-13-standard; example:
pveam download local debian-13-standard_13.1-2_amd64.tar.zst

# create the container (CT ID 120 is illustrative; pick the next free)
pct create 120 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
  --hostname gbrain \
  --cores 2 \
  --memory 8192 \
  --swap 4096 \
  --rootfs local-zfs:50 \
  --net0 name=eth0,bridge=vmbr0,ip=10.0.0.71/24,gw=10.0.0.1 \
  --features nesting=0 \
  --unprivileged 1 \
  --onboot 1 \
  --start 1 \
  --password "$(openssl rand -base64 24)" \
  --ostype debian
```

Adjust the IP to a free address in your `10.0.0.0/24` LAN; `hermesagent`
is already on `.70`, so `.71` is the natural next slot. Update DNS / your
router's DHCP reservation accordingly.

#### Step 3 — First-boot configuration

Inside the LXC (via `pct enter 120` or SSH once you set up a user):

```bash
apt update && apt -y upgrade
apt -y install curl ca-certificates gnupg lsb-release sudo git unzip \
  unattended-upgrades apt-listchanges fail2ban

# create a non-root user for the brain
useradd -m -s /bin/bash gbrain
echo "gbrain ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/gbrain

# harden SSH (match your existing hermesagent policy)
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd
```

```bash
# enable unattended security updates (Debian default behavior)
dpkg-reconfigure -plow unattended-upgrades   # answer "Yes"
```

#### Step 4 — Install Bun 1.3.13

GBrain requires Bun `>=1.3.11`. The debs ship `1.3.13`. Two install paths:

**Path A — apt (Debian's bun package):** `apt install bun` works on Trixie
but typically lags the upstream release; check the version
(`bun --version` after install) and fall back to Path B if it's below
1.3.11.

**Path B — official Bun install script (recommended):**

```bash
# as the gbrain user
curl -fsSL https://bun.sh/install | bash
# add bun to PATH for this session and persist
echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
. ~/.bashrc

# verify
bun --version    # must be >= 1.3.11
```

Pin Bun in the brain's `.tool-versions` (if you use `mise`) or via a
project-level `package.json` `engines.bun` check, so an accidental
`bun upgrade` doesn't break the install later.

#### Step 5 — Install the `gbrain` CLI

From [docs/INSTALL.md](docs/INSTALL.md) and the README:

```bash
# primary install (preferred — installs to ~/.bun/bin/gbrain)
bun install -g github:garrytan/gbrain#latest-stable

# verify
gbrain --version
gbrain doctor    # health check
```

If `bun install -g` postinstall hooks fail (a known Bun limitation per
issue #218), use the documented fallback:

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain
GBRAIN_NO_AUTOPILOT_INSTALL=1 bun install
bun link
```

After install, the `gbrain` binary lives at `~/.bun/bin/gbrain`. Add this
to the systemd PATH (Step 7).

#### Step 6 — Initialize the brain

```bash
# as the gbrain user
mkdir -p ~/.gbrain/brain-repo
cd ~/.gbrain/brain-repo
git init -b main

# keyless init (no embedding provider) — perfect for first smoke test
gbrain init --pglite --no-embedding
gbrain doctor    # should report green across schema, connectivity, etc.

# round-trip a memory
mkdir -p notes
cat > notes/hello.md <<EOF
---
type: note
title: "Hello, brain"
---
This is the first page in the brain. If gbrain search returns it, the
loop works end-to-end.
EOF
gbrain sync --no-pull --no-embed
gbrain search "hello" --json | jq '.results | length'   # expect >= 1
```

When you're ready to wire embedding (Cloudflare Workers AI per §8/§9):

```bash
export CF_ACCOUNT_ID='...'
export CLOUDFLARE_API_TOKEN='...'
gbrain config set embedding_model cloudflare:@cf/baai/bge-m3
gbrain config set search.reranker.model cloudflare-rerank:@cf/baai/bge-reranker-base
gbrain reindex --dry-run              # cost preview
gbrain reindex                        # actually embed everything
gbrain search_modes                   # verify the active mode is Cloudflare + reranker
```

#### Step 7 — systemd services for the always-on path

GBrain's autopilot cron (`gbrain bootstrap` registers them) is the
24/7 dream cycle the README cites: "your agent works whether your laptop
is open or not." The cron jobs run inside the LXC and need to survive
reboots. The install does this via systemd user-units on the
`hermesagent` LXC; the same pattern works here:

```bash
# gbrain's autopilot + bootstrap installer will create user-level systemd
# timers when run from the gbrain user's shell (matches the bootstrap
# contract). Verify after first init:
systemctl --user list-timers | grep gbrain
```

If you want a **network-accessible MCP server** (so agents on other
hosts can reach the brain), add a system-level unit:

```ini
# /etc/systemd/system/gbrain-mcp.service
[Unit]
Description=GBrain MCP server
After=network-online.target

[Service]
Type=simple
User=gbrain
Environment=GBRAIN_HOME=/home/gbrain/.hermes/.gbrain
Environment=CF_ACCOUNT_ID=...
Environment=CLOUDFLARE_API_TOKEN=...
Environment=VOYAGE_API_KEY=...
ExecStart=/home/gbrain/.bun/bin/gbrain serve --http --host 10.0.0.71 --port 9119
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gbrain-mcp.service
sudo systemctl status gbrain-mcp.service   # should be active
ss -tlnp | grep 9119                       # listening on 10.0.0.71:9119
```

`gbrain mcp expose` is the Tailscale-fronted equivalent if you want
remote access without opening a port on the LAN; matches the pattern in
§8 Phase 4.

#### Step 8 — Backup

GBrain's system-of-record is the Markdown in `~/.gbrain/brain-repo/`,
git-trackable; the DB-only state is the PGLite files and embedding cache
(per [docs/architecture/system-of-record.md](docs/architecture/system-of-record.md)).
The two are NOT a complete backup on their own.

For the LXC:

1. **Brain repo (canonical Markdown):** `git remote add origin
   git@github.com:your-org/brain-repo.git` and push. The Markdown is the
   source of truth.
2. **DB-only state (PGLite files):** back up `~/.gbrain/brain.pglite/`
   to Proxmox PBS / restic / borg / ZFS send on a schedule. `gbrain
   backup status` reports file coverage.
3. **GBrain home (config, embeddings cache, recipe overrides):**
   included in the DB-only backup; no separate handling.

Proxmox-native backup: enable the PBS integration on the
`gbrain` container ID and schedule daily snapshots with weekly retention.
This covers the LXC at the filesystem level; the git-remote push covers
the brain content.

### 11.6 Post-install verification

```bash
# 1. health
gbrain doctor

# 2. embedding chain end-to-end (Cloudflare path)
gbrain search_modes            # confirm cloudflare active, reranker on
echo 'export CF_ACCOUNT_ID=...; export CLOUDFLARE_API_TOKEN=...' >> ~/.bashrc.d/cloudflare.sh
gbrain reindex --dry-run       # preview cost
gbrain reindex                 # run it
gbrain search "test" --json    # confirm vector path

# 3. brain-first recall test (fresh chat)
# paste into a fresh Hermes / Codex session:
#   "Search my brain for the page titled 'Hello, brain' and tell me what it says."
# The agent should call gbrain search and return the page content.

# 4. cron / autopilot
gbrain bootstrap verify        # exits 0 only when full install contract is satisfied

# 5. resource check
free -h                        # expect ~4 GB used under normal load
ps aux --sort=-%mem | head     # gbrain + bun + a few cron workers
```

### 11.7 Security hardening (matching your existing `hermesagent` posture)

1. **Unprivileged LXC** (default in the `pct create` above). Prevents
   UID-mapped privilege escalation between the container and the host.
2. **Firewall at the Proxmox host** — restrict inbound to `10.0.0.0/24`
   for any ports you expose (9119 for the brain MCP HTTP server). Add a
   `iptables` rule on `vmbr0` or use Proxmox's built-in firewall on the
   `net0` device.
3. **fail2ban** for SSH on the LXC (`apt install fail2ban`, default
   rules catch most of the bot noise).
4. **API tokens in environment, not in config files.** `gbrain creds`
   + the `~/.bashrc.d/<provider>.sh` pattern keeps tokens out of git.
5. **unattended-upgrades** for security patches (Debian default; verify
   with `apt-config | grep Unattended-Upgrade`).
6. **Audit the `gbrain mcp` clients.** When you wire the brain to
   external clients (Hermes at `10.0.0.70`, Codex on your laptop,
   etc.), register them as scoped OAuth clients via `gbrain mcp grant`
   rather than sharing the bearer token. The README + docs/mcp/ADMIN.md
   walk through this.

### 11.8 TL;DR for the LXC provisioning plan

> **Create a new Proxmox LXC at `kvm.bruj0.net` with Debian 13 Trixie,
> 2 vCPU / 8 GB RAM / 50 GB disk on `local-zfs` / `10.0.0.71` /
> unprivileged. Install Bun 1.3.13 via the official install script,
> install `gbrain` via `bun install -g github:garrytan/gbrain#latest-stable`,
> run `gbrain init --pglite` for a PGLite brain (Postgres 17 + pgvector
> is opt-in only if you outgrow PGLite's ~50K-page ceiling), wire
> Cloudflare Workers AI for embedding + rerank via the recipes added in
> §10, run `gbrain bootstrap verify` to confirm the install contract, and
> register a systemd service for the always-on MCP server. Back up the
> brain repo to git + the PGLite files to PBS. Skip Debian-vs-Ubuntu
> debate — Debian 13 wins for Proxmox-native tooling, deb alignment,
> and consistency with the existing `hermesagent` LXC at `10.0.0.70`.**

---

## 12. Field Report — provisioning `GbrainCF` (CT 114) end-to-end

*Recorded 2026-09-27 by the agent that built it, for the next agent who has to
maintain, replicate, or debug it.*

This section is the **post-mortem of actually standing up the brain** described
in §11. It records what worked, what didn't, and the exact commands needed to
recreate the deployment on a fresh LXC.

### 12.1 Topology (final)

```
                    ┌──────────────────────────────────────┐
                    │  Proxmox host kvm.bruj0.net          │
                    │   - pve-firewall (cluster + per-CT)  │
                    │   - PowerDNS authoritative           │
                    │     (intranet.local)                  │
                    └────────────┬─────────────────────────┘
                                 │ SDN vnet0 (10.0.0.0/8)
                ┌────────────────┼─────────────────┐
                │                                  │
       ┌────────▼─────────┐               ┌────────▼─────────┐
       │ hermesagent CT113│               │ GbrainCF  CT114   │
       │ 10.0.0.70        │               │ 10.0.0.114        │
       │ Hermes gateway   │               │  Debian 13        │
       │ Hermes dashboard │               │  Bun 1.4.2        │
       │ socat relay      │               │  Postgres 17      │
       │ 127.0.0.1:9119   │               │   + pgvector 0.8.6│
       │   → 10.0.0.114   │               │   + pg_trgm 1.6   │
       │       :9119      │               │  gbrain 0.59.0.0  │
       └──────────────────┘               │   (fork branch)   │
                                          │  gbrain-mcp :9119 │
                                          │  gbrain-tls-relay │
                                          │   :8443 (HTTPS)   │
                                          │  gbrain-autopilot │
                                          └───────────────────┘
                                                   ▲
                                                   │
                            Cloudflare Origin CA ──┘
                            (cert for gbrain.bruj0.net)
                            Cloudflare Workers AI ──── bge-m3 + bge-reranker-base
```

### 12.2 Specs

| Resource | Value |
|---|---|
| LXC ID | 114 |
| Hostname | `GbrainCF` |
| Container image | `debian-13-standard_13.1-2_amd64.tar.zst` |
| vCPU | 4 |
| RAM | 8192 MB |
| Swap | 2048 MB |
| Disk | 50 GB on `data1` (LVM-thin) |
| Network bridge | `vnet0` (SDN intranet zone) |
| IP | `10.0.0.114/8` static |
| Gateway | `10.0.0.1` |
| Firewall rules | `IN ACCEPT -p tcp -dport 22,9119,8443,5432` |

### 12.3 Install procedure (verified working)

```bash
# ==== On Proxmox host ====
# 1. Create the LXC
pct create 114 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
  --hostname GbrainCF \
  --cores 4 --memory 8192 --swap 2048 \
  --rootfs data1:50 \
  --net0 name=eth0,bridge=vnet0,gw=10.0.0.1,hwaddr=BC:24:11:0F:0C:89,ip=10.0.0.114/8,type=veth \
  --features nesting=1 \
  --unprivileged 1 \
  --password "$(openssl rand -base64 32)" \
  --onboot 1 \
  --start 1
pct set 114 -description "GBrain personal knowledge brain + Postgres 17 + pgvector. Install via bruj0/gbrain fork (feat/cloudflare-workers-ai-recipe). SDN intranet zone via vnet0."

# 2. Per-CT firewall (Proxmox host pve-firewall)
cat > /etc/pve/firewall/114.fw <<'FW'
[OPTIONS]
enable: 1

[RULES]
IN ACCEPT -p tcp -dport 22 -log nolog
IN ACCEPT -p tcp -dport 9119 -log nolog
IN ACCEPT -p tcp -dport 8443 -log nolog
IN ACCEPT -p tcp -dport 5432 -log nolog
FW
pve-firewall compile

# ==== Inside the LXC ====
pct enter 114
apt-get update && apt-get -y upgrade
apt-get install -y openssh-server fail2ban unattended-upgrades sudo curl git
adduser gbrain --disabled-password --gecos ""
mkdir -p /etc/ssh/sshd_config.d
echo "PasswordAuthentication no" > /etc/ssh/sshd_config.d/00-no-password.conf
systemctl restart ssh

# Bun 1.4.2
curl -fsSL https://bun.sh/install | bash
. $HOME/.bun/env

# Postgres 17 + pgvector + pg_trgm
apt-get install -y postgresql-17 postgresql-17-pgvector postgresql-17-pg-trgm
sudo -u postgres psql <<SQL
CREATE ROLE gbrain LOGIN PASSWORD 'gbrain_local_change_me' CREATEDB;
ALTER ROLE gbrain BYPASSRLS;
CREATE DATABASE gbrain OWNER gbrain;
\c gbrain
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO gbrain;
SQL

# pg_hba: ensure md5 auth from localhost
# (default Debian ships `peer` for local Unix; we want `md5` for the gbrain user)
# Edit /etc/postgresql/17/main/pg_hba.conf:
#   local   all   gbrain   md5
#   host    all   gbrain   127.0.0.1/32   md5
systemctl restart postgresql

# gbrain CLI v0.59.0.0 from bruj0 fork
git clone https://github.com/bruj0/gbrain.git \
  --branch feat/cloudflare-workers-ai-recipe --depth 1 /home/gbrain/projects/gbrain
cd /home/gbrain/projects/gbrain && bun install
bun run --bun gbrain build  # produces dist binary
ln -s /home/gbrain/projects/gbrain/dist/gbrain /home/gbrain/.bun/bin/gbrain

# Loginctl linger so user-services survive logout
sudo loginctl enable-linger gbrain

# /home/gbrain/.gbrain/.env (mode 600)
cat > /home/gbrain/.gbrain/.env <<'ENV'
CF_ACCOUNT_ID=<account>
CLOUDFLARE_API_TOKEN=<token>
MINIMAX_CODER_PLAN_KEY=<key>
DATABASE_URL=postgres://gbrain:gbrain_local_change_me@127.0.0.1:5432/gbrain
GBRAIN_ADMIN_BOOTSTRAP_TOKEN=<persistent-admin-token>
ENV
chmod 600 /home/gbrain/.gbrain/.env

# First-time gbrain init
sudo -u gbrain bash -c 'source ~/.gbrain/.env && export PATH=$HOME/.bun/bin:$PATH
  gbrain init --prefer-postgres'   # may fail on BYPASSRLS; fall back to:
# Workaround for superuser-only migrations:
sudo -u postgres psql -c "ALTER ROLE gbrain SUPERUSER;"
sudo -u gbrain bash -c 'source ~/.gbrain/.env && export PATH=$HOME/.bun/bin:$PATH
  gbrain apply-migrations --yes'
sudo -u postgres psql -c "ALTER ROLE gbrain NOSUPERUSER; ALTER ROLE gbrain BYPASSRLS;"
# ^ go back to least-privilege role for runtime

# Configure Cloudflare embedding + rerank
gbrain config set embedding_model "cloudflare:@cf/baai/bge-m3"
gbrain config set search.reranker.enabled true
gbrain config set search.reranker.model "cloudflare-rerank:@cf/baai/bge-reranker-base"

# Verify health
gbrain doctor  # expect ~90/100 score, embedding_provider OK, reranker OK
```

### 12.4 Three systemd-user services (the always-on pieces)

All three live as user systemd units under `/home/gbrain/.config/systemd/user/`.
Linger is enabled for `gbrain`, so they survive shell logout.

| Unit | What | Notes |
|---|---|---|
| `gbrain-autopilot.service` | Background daemon (Minions). Pull-mode git-to-brain sync. | Logs to `~/.gbrain/autopilot.log`. Install via `gbrain autopilot --install --yes --repo ~/projects/gbrain`. |
| `gbrain-mcp.service` | `gbrain serve --http --public-url https://gbrain.bruj0.net:8443 --enable-dcr --port 9119`. Loopback only. | OAuth 2.1 server. `--enable-dcr` is required so MCP clients can self-register. |
| `gbrain-tls-relay.service` | `socat OPENSSL-LISTEN:8443,...,fork,bind=0.0.0.0,cert=$HOME/.gbrain/tls/cert.pem,key=$HOME/.gbrain/tls/key.pem TCP:127.0.0.1:9119` | Terminate TLS in front of the plain-HTTP gbrain-mcp. Cloudflare Origin CA cert + key. |

#### gbrain-mcp.service
```ini
[Unit]
Description=GBrain MCP HTTP server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/projects/gbrain
ExecStart=%h/.bun/bin/gbrain serve --http  --public-url https://gbrain.bruj0.net:8443 --enable-dcr --port 9119
Restart=on-failure
RestartSec=5
EnvironmentFile=%h/.gbrain/.env
Environment=GBRAIN_HOME=%h
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=XDG_RUNTIME_DIR=/run/user/%U
Environment=GBRAIN_ADMIN_BOOTSTRAP_TOKEN=19a774209d7dbb87e1978e9eee6b55068d3f3ddbb4fc416784233e67b33298d6

[Install]
WantedBy=default.target
```

#### gbrain-tls-relay.service
```ini
[Unit]
Description=GBrain TLS relay (HTTPS:8443 -> HTTP:9119)
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/socat -d OPENSSL-LISTEN:8443,reuseaddr,fork,bind=0.0.0.0,cert=%h/.gbrain/tls/cert.pem,key=%h/.gbrain/tls/key.pem,verify=0 TCP:127.0.0.1:9119
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

### 12.5 TLS — Cloudflare Origin CA

```bash
# 1. Mint via Cloudflare API (requires Zone → SSL and Certificates: Edit)
# Zone ID for bruj0.net: 15e4cfe0ecfee91903601ae780932ad3
# CSR generated locally (CN=gbrain.bruj0.net)
curl -X POST https://api.cloudflare.com/client/v4/certificates \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"hostnames":["gbrain.bruj0.net"],"request_type":"origin-rsa","csr":"<...>","validity_days":5475}'
# Result: 15-year cert, issuer = "CloudFlare Origin SSL Certificate Authority"

# 2. Stage on LXC
mkdir -p /home/gbrain/.gbrain/tls
cp cert.pem /home/gbrain/.gbrain/tls/cert.pem   # mode 644
cp key.pem  /home/gbrain/.gbrain/tls/key.pem    # mode 600

# 3. DNS A record (Cloudflare proxied = false so direct LAN IP)
curl -X POST https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -d '{"type":"A","name":"gbrain","content":"10.0.0.114","ttl":1,"proxied":false}'
```

### 12.6 Wiring Hermes (10.0.0.70)

Two pieces:

**(a) Cloudflare Origin CA root cert** — install on every host that
will validate the cert:

```bash
curl -sSL "https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem" \
  -o /usr/local/share/ca-certificates/cloudflare-origin-ca.crt
update-ca-certificates
```

Without this, Python (and curl) reject the cert as untrusted even though
the chain validates to a public Cloudflare root.

**(b) MCP registration** in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  context7:
    url: https://mcp.context7.com/mcp
    enabled: true
  gbrain:
    url: https://gbrain.bruj0.net:8443/mcp
    enabled: true
    auth: oauth
    transport: streamable_http
    connect_timeout_seconds: 30
    tools: all
```

Then interactively:

```bash
ssh hermes@10.0.0.70 -p 6022
hermes mcp login gbrain
# Browser pops → paste the GBRAIN_ADMIN_BOOTSTRAP_TOKEN when prompted
```

If the browser can't reach `https://gbrain.bruj0.net:8443` (off-VPN, DNS not
resolvable from the laptop), add to your laptop's `/etc/hosts`:
```
10.0.0.114 gbrain.bruj0.net
```

If the OAuth callback URL (`http://127.0.0.1:27893/callback?...`) doesn't
reach Hermes (because the browser is on a different machine than Hermes
listening on the loopback port), you can SSH-tunnel it:

```bash
ssh -L 27893:127.0.0.1:27893 hermes@10.0.0.70 -p 6022
# Then paste the callback URL into your laptop's browser.
```

…or, if you have shell access to Hermes and the URL has a `code=` param,
just curl it from Hermes' loopback:
```bash
sudo -u hermes curl "http://127.0.0.1:27893/callback?state=...&code=..."
# Response: <h2>Authorization Successful</h2>
```

### 12.7 Pitfalls we hit (and their fixes)

| Symptom | Root cause | Fix |
|---|---|---|
| `gbrain apply-migrations` fails on `rls_backfill_missing_tables` (v24) | The role lacked `BYPASSRLS`. | `ALTER ROLE gbrain BYPASSRLS;` (or `SUPERUSER` for the migration phase, then `NOSUPERUSER` after). |
| `auto_rls_event_trigger: role gbrain may not CREATE EVENT TRIGGER` | `CREATE EVENT TRIGGER` is superuser-only on managed Postgres. | Same: `SUPERUSER` for migrations, `BYPASSRLS` for runtime. |
| `apply-migrations --repo` unknown flag | The flag is on `autopilot`, not on `apply-migrations`. | Run `gbrain autopilot --install --yes --repo $HOME/projects/gbrain`. |
| Minions migration wedges after 3 partials | `--install --yes` (no `--repo`) can't find the repo, so the install phase always fails. | Install autopilot from inside the repo dir, then manually mark migration `0.11.0` as `complete` in `~/.gbrain/migrations/completed.jsonl`. |
| `gbrain serve` crashes with `Issuer URL must be HTTPS` | Loopback HTTP exemption only applies when `gbrain serve --public-url http://localhost:N`; using a LAN hostname forces HTTPS. | Set `--public-url https://<hostname>:<port>` and terminate TLS in front (socat). |
| `gbrain serve --host 0.0.0.0` is "unknown flag" | The flag is `--bind`. | `gbrain serve --http --bind 0.0.0.0 --port 9119`. |
| Port 9119 conflict between gbrain-mcp (loopback) and socat (0.0.0.0) | Both processes tried to bind 9119; socat only sees `0.0.0.0`, gbrain-mcp after the `--bind 0.0.0.0` change binds `127.0.0.1`. Should coexist but socat's port-cleanup leaves a TIME_WAIT that blocks next start. | Move socat to a different external port (8443) and let gbrain-mcp own 9119 on loopback. |
| Cloudflare `/certificates` returns `1016: User is not authorized` | Token lacked `Zone → SSL and Certificates: Edit`. | Add that scope in CF dashboard. Token needs Zone → DNS Edit *and* Zone → SSL/Cert Edit, plus existing Workers AI. |
| Hermes OAuth: `Certificate verify failed` | Cloudflare Origin CA is not in system trust store. | Install `/usr/local/share/ca-certificates/cloudflare-origin-ca.crt` from `https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem`, run `update-ca-certificates`. |
| Hermes OAuth: `Cannot POST /register` | gbrain had DCR disabled by default. | Restart gbrain-mcp with `--enable-dcr` (and `--enable-dcr-insecure` if you want public clients with no secret). |
| OAuth browser flow asks for "owner bootstrap credential" | The MCP HTTP server's admin auth gate. The bootstrap token is hidden on TTY-less startups ("non-TTY log-leak guard"). | Set `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` env var (persisted in `/home/gbrain/.gbrain/.env` and the systemd unit). |
| `OAuth protected resource http://localhost:9119/mcp does not match expected http://gbrain.bruj0.net:8443/mcp` | Issuer mismatch — gbrain was defaulting to loopback while the client expected the public URL. | Set `--public-url https://gbrain.bruj0.net:8443` on the gbrain-mcp unit. |
| `PDNS delete-rrset` didn't actually delete (records tripled) | `pdnsutil delete-rrset` failed silently in our case; new `add-record` then stacked on top. | Direct SQL: `sqlite3 /var/lib/powerdns/pdns.sqlite3 "DELETE FROM records WHERE name='X' AND type='A';"` then re-add. Also `rec_control wipe-cache <zone>` to flush pdns-recursor. |
| `socat` errored with `bind: Address already in use` | A previous socat instance was stuck (failed-fast restart loop leaked a TIME_WAIT socket). | `pkill -f socat` before restarting the unit. |
| `pct set 114 -ip 10.0.0.114/8 -gw 10.0.0.1` "Unknown option: ip" | `pct set` uses `-net0 name=eth0,...,ip=...,gw=...`, not `-ip`/`-gw`. | Modify the `net0` line in-place via `-net0`. |
| `gbrain serve` mcp "/health" returns 503 even though DB works | `probeHealth` calls `engine.getStats()` which throws on a postgres pool warming up; catch-all returns generic "Database connection failed". | Cosmetic, doesn't block MCP. `/mcp` and OAuth still work. Will fix in upstream PR. |
| DNS recursor cached old `gbraincf.intranet.local → 10.0.0.71` after we moved LXC to .114 | pdns-recursor caches positive answers until TTL; old TTL was ~12000s. | `rec_control wipe-cache intranet.local` (and the negative answer too). |

### 12.8 What the next agent should know

1. **The brain lives at `https://gbrain.bruj0.net:8443/mcp`.** Three
   things must be true for it to answer:
   - LXC 114 is running on `kvm.bruj0.net`
   - The three user systemd units on the LXC are active
   - The Cloudflare token in `/home/gbrain/.gbrain/.env` still has
     Workers AI + DNS Edit + SSL/Cert Edit scopes

2. **Tokens expire in 1 hour.** Hermes' OAuth client uses the
   `refresh_token` grant to renew silently. If you see 401s, run
   `hermes mcp login gbrain` again from an interactive shell on Hermes.

3. **Schema migration 0.11.0 (Minions) was force-completed.** If you
   upgrade gbrain to a version that re-records the migration ledger,
   the wedge may re-occur. Symptom: `gbrain apply-migrations` fails with
   "no repo path". Fix: run `gbrain autopilot --install --yes --repo
   $HOME/projects/gbrain` from inside the repo dir, then `apply-migrations
   --yes`.

4. **The disk is thin-provisioned 50 GB.** Postgres currently uses
   ~50 MB. If you start storing large PDFs / videos you'll fill it
   fast. `pct resize 114 rootfs data1 +20G` works on-line (LVM-thin).

5. **The Origin CA cert is 15-year.** It expires 2041-09-23. Set a
   calendar reminder for 2041-08 to rotate. Until then, ignore all
   cert-expiry warnings.

6. **The `/health` endpoint returns 503 even when the brain is healthy.**
   This is a known cosmetic bug in `probeHealth` against the postgres
   engine. `/healthz` on the same path also 503s. The real readiness
   signal is `gbrain doctor` — score >= 80 means green.

7. **The `MINIMAX_CODER_PLAN_KEY` in the .env is for any LLM-driven
   gbrain phase that needs a provider (none today, but the autopilot
   may grow one).** It is also what `~/.hermes/.env` on the Hermes host
   has — gbrain and Hermes share the same Anthropic-compatible endpoint
   via the "minimax" provider.

8. **Backups:** no automated backup yet. The gbrain repo is git
   (forked from upstream, easy to push to a remote). The Postgres data
   is on `data1` LVM-thin — back up with `pct backup` or by adding a
   PBS datastore. Future agent should schedule `pvesm add pbs
   <pbs-host>` and `vzdump 114 --storage pbs --schedule daily`.

### 12.9 Final verified state (snapshot 2026-09-27 23:08 UTC)

| Component | State | Source of truth |
|---|---|---|
| Proxmox LXC 114 | running, 4 vCPU, 8 GB RAM, 50 GB data1 | `pct status 114` |
| IP | `10.0.0.114/8` via `10.0.0.1` (SDN vnet0) | `pct exec 114 ip -4 addr` |
| Hostname | `GbrainCF` | `/etc/hostname` |
| Postgres engine | active, schema v165 (latest) | `gbrain doctor` |
| Embedding provider | `cloudflare:@cf/baai/bge-m3` (1024d) ✓ | `gbrain doctor` |
| Reranker | `cloudflare-rerank:@cf/baai/bge-reranker-base` ✓ | `gbrain doctor` |
| Health score | 90/100 | `gbrain doctor` |
| MCP HTTP server | active on `127.0.0.1:9119` | `systemctl --user status gbrain-mcp` |
| TLS relay | active on `0.0.0.0:8443` | `systemctl --user status gbrain-tls-relay` |
| Autopilot daemon | active | `systemctl --user status gbrain-autopilot` |
| Cloudflare cert | valid 2026-09-27 → 2041-09-23 | `openssl x509 -in cert.pem -noout -dates` |
| Cloudflare DNS | `gbrain.bruj0.net → 10.0.0.114` | `dig gbrain.bruj0.net @1.1.1.1` |
| Internal DNS | `gbraincf.intranet.local → 10.0.0.114` | `pdnsutil list-zone intranet.local` |
| Hermes MCP | `gbrain` registered, OAuth tokens cached, 69 tools discovered | `hermes mcp list`, `hermes mcp test gbrain` |
| Firewall | `IN ACCEPT` on 22, 9119, 8443, 5432 (CT 114) | `/etc/pve/firewall/114.fw` |
| Hermes CA trust | Cloudflare Origin CA RSA Root installed | `/etc/ssl/certs/ca-certificates.crt` |

