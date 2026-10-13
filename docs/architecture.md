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

## Status (2026-10-13)

| Component | Status |
| --- | --- |
| `packages/core` | Built and tested: state machines, permissions, gate, scoring, audit types |
| `packages/db` | Built and tested: migrations 0001–0005, runner, schema tests |
| `packages/services` | Accounts, business profile, discovery (coverage, import storage, scoring), opportunity feed; all audited and tenant-checked |
| `apps/web` | Sign-in, onboarding, profile, home, opportunities feed and detail |
| `apps/worker` | Discovery job: FL DOR roll import and scoring, scheduled on GitHub Actions (D-009) |
| CI | Green on GitHub: frozen install, lint, typecheck (incl. web), tests on Postgres 16, web build, gitleaks |

See `decisions.md` for why each choice was made.
