# Jev as the router's decision classifier

Researched 2026-10-06 for `backend/src/model_router.rs`.

## Summary

- **Jev was found.** It is TypeSafe AI's hosted "System One" decision model: it does not generate text, it answers typed questions (choice, score, yes/no) about a piece of text and returns calibrated probabilities plus a confidence value ([typesafe.ai](https://typesafe.ai), [docs](https://docs.typesafe.ai/)).
- One HTTPS `POST /v1/systemone` call with a bearer key; plain JSON, so Rust can call it with any HTTP client ([quickstart](https://docs.typesafe.ai/introduction/quickstart)).
- It can produce `task` (choice) and `tier` (score) directly, with confidence. It **cannot** produce the free-text `reason`; the router has to write that itself.
- Roughly 100 ms and well under a thousandth of a cent per route, against 6–8 s and about $0.004 for the Haiku call. The costs: a second cloud vendor with its own API key, a young service whose rate limits change without notice, and no stated retention period for inputs.
- Recommendation: put Jev first, with the keyword router and Haiku behind it. Act on Jev's answer when its confidence is high, and fall back to Haiku when it is low.

## What it is

- TypeSafe AI calls Jev "the first System One model": you "send Jev structured questions and get typed decisions with probabilities and confidence that your software can act on" ([typesafe.ai](https://typesafe.ai), [docs intro](https://docs.typesafe.ai/)).
- It is a classifier, not a chat model. It returns a choice, score or probability, never prose ([API reference](https://docs.typesafe.ai/api.md)).
- Labels are zero-shot. You declare the options and a one-line rubric for each in the request, so no training is needed. When options get confused, the docs say to use structured criteria with `what`, `not_for` and `examples` ([Choice](https://docs.typesafe.ai/primitives/choice.md)).
- TypeSafe publishes an "Intent routing" pattern, which is exactly this use case ([intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)).
- Availability: the official TypeSafe AI account posted "Jev is now available to everyone. No waitlist." and "All users start with $5 in credit (~120 million tokens)" ([post 1](https://x.com/typesafeai/status/2101786156572823624), [post 2](https://x.com/typesafeai/status/2101786280946499671); I found these through search and could not fetch them directly). A secondary report that new signups were paused on 22 September 2026 because of demand is **unverified**. Check [console.typesafe.ai](https://console.typesafe.ai/) before planning on it.
- Other candidates ruled out: "Jev Router" on OpenRouter is a different product built on Jev. It picks *which LLM* answers a prompt, not which of our agents should run ([OpenRouter docs](https://openrouter.ai/docs/guides/routing/routers/jev-router)). Pipecat ships a `JevClassifier` wrapper, which is useful as reference code ([Pipecat](https://docs.pipecat.ai/api-reference/server/classifiers/jev)). Jev is also listed on the Vercel AI Gateway, OpenRouter and Cloudflare AI Gateway according to a secondary source (**unverified**).

## API

| Item | Detail | Source |
|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | [quickstart](https://docs.typesafe.ai/introduction/quickstart) |
| Auth | `Authorization: Bearer $TYPESAFE_API_KEY`; keys from console.typesafe.ai/keys | [quickstart](https://docs.typesafe.ai/introduction/quickstart) |
| Request | `{ "state": string\|object\|array, "model": "jev-latest", "questions": { "<key>": Question } }` | [API](https://docs.typesafe.ai/api.md) |
| Question types | `choice` (criteria = map of option to rubric, max 255 options); `score` (criteria = ordered array, 2–10 levels); `noul` (yes/no; optional `criteria.true/false`) | [API](https://docs.typesafe.ai/api.md), [Score](https://docs.typesafe.ai/primitives/score.md) |
| Choice answer | `choice`, `probabilities` (option → p), `confidence` 0–1 | [Choice](https://docs.typesafe.ai/primitives/choice.md) |
| Score answer | `score` (probability-weighted, 0-based level index, e.g. 1.43), `probabilities`, `legend`, `confidence` | [Score](https://docs.typesafe.ai/primitives/score.md) |
| Noul answer | `noul`: 0 (no) to 1 (yes) | [API](https://docs.typesafe.ai/api.md) |
| Usage | `usage.input_tokens`, `usage.output_tokens` | [API](https://docs.typesafe.ai/api.md) |
| Errors | 401 bad key, 422 validation, 429 rate limit, 529 overloaded | [API](https://docs.typesafe.ai/api.md) |
| Models | `jev-1.13.0`; aliases `jev-latest`, `jev-preview`. Text only | [Models](https://docs.typesafe.ai/models.md) |
| Context | 64k tokens per request; 32k for `state` plus the longest question | [Models](https://docs.typesafe.ai/models.md) |
| Pricing | $0.042 per million input tokens; output tokens free | [Models](https://docs.typesafe.ai/models.md) |
| Rate limits | 100K tokens/s, 80 requests/s, "adjusting dynamically… can change without notice" | [Models](https://docs.typesafe.ai/models.md) |
| Latency | Homepage demo: 0.114 s; Pipecat: "about a tenth of a second". Vendor claims, not measured here | [typesafe.ai](https://typesafe.ai), [Pipecat](https://docs.pipecat.ai/api-reference/server/classifiers/jev) |
| SDKs | Python (`typesafe-sdk`) and JavaScript/TypeScript. No Rust SDK; the docs say to call the HTTP API directly from any language | [SDKs](https://docs.typesafe.ai/sdk.md), [quickstart](https://docs.typesafe.ai/introduction/quickstart) |
| Retries | Pipecat's client retries 429 and 529 with exponential backoff (3 attempts, 10 s timeout) | [Pipecat client source](https://reference-server.pipecat.ai/en/latest/_modules/pipecat/classifiers/jev/client.html) |

**Confidence guidance**: confidence measures how concentrated the probabilities are, where 0 means evenly spread and 1 means certain. TypeSafe suggests acting automatically above about 0.9, confirming or flagging between 0.5 and 0.9, and escalating below 0.5, "depend[ing] on the stakes" ([Confidence](https://docs.typesafe.ai/confidence.md)).

**Privacy and data location** (this matters for a local-first app):
- "We will not train or fine tune any … models on your prompts or other Input" ([privacy policy](https://typesafe.ai/legal/privacy-policy), last updated 19 November 2025).
- "The Services are hosted in the United States" ([privacy policy](https://typesafe.ai/legal/privacy-policy)).
- No specific retention period for API inputs. Data is kept "as long as reasonably necessary" ([privacy policy](https://typesafe.ai/legal/privacy-policy)), or "as long as necessary taking into account the purpose" ([DPA](https://typesafe.ai/legal/data-processing)).
- Zero data retention only for enterprise customers, by contacting sales ([legal](https://docs.typesafe.ai/legal.md)). Subprocessors are listed at trust.typesafe.ai/subprocessors (not reviewed).

## Fit with model_router.rs

The current contract (`model_router.rs`):
- `route(goal, folder, attachments) -> Decision`.
- The model returns `Answer { task: code|question|browse|assistant, tier: fast|balanced|strongest, reason: non-empty String }`.
- `shape()` then fixes access per task, forces `Fast` for browse, raises assistant to at least `Balanced`, and turns a question with no project into assistant.
- Any failure returns `keyword_route`.
- Only the goal text and the *names* of the folder and files are sent (`message()`).

How each part maps onto one Jev request:

- **state**: the existing `message()` output, unchanged. The privacy property stays the same: names only, never file contents.
- **task**: a `choice` question whose criteria are the four task definitions from `SYSTEM_PROMPT`, with the "personal goals are never code" rule written as `not_for` and `examples` (e.g. "play jcole" listed as a browse example and as not-for-code).
- **tier**: a `score` question with three levels (quick or simple, typical, broad or architectural). Round `score` to an index 0/1/2 to get Fast, Balanced or Strongest. `shape()` already overrides tier for browse and assistant, so tier only matters for code and question.
- **reason**: Jev cannot produce one. Options:
  1. A fixed sentence per task ("Music and videos play in Chrome, so this goes to the browser."). This is simple and honest, but it is less specific than Haiku's sentence.
  2. Template the sentence from the winning criterion's rubric text.
  3. Only when confidence is low, ask Haiku and keep Haiku's reason.

  `parse()` currently rejects an empty reason, so a Jev path must always fill one.
- **confidence gate**: if `task.confidence` is at or above a threshold (start around 0.9, per TypeSafe's guidance), accept Jev's answer. Otherwise fall through to today's Haiku call, and `keyword_route` stays the final fallback. Optionally, cut the Haiku call short when the keyword router agrees with Jev's top choice.
- **Cache and timeout**: the existing cache works unchanged. Use a short timeout for Jev (about 2 s) instead of 20 s, since the expected answer time is about 0.1 s. Treat 401, 422, 429 and 529 as "fall through".
- **Plumbing**: the backend has no HTTP client today (`backend/Cargo.toml` lists chrono, serde, serde_json, trash, uuid and windows). A blocking `ureq` call fits the current synchronous `route()` best. Store the API key as a user setting, not in the repo. Without a key the router behaves exactly as today.
- **Cost per route**: the request is a few hundred tokens of rubric plus the goal, so about 500 tokens at $0.042/M, around $0.00002. That is about 200 times cheaper than $0.004. This is an estimate from the published price, not measured.

## Recommendation

**Combine them, with Jev first.** Jev's typed choice-and-score model matches this router's job closely. It would cut the "Planning…" wait from 6–8 s to about 0.1–0.5 s on most goals and makes routing nearly free. Keep Haiku for low-confidence goals and for a better reason sentence, and keep the keyword router as the offline fallback.

Trade-offs against the Haiku-only setup:
- **Speed and cost**: much better (vendor figures; check with a few dozen real goals before switching).
- **Reason quality**: worse. The reason becomes a template unless Haiku is called.
- **Calibrated confidence**: a gain. Haiku gives no usable "I'm not sure", while Jev's confidence makes the fallback decision principled.
- **Local-first and privacy**: a new US-hosted third party sees every goal. Its policy says no training on inputs, but no retention period is stated, and zero retention is enterprise-only. Haiku already sends goals to Anthropic, so the exposure is similar in kind, but it adds a vendor. It also needs a separate account and API key, while the Claude CLI reuses the user's existing login. Make Jev opt-in.
- **Maturity**: the service launched in September 2026, rate limits "can change without notice", and signups may have been paused (unverified). Design it so Jev can disappear and routing still works, which the fallback chain above already does.

## Sources

- https://typesafe.ai
- https://docs.typesafe.ai/
- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/introduction/quickstart
- https://docs.typesafe.ai/api.md
- https://docs.typesafe.ai/models.md
- https://docs.typesafe.ai/primitives/choice.md
- https://docs.typesafe.ai/primitives/score.md
- https://docs.typesafe.ai/confidence.md
- https://docs.typesafe.ai/patterns/intent-routing.md
- https://docs.typesafe.ai/sdk.md
- https://docs.typesafe.ai/legal.md
- https://typesafe.ai/legal/privacy-policy
- https://typesafe.ai/legal/data-processing
- https://x.com/typesafeai/status/2101786156572823624
- https://x.com/typesafeai/status/2101786280946499671
- https://docs.pipecat.ai/api-reference/server/classifiers/jev
- https://reference-server.pipecat.ai/en/latest/_modules/pipecat/classifiers/jev/client.html
- https://openrouter.ai/docs/guides/routing/routers/jev-router
