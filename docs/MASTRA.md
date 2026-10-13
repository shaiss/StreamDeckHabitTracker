# Decision: drop `@mastra/core`, use the AI SDK directly

| | |
|---|---|
| **Status** | **Decided** |
| **Date** | 2026-10-12 |
| **Decider** | Keel (Head of Engineering) |
| **Spike** | [#66](https://github.com/shaiss/StreamDeckHabitTracker/issues/66) |
| **Overrule** | Shai (admiral) may still overrule |

This is not a draft and not a neutral options memo. The call is made: **remove
`@mastra/core` and drive the coach through the Vercel AI SDK (`ai` +
`@ai-sdk/openai-compatible`) directly.** The Redis memory tools and the
hand-rolled quality / dataset code stay.

---

## Context

The coach is a thin Mastra surface today: `Agent`, `createTool` for two memory
tools, and a bare `agent.generate(prompt)`. Everything around that — JSON
extraction, Redis hypothesis memory, slot sanitization, quality scoring, dataset
capture, model-vs-model experiment replay — is already owned by this repo.

Spike [#66](https://github.com/shaiss/StreamDeckHabitTracker/issues/66) asked
whether to lean *harder* into Mastra (structured output, scorers, datasets,
observability, memory adapters) or to thin the stack. Two proposals landed:

1. **Lean in** — adopt Mastra structured output + observability first; keep most
   hand-rolled paths as hybrid/keep.
2. **Drop Mastra** — use the AI SDK directly for the same wins (structured
   output, OTel), keep the hand-rolled memory / quality / dataset code, remove
   the wrapper.

Mastra itself is built on the AI SDK. We already depend on
`@ai-sdk/openai-compatible` for the z.ai GLM binding and the mandatory
`thinking: { type: 'disabled' }` custom fetch. The agent wrapper is one layer
above a stack we already touch.

## Decision

**Drop `@mastra/core`. Port the coach to the AI SDK. Keep Redis memory tools and
the hand-rolled quality/dataset path.**

Concretely:

- Remove `@mastra/core` from `package.json` and all imports.
- Replace `Agent` / `agent.generate` with AI SDK `generateText` (and structured
  output / repair where it earns its keep), still bound through
  `@ai-sdk/openai-compatible` with the `thinking:disabled` fetch intact.
- Re-declare `recall_hypotheses` and `update_hypotheses` as AI SDK `tool()`s over
  the same `habits:coach:memory` Redis key (issue #36 stands).
- Keep `lib/quality.js`, `lib/dataset.js`, and their tests. Drop the aspirational
  “portable into Mastra evals” framing; the corpus stays Redis-shaped for us.
- Keep `lib/coach-shape.js` dependency-free so the zero-install unit suite stays
  honest.
- Do **not** adopt Mastra memory adapters, workflows, scorers, or datasets.

## Why this wins

1. **We use a thin slice.** Three Mastra surfaces do not justify a runtime
   framework dependency in every coach function.
2. **The highest-value gap (structured output) is an AI SDK primitive**, not a
   Mastra one. Going direct removes an indirection on the path we care about.
3. **Cold start and bundle weight go down**, matching the “keep the Vercel
   footprint lean” constraint this project already documents.
4. **The GLM `thinking:disabled` guardrail gets more direct**, not less — it
   already lives on the provider `fetch` below Mastra (PR #2).
5. **The experiment runner already bypasses the agent** for byte-identical
   model comparison (`api/experiment.js` → `lib/ai.js` `chat()`). That is
   evidence the agent class is not load-bearing.

## What is kept

| Piece | Why it stays |
|---|---|
| Redis memory tools (`recall_hypotheses` / `update_hypotheses` → `habits:coach:memory`) | Serverless-safe, inspectable, already decided in #36; AI SDK has no memory layer we need |
| `lib/quality.js` + its tests | Domain-specific slot scoring; Mastra scorers would only wrap our rules |
| `lib/dataset.js` + experiment replay | Works today; “Mastra Dataset shape” was never wired to Mastra tooling |
| `extractJson` / `sanitize()` trust boundary until structured output is proven no-worse | Model output stays hostile input; domain sanitizer never leaves |
| `zaiFetch` injecting `thinking: { type: 'disabled' }` | Non-negotiable for GLM-5.x |
| Failure policy: no silent framework fallback | Surface errors; callers decide (`reactTo`/`nudgePass` no-op, others 502 / queue nothing) |
| Zero-dep unit suite boundary (`coach-shape.js` free of LLM imports) | CI unit job runs without `npm install` |

## What is removed

| Piece | Fate |
|---|---|
| `@mastra/core` dependency | Deleted from `package.json` |
| `Agent` / `createTool` usage in `lib/agent.js` | Rewritten against AI SDK |
| Mastra-routed framing in docs and comments | Replaced by AI SDK + Redis tools |
| Any plan to adopt Mastra memory, workflows, scorers, or datasets from #66 | Rejected for this stack |

## Consequences

- **Implementation work** is a focused rewrite of `lib/agent.js` and the
  `ask()` path in `lib/coach.js`, plus dep / test / doc cleanup — not a product
  redesign. Follow-up issues track the slices.
- **Measurement gate stays:** each step that changes model I/O should stay
  no-worse on the experiment / quality harness before the next step.
- **Docs and CLAUDE.md** must stop calling the coach “purely Mastra-routed”
  once the code lands; this file is the decision record, not a how-to for a
  framework we are leaving.
- **Until the rewrite merges**, production still runs on `@mastra/core`. This
  record authorizes the drop; it does not claim the drop has shipped.

## Overrule

Shai (admiral) can still overrule this decision. If overruled, reopen the
lean-in path from the first #66 proposal and treat this record as superseded —
update **Status** and point at the new decision. Until then, implementation
issues should assume AI SDK direct.

## Implementation tracking

Follow-up issues (filed from this decision) own the code change. Link them from
[#66](https://github.com/shaiss/StreamDeckHabitTracker/issues/66). Do not merge
opportunistic Mastra adoption PRs against the old spike framing.
