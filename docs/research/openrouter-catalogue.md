# OpenRouter — tool-calling models, limits, and data policy

**Checked:** 2026-11-03 (UTC).
**Scope:** what OpenRouter offers this chat *today*: tool-calling with streaming, no vision, no structured output.
**Pinned versions:** `ai@7.0.156`, `@ai-sdk/openai-compatible@3.0.80` (from `node_modules` in this repo).

Everything below was read from live first-party sources on the check date, not from memory. The
catalogue and the limits both move; every number here has a URL and a date next to it.

Method: `/api/v1/models` and `/api/v1/endpoints/zdr` were fetched live and filtered; the τ²-Bench
leaderboard was parsed from the public benchmark page; SDK behaviour was read from the installed
source in `node_modules/@ai-sdk/openai-compatible/src/`, not from its README.

---

## Answer in one paragraph

Tool calling is not the constraint — 363 of 451 live catalogue entries support it, and only 8 of
those lack `tool_choice`. **Reliability** is, and the
only public, comparative evidence for it is OpenRouter's own τ²-Bench Airline leaderboard, where the
cheap models do surprisingly well (`deepseek/deepseek-v4-flash` 0.798 accuracy at ~$0.008/task) and
`openai/gpt-5-nano` does badly (0.483). Free models exist and mostly support tools (13 of 14 `:free`
ids), but the free tier is **20 requests/minute and 50 requests/day for the whole account** until
$10 of credits has ever been bought — a shared app key would exhaust that in minutes. ZDR is offered
per request, but **no first-party Anthropic or OpenAI endpoint qualifies**, and of the 13 free
tool-calling models only one has any ZDR endpoint. `@ai-sdk/openai-compatible@3` round-trips tool
calls correctly; its one real gap is that it cannot return `reasoning_details`, so encrypted
reasoning (Anthropic, Gemini) does not survive a tool loop.

---

## 1. Tool-calling shortlist

Sources: [`/api/v1/models`](https://openrouter.ai/api/v1/models) (451 entries; 363 support `tools`,
14 are `:free`), [`/api/v1/endpoints/zdr`](https://openrouter.ai/api/v1/endpoints/zdr),
and the [τ²-Bench Airline leaderboard](https://openrouter.ai/benchmarks/tau2-bench-airline)
(141 models, 71 providers, latest run recorded 2026-11-03).

Filtering the full catalogue locally finds **387** entries with `tools`; the
`?supported_parameters=tools` filter returns **363** because it excludes routers (`openrouter/*`,
`typesafe/jev-router`) and `~…-latest` aliases. The shortlist below uses concrete ids only.

`τ²` = τ²-Bench Airline accuracy, OpenRouter's multi-turn tool-calling agent benchmark. It is the
closest public proxy for "does this model actually drive tools", and it is the same signal that
feeds OpenRouter's `Auto Exacto` routing. Prices are USD per 1M tokens (input/output), taken from
the models API on the check date.

| Model id | Context | Max out | Price /M | τ² | Cost/task | ZDR+tools endpoints |
| - | - | - | - | - | - | - |
| **Free (`:free`)** | | | | | | |
| `google/gemma-4-31b-it:free` | 262,144 | 32,768 | free | 0.771 † | — | 0 |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | free | 0.749 † | — | 0 |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 65,536 | free | 0.715 † | — | 0 |
| `google/gemma-4-26b-a4b-it:free` | 262,144 | 32,768 | free | 0.706 † | — | 0 |
| `xingchen-agi/xing4.0-29b-a4b:free` | 262,144 | 235,929 | free | — | — | 1 (Phala) |
| **Paid — cheap tier** | | | | | | |
| `qwen/qwen3.8-27b` | 1,024,000 | 235,929 | $0.150 / $1.875 | 0.780 | $0.0043 | 19 |
| `deepseek/deepseek-v4-flash-0731` | 1,048,576 | 943,718 | $0.059 / $0.300 | 0.813 | $0.0061 | 22 |
| `deepseek/deepseek-v4-flash` | 1,048,576 | 943,717 | $0.091 / $0.182 | 0.798 | $0.0084 | 12 |
| `xiaomi/mimo-v2.6-flash` | 1,050,000 | 131,072 | $0.140 / $0.280 | 0.782 | $0.0113 | 5 |
| `z-ai/glm-5.3-flash` | 1,048,576 | 131,072 | $0.029 / $0.092 | 0.767 | $0.0135 | 34 |
| `anthropic/claude-haiku-5.5` | 1,000,000 | 128,000 | $0.100 / $0.500 | 0.740 | $0.0133 | 6 |
| `inclusionai/ling-3.1-flash` | 1,000,000 | 262,144 | $0.075 / $0.225 | 0.793 | $0.0315 | 2 |
| `google/gemini-3.5-flash-lite` | 1,048,576 | 65,536 | $0.300 / $2.500 | 0.783 | $0.0744 | 5 |
| **Counter-example — do not pick on price** | | | | | | |
| `openai/gpt-5-nano` | 400,000 | 128,000 | $0.050 / $0.400 | **0.483** | $0.0406 | 2 |

† The τ² figure is the **base model's**, measured by OpenRouter against paid endpoints. The `:free`
variant is served by whatever free providers OpenRouter designates (the Free plan lists 4 providers);
quantisation, uptime and throughput differ, so treat the free score as an optimistic proxy, not a
measurement of the free endpoint.

Notes that matter when picking:

- **`deepseek/deepseek-v4-flash-0731` is a re-post-trained revision of V4 Flash** (same 284B total /
  13B active shape), released 2026-07-31 as a separate id; both are live. It currently scores higher
  (0.813 vs 0.798) at a lower per-task cost. A dated revision can be retired while the undated id
  keeps moving, so pinning the undated one is the safer default and pinning the revision is a bet.
- **`openrouter/auto` accepts `tools`** (context 2,000,000; pricing is a `-1` sentinel because it is
  dynamic) and the FAQ states routing through it "adds no fee; you pay the rate of whichever model
  serves the request". It is a legitimate fallback layer, but it hands model choice to the router,
  so the app's prompt cannot be tuned to one model's quirks.
- **`tool_choice` is listed by all but 8 of the tool-capable models** (the exceptions include the
  four `amazon/nova-*` models and three `:free` ones), but forcing a specific tool
  (`tool_choice: "required"` or a named function) is endpoint-dependent —
  `supports_tool_choice.required` is `true` on 632 of the 851 ZDR tool endpoints. If the app ever
  forces a tool, check that flag per endpoint rather than assuming it.
- OpenRouter tracks a per-endpoint **Tool Call Error Rate** and exposes it on the Performance tab of
  each model page; it is *not* in the public API. `Auto Exacto` reorders providers on every
  tool-calling request using that rate, throughput and its own benchmark harness — on by default,
  and opt-out is `provider.sort: "price"` or the `:floor` slug. That default is a real reliability
  win for a tool-only app, and it is the reason a cheap model can still feel dependable.
- `openrouter/free` exists as a router slug for free models; it is not in the shortlist because a
  catalogue built on it inherits the 50/day cap below.

---

## 2. Free-tier limits

Sources: [Limits](https://openrouter.ai/docs/api_reference/limits) and the
[Pricing FAQ](https://openrouter.ai/pricing), both read 2026-11-03.

| Credits purchased (all time) | Requests / minute | Requests / day |
| - | - | - |
| Less than 10 | 20 | **50** |
| At least 10 | 20 | **1,000** |

- The gate is **lifetime credits purchased, not current balance** — the docs say the tier "is
  selected by all-time credits purchased, independently of `is_free_tier`". Spending down to zero
  does not drop you back to 50/day, but a **negative balance blocks free models entirely** until
  credits are added.
- The doc renders a template artefact in that sentence (`{FREE_MODEL_CREDITS_THRESHOLD - 1}`), which
  implies the higher tier is granted one credit below the stated threshold to absorb top-up fees.
  The pricing FAQ states the threshold plainly as **$10**. Assume 9–10 credits; do not shave it.
- The counters are per **account**, not per API key: "Making additional accounts or API keys will not
  affect your rate limits, as we govern capacity globally." A single server-side key shared by every
  user of a deployed app therefore shares **50 requests/day** in total. That is a demo allowance, not
  a launch allowance, and it is the single most important limit in this document.
- `GET /api/v1/key` returns `free_model_daily_requests: { used, limit, remaining }` and
  `is_free_tier`; that is the supported way to check before a request rather than after a 429.
- **Failed attempts count toward the daily cap.** The pricing FAQ says so verbatim: "Failed attempts
  count toward that daily cap." This is the one place failures are counted — they are *not* billed
  (see §3). A retry loop against a flaky free endpoint burns the day's quota.
- Free-tier limits are not reported in `X-RateLimit-*` on success: successful inference responses
  carry no rate-limit headers at all. On a platform-limit 429 the error response carries
  `X-RateLimit-Limit`, `-Remaining`, `-Reset`.
- **Paid models have no OpenRouter plan-based rate limit.** The pricing FAQ: "OpenRouter sets no
  plan-based rate limit on paid models." Limits you hit are the upstream provider's, and fallback
  routing retries other providers before the error reaches you; only very high burst traffic is
  rejected by Cloudflare DDoS protection.
- One paid-side trap worth knowing before launch: the **in-flight spending budget**. On prepaid
  accounts below a balance threshold, and on newer accounts without spending history, OpenRouter
  holds an estimate of each running request against your balance and rejects a request that does not
  fit with a 402 (`limit_source: openrouter_in_flight_budget`, `Retry-After` set) even though the
  balance is positive. It does not apply to free models or to fully-BYOK requests.

---

## 3. Pricing, platform fee, and failed requests

Sources: [Pricing](https://openrouter.ai/pricing) and
[BYOK](https://openrouter.ai/docs/guides/overview/auth/byok), read 2026-11-03.

- **No markup on inference.** "Inference is billed at the provider's list price on every plan."
- **The fee is on credit purchase, never per request:** **5.5%** on Standard (pay-as-you-go),
  **8%** on Business, custom on Enterprise. Free plan: N/A (no credits).
- Volume discounts exist only on the platform fee (Enterprise); inference is never discounted.
- Taxes are exclusive (VAT/GST added where required). Standard has no minimum and no lock-in.
- **Failed and fallback attempts are not billed.** Verbatim: "An attempt that errors is not charged
  for its model tokens, so with fallback you pay only for the run that answers." Under **Zero
  Completion Insurance** the same holds for a response that returns nothing and no finish reason.
  Exception: auxiliary services that already ran (web search, file parsing) may still be billed.
- Streaming is billed identically to non-streaming — per token.
- ⚠️ Read §2 and this section together: a failed free-model request **costs no money but does consume
  the daily cap**; a failed paid request costs nothing at all.

### BYOK passthrough

- You add your own provider key in workspace settings; OpenRouter uses it for that provider and
  charges **5% of what the same model/provider would have cost on OpenRouter**, deducted from your
  credits.
- **Free allowance: $25,000/month of list-price inference** on Standard *and* Business, measured by
  list-price cost rather than request count; 5% after that. Enterprise is custom.
- Keys live in two sections: **Prioritized** (tried before OpenRouter capacity) and **Fallback**
  (tried after). The default on failure is to fall back to shared OpenRouter capacity, which spends
  credits; that is configurable per key (`is_required`, `is_byok_only`).
- Keys support filters by model, by OpenRouter API key hash, and by workspace member — useful for
  isolating an environment.
- **BYOK does not exempt a provider from your data policy.** A BYOK key changes the credential, not
  which endpoints are eligible. Under ZDR enforcement a key whose provider retains prompts stays
  blocked unless the key itself carries a ZDR declaration in its Provider agreement section (see §4).
- BYOK spend does **not** count toward guardrail or workspace budgets unless *Include BYOK spend* is
  enabled — so a budget can look far from its cap while real spend continues.

---

## 4. Data policy: logging, training, ZDR

Sources: [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr),
[Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging),
[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection), read 2026-11-03.

OpenRouter classifies every **endpoint** (not every provider) into three tiers:

| Tier | Meaning | Trained on? |
| - | - | - |
| **ZDR** | No routine storage after processing | No |
| **Safety Retention** | May retain prompts *from any request*, flagged or not, only to detect/investigate abuse | No |
| **Retention and Training** | May store and use for training under the provider's policy | **May be** |

A provider's default policy can differ from a specific endpoint's, and where OpenRouter cannot
establish a clear policy it marks the endpoint as both retaining and training. **Absence of evidence
is treated as guilt** — that is the design, and it makes the ZDR endpoint list conservative.

### Which providers actually qualify

- The authoritative, machine-readable list is
  [`GET /api/v1/endpoints/zdr`](https://openrouter.ai/api/v1/endpoints/zdr): **1,098 endpoints
  across 66 providers** on the check date, 851 of which support tools, covering 220 distinct models
  with at least one tool-capable entry.
- That list is endpoints *eligible under ZDR enforcement*, and it also contains **Safety Retention**
  endpoints, which are used only if your account or guardrail allows Safety Retention. With the
  default setting (allow) the counts are as listed; set *ZDR only* and some of them disappear.
- Notable providers present: DeepInfra (121), Azure (94), Google (88), Amazon Bedrock (57),
  Mistral (51), Novita, SiliconFlow, Fireworks, Cloudflare, Together, CoreWeave, Groq, xAI, Z.AI,
  Cohere.
- **First-party Anthropic and OpenAI endpoints are not ZDR** — neither name appears in the list at
  all. Enabling the Anthropic model group "removes first-party Anthropic endpoints (Bedrock and
  Vertex remain available)"; the OpenAI group "removes first-party OpenAI endpoints (Azure remains
  available)". So Claude-via-Anthropic and GPT-via-OpenAI are unavailable under ZDR; the same models
  via Bedrock/Azure can remain.
- Google is special: since 2026-10-18, Google models served through Vertex use **Safety Retention**
  (retains flagged prompts up to 90 days, does not train on them). Under ZDR you choose *ZDR only*
  (most Google models disappear) or *Allow Safety Retention*. Enterprise defaults to ZDR only; other
  accounts default to allowing Safety Retention.

### Free models and ZDR are effectively mutually exclusive

Of the 13 `:free` models that support tools, **exactly one** — `xingchen-agi/xing4.0-29b-a4b:free`
via Phala — has a ZDR-eligible endpoint. `google/gemma-4-31b-it:free`,
`nvidia/nemotron-3.5-*:free` and the rest have none. If ZDR is enforced account-wide, the free
catalogue is not merely degraded; it is gone. This is inferred from the endpoint list, which the docs
describe as "automatically updated when there are changes to a provider's data policy" — i.e. absence
from it is meaningful, not missing data.

### How to restrict routing to ZDR

Three ways, and they OR together (any one being on enforces ZDR; none can switch another off):

1. **Per request:** `provider: { zdr: true }` in the request body. Safety Retention endpoints are
   also eligible unless your account/guardrail is set to *ZDR only*.
2. **Account-wide**, in privacy settings — globally, or per model group (`Anthropic`, `OpenAI`,
   `Google`, `SpaceXAI`, `All other models`).
3. **Guardrails**, per key or per member, with `enforce_zdr_anthropic`, `enforce_zdr_openai`,
   `enforce_zdr_google`, `enforce_zdr_xai`, `enforce_zdr_other` (the legacy `enforce_zdr` is
   deprecated).

Training is a separate control: `provider: { data_collection: "deny" }` (default `"allow"`), plus
account settings that are separate for paid and free models.

Worth stating plainly in any launch copy, because it is easy to over-promise:

- **ZDR covers inference routing only.** Plugins and server tools (web search, web fetch) are
  third-party services with their own retention; under ZDR the Firecrawl engine is rejected for web
  search/fetch, but that is a tool-level rule, not a general guarantee.
- **In-memory prompt caching does not count as retention** by OpenRouter's definition, so ZDR
  requests may still hit endpoints with implicit caching. That is a policy choice on their side, and
  a reviewer may disagree with it.
- **CSAM screening (announced 2026-10-27) applies even to ZDR traffic**: flagged content "may be
  retained for human review, reporting, and preservation where required by law". ZDR is therefore
  "no routine storage", not "no storage".
- The provider-level human-readable table lives on the Provider Logging page. It is rendered
  client-side and is not in the `.md` export, so it cannot be scraped reliably; the ZDR endpoint API
  is the better source for automation.

---

## 5. OpenAI-compatible quirks: `@ai-sdk/openai-compatible@3` + `ai@7`

Sources: installed source at
`node_modules/@ai-sdk/openai-compatible/src/chat/*` (v3.0.80) and
[Client Tools](https://openrouter.ai/docs/guides/features/tool-calling),
[Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). Verified by
reading the code, not the docs of the package.

### What works

| Concern | Verdict | Evidence |
| - | - | - |
| Tool definitions | ✅ | `prepareTools` emits `{type:"function", function:{name, description, parameters, strict?}}`; `strict` is forwarded when set on the tool. |
| `tool_choice` | ✅ | `auto` / `none` / `required` / `{type:"function",function:{name}}` all map to OpenAI shape. |
| Streaming tool calls | ✅ | Deltas accumulated by `index`; arguments buffered until `function.name` arrives; emits `tool-input-start/delta/end` then `tool-call`. Handles Google's missing `index`. |
| Tool-call round-trip | ✅ | Assistant turn sent with `content: null` when there is no text, `tool_calls[]`; results sent as `{role:"tool", tool_call_id, content}`. JSON outputs are `JSON.stringify`ed. |
| `finish_reason` | ✅ | `tool_calls`/`function_call` → unified `tool-calls`. |
| Streaming usage | ✅ | OpenRouter always emits a final chunk carrying `usage`; the parser reads `usage` from any chunk, so `includeUsage` is not required for accounting. |
| Error frames | ✅ | `data: {"error": …}` in a stream becomes an AI SDK error part; OpenRouter's numeric `code` is accepted (`z.union([z.string(), z.number()])`). `error.metadata` is dropped. |
| Structured output | ⚠️ n/a | Only emits `response_format: {type:"json_schema"}` when the provider is created with `supportsStructuredOutputs: true`; otherwise it degrades to `{type:"json_object"}` and warns. The chat does not need it. |

### The two quirks that actually bite

1. **`provider` routing preferences need a passthrough.** `createOpenAICompatible` has no
   `extraBody` option; instead, any key in `providerOptions[<name>]` that is not one of its own
   options is spread **into the top-level request body**. So OpenRouter's routing block is sent as:

   ```ts
   providerOptions: {
     openrouter: { provider: { require_parameters: true, zdr: true } },
   }
   ```

   This is not obvious from either project's docs, and without it you cannot set `require_parameters`
   or `zdr` per request at all. (`<name>` is the `name` passed to `createOpenAICompatible`.)

2. **`reasoning_details` is lost between turns.** The converter sends assistant reasoning back as
   `reasoning_content`, which OpenRouter documents as an alias of the plaintext `reasoning` field.
   That is fine for models that return raw reasoning (DeepSeek, GLM, Qwen). It is **not** enough for
   models that return encrypted or summarised reasoning (Anthropic, Gemini), where OpenRouter needs
   the structured `reasoning_details` array. OpenRouter's own docs say preserving reasoning blocks
   matters *specifically for tool calling* — the model is mid-response when it pauses to call a tool.
   Practical consequence: for the shortlist above this is a non-issue (all return plaintext
   reasoning or none), but it disqualifies Claude/Gemini from a long tool loop through this provider
   unless reasoning is disabled with `reasoning: { exclude: true }` or the first-party
   `@openrouter/ai-sdk-provider` is used instead.

**Also relevant, from OpenRouter's side rather than the SDK's:**

- **`tools` must be sent on every request**, including the one carrying tool results — "so the
  router can validate the tool schema on each call". The AI SDK does this automatically.
- **Tool support is a soft routing preference by default, not a filter.** If *some* providers for a
  model support `tools`, the request goes only to those; if *none* do, the request is still routed
  and **`tools` is silently ignored**. Set `provider.require_parameters: true` to turn that into a
  hard filter. Without it, a fallback model or a `:free` variant can quietly stop calling tools.
- **`parallel_tool_calls` is never sent by this provider.** OpenRouter defaults it to true for most
  models. If sequential tool calls matter, pass it through the same `providerOptions` escape hatch.
- **Mid-stream failures arrive as `200` + an SSE error event**, not an HTTP error. Anything that
  classifies failures from `statusCode` alone will treat them as success; the AI SDK surfaces them as
  an error part, so the app's `onError` must still run after the stream starts.
- **Attribution headers are free and worth setting:** `HTTP-Referer` (required for attribution) and
  `X-OpenRouter-Title`. Pass them via the provider's `headers` option if the app ever wants to appear
  in OpenRouter rankings.
- **`@openrouter/ai-sdk-provider@3.1.0`** exists with `peerDependencies: { ai: "^7.0.0" }`. It is the
  documented AI SDK integration and would carry OpenRouter-native features (and reasoning details)
  without the passthrough hack. It is not installed today; switching is a dependency decision, not a
  requirement — the generic provider is sufficient for tools + streaming.

---

## 6. What this means for the launch catalogue

- **Do not build the catalogue on `:free` models.** 50 requests/day, shared across every user of the
  key, is a demo allowance. Free models are reasonable as a dev default or a "try it" tier behind a
  hard per-user budget, not as the default chat model.
- **If ZDR is a product promise, the free tier and Claude/GPT-first-party are both off the table**,
  and the model list shrinks to providers like DeepInfra, Bedrock, Azure, Fireworks, Together, Groq.
  Decide this before choosing the catalogue, because it changes which models can appear at all.
- **Pick 1–2 paid models, not ten.** By the numbers, `deepseek/deepseek-v4-flash-0731` is the best
  accuracy per dollar in the shortlist (0.813 at ~$0.0061/task, 22 ZDR+tools endpoints); the undated
  `deepseek/deepseek-v4-flash` is the same family one revision behind (0.798, $0.0084, 12 endpoints)
  and is the safer id to pin. `z-ai/glm-5.3-flash` is the cheapest per token *in this shortlist* and
  has by far the widest ZDR coverage (34 endpoints), which matters if ZDR is enforced.
  `qwen/qwen3.8-27b` is cheapest per task ($0.0043) but has the least ZDR headroom of the three.
- **The trade against today's local model is dollars for latency and ops.** LM Studio costs nothing
  per token but needs a GPU host, a model loaded, and a daemon that survives reboots; OpenRouter
  costs cents per conversation and removes that machine from the critical path.
- **Set `require_parameters: true` and consider `zdr` at the same time** — both are the same
  `provider` object, and the app already has a single place to construct the model.
- **Verify with the existing harness, not with these numbers.** `pnpm eval:chat` runs eleven
  scenarios against the fixture account; a τ² score says a model can drive tools in an airline
  domain, not that it can drive *these five* tools with this prompt. The numbers above are for
  shortlisting; the eval is the acceptance test.

---

## 7. Sources (all read 2026-11-03)

| Source | URL | Used for |
| - | - | - |
| Models API | https://openrouter.ai/api/v1/models | Catalogue, context, pricing, `supported_parameters`, `:free` set (451 models) |
| ZDR endpoints API | https://openrouter.ai/api/v1/endpoints/zdr | Which endpoints are ZDR-eligible, per-endpoint tool support (1,098 endpoints, 66 providers) |
| τ²-Bench Airline | https://openrouter.ai/benchmarks/tau2-bench-airline | Tool-calling accuracy and cost per task (141 models) |
| Limits | https://openrouter.ai/docs/api_reference/limits | Free-tier RPM/RPD, what credits change, 402/429 handling |
| Pricing + FAQ | https://openrouter.ai/pricing | 5.5%/8% platform fee, no markup, failed-attempt billing and counting, BYOK allowance |
| BYOK | https://openrouter.ai/docs/guides/overview/auth/byok | 5% passthrough, $25k/month allowance, priority/fallback, ZDR declarations |
| Zero Data Retention | https://openrouter.ai/docs/guides/features/zdr | Policy tiers, per-model-group ZDR, BYOK interaction, caching, CSAM carve-out |
| Provider Logging | https://openrouter.ai/docs/guides/privacy/provider-logging | Training settings, retention policy framing (table is client-rendered) |
| Provider Routing | https://openrouter.ai/docs/guides/routing/provider-selection | `require_parameters`, `data_collection`, `zdr`, sort |
| Client Tools | https://openrouter.ai/docs/guides/features/tool-calling | Tool call shape, `parallel_tool_calls`, reliability tracking |
| Auto Exacto | https://openrouter.ai/docs/guides/routing/auto-exacto | Tool Call Error Rate definition and benchmark methodology |
| Reasoning Tokens | https://openrouter.ai/docs/guides/best-practices/reasoning-tokens | `reasoning`/`reasoning_details` round-trip |
| Errors | https://openrouter.ai/docs/api_reference/errors-and-debugging | Error shape, status codes, `Retry-After` |
| Streaming | https://openrouter.ai/docs/api_reference/streaming | Final usage chunk, mid-stream error frames |
| App Attribution | https://openrouter.ai/docs/app-attribution | `HTTP-Referer`, `X-OpenRouter-Title` |
| Vercel AI SDK | https://openrouter.ai/docs/guides/community/vercel-ai-sdk | Recommended `@openrouter/ai-sdk-provider` |
| Installed SDK source | `node_modules/@ai-sdk/openai-compatible/src/chat/*` (3.0.80) | Tool serialisation, streaming accumulation, reasoning round-trip, error parsing |
| npm registry | https://registry.npmjs.org/@openrouter/ai-sdk-provider | `3.1.0`, peer `ai: ^7.0.0` |

---

## 8. Re-check before shipping

Limits and prices in this space move weekly. Before the catalogue is written into code, re-run:

```sh
curl -s https://openrouter.ai/api/v1/models \
  | jq '[.data[] | select(.supported_parameters | index("tools")) | select(.id|endswith(":free"))] | length'
curl -s https://openrouter.ai/api/v1/endpoints/zdr \
  | jq '[.data[] | select(.model_id=="<chosen-id>") | select(.supported_parameters|index("tools"))] | length'
```

and re-read the free-tier table at `openrouter.ai/docs/api_reference/limits`. If `zdr: true` is
shipped, re-check that the chosen id still has a ZDR endpoint — a provider dropping its policy
silently removes the model from the ZDR pool, and the request fails rather than degrading.
