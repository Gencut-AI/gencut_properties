# Architecture

One TypeScript codebase, one Postgres database, two running processes.

```
 Web app / PWA            WhatsApp webhook
 (Next.js, apps/web)      (route in apps/web, linked users only)
          \                  /
           v                v
   Shared domain services — packages/core
   campaigns · opportunities · agent director · compliance gate
           |                         |
           v                         v
   Postgres + job queue  --jobs-->  Worker (apps/worker)
   (Supabase, pg-boss)              agent runs · renders · sends
                                     |
                                     v
   Replaceable providers behind interfaces:
   ModelRouter (LLMs) · MediaProvider (renderer) · SourceAdapter (data) · Channel (email, tasks)
```

## Principles

- **One source of truth.** Every interface calls `packages/core`; no rule is duplicated.
- **Fail closed.** The compliance gate blocks on missing information.
- **Defense in depth.** Service-layer checks, then database constraints and triggers, then
  row-level security (once Supabase auth lands).
- **Observable agents.** Every agent run records provider, model, tokens, cost, latency and
  outcome (`agent_runs`, M3).
- **Provenance.** Every fact shown to a user links to a `source_records` row.

## Status (2026-10-10)

| Component | Status |
| --- | --- |
| `packages/core` | Built and tested: state machines, permissions, gate, scoring, audit types |
| `packages/db` | Built and tested: migrations 0001–0002, runner, schema tests |
| `apps/web` | Not started — npm registry unreachable from the build session |
| `apps/worker` | Not started (M3/M4) |
| CI | Workflow written; not yet run on GitHub |

See `decisions.md` for why each choice was made.
