# Agents

All agents are registered in one registry and orchestrated by the **Director** (the
central orchestrator — distinct from the Film Crew's **Creative Director**).

## Contract every agent follows

- **Input and output schemas** (validated; invalid output is a failed run, not a guess).
- **Declared tools** — an agent can call only the tools in its contract.
- **Permissions** — no agent sends messages, writes code, or changes configuration,
  prompts, permissions or policies. Sending is the executor's job, after approval and the
  compliance gate.
- **Model role, not model name** — `reasoning`, `fast` or `creative`; the ModelRouter maps
  roles to models in configuration.
- **Observable runs** — provider, model, tokens, cost, latency, status recorded per run.
- **Self-evaluation** — each agent scores its output against its criteria (below).

## MVP roster

| Agent | Job | Self-evaluation criteria |
| --- | --- | --- |
| Director | Plans a run: which agents, in what order, with what inputs | Plan completeness |
| Scout | Turns source records into scored opportunities (uses `scoreSellerOpportunity`) | Relevance, data quality, source quality |
| Research | Gathers and cites facts about an opportunity | Completeness, accuracy, source coverage |
| Strategy | Chooses objective, angle and channels | Relevance, personalization, commercial value |
| Creative Director | Concept, tone, visual direction, narrative, CTA | Brand fit, campaign alignment |
| Copy | Email, letter, captions, posts, follow-ups | Personalization, clarity, professionalism, CTA |
| QC | Checks every asset: facts vs sources, brokerage name, fair-housing language, artifacts | Errors caught on fixture set |

Later: the full Film Crew (Producer, Scriptwriter, Video Prompt Engineer, Editor, Social
Media, Brand).

## Learning loop

Outcomes are recorded per campaign; weekly recommendations cite sample sizes. Proposed
changes to prompts, scoring weights or strategies become **experiments** in the registry
(hypothesis, change, baseline, metrics, result, confidence, deployment status) and reach
production only after human approval.

## Status (14 Oct 2026)

- **Scout:** deterministic scoring, `seller-v3` (`packages/core/src/opportunity/scoring.ts`, `docs/scoring.md`).
- **Copy + QC (campaign drafts):** one model call through the ModelRouter (`packages/services/src/models.ts`), with the prompt and the QC checks in `packages/core/src/campaign/draft.ts`. QC is deterministic: grounding, fair housing, sensitivity and brokerage name. Every call is logged in `model_runs` with cost.
- Director, Research, Strategy as separate agents, and the Film Crew: not built yet.
