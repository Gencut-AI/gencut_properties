# Development

## Requirements

- Node ≥ 22.18 (runs TypeScript directly), pnpm 10
- PostgreSQL 16 server and client binaries (`pg_config`, `initdb`, `pg_ctl`, `psql`), or
  Docker for a Postgres container

## First run

```bash
pnpm install
scripts/dev-db.sh start                    # prints: export TEST_DATABASE_URL=...
export TEST_DATABASE_URL='...'
pnpm check                                 # lint + typecheck + all tests
```

With Docker instead of local binaries:

```bash
docker run -d --name gencut-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

## Tests

| Suite | Where | Needs |
| --- | --- | --- |
| Domain | `packages/core/test` | nothing |
| Schema and migrations | `packages/db/test` | `TEST_DATABASE_URL` (each file creates and drops its own database) |
| Repository lint | `scripts/lint.test.ts` | nothing |

Coming: Playwright end-to-end at 390 px and 1440 px (M1), recorded-response agent tests (M3).

## Workflow

Branch `m<milestone>/<topic>` → small commits → `pnpm check` green → pull request → CI green
→ merge. Update `docs/` in the same pull request when architecture changes.

## Secrets

Never commit real values. `.env.example` lists the variable names. Production values live
in Netlify, Supabase and GitHub secret stores. `pnpm lint` and CI gitleaks both scan.

## Sign-in email (Supabase Auth)

Sign-in is an emailed link (`signInWithOtp`, `app/sign-in/actions.ts`), completed by
`app/auth/confirm/route.ts`. The route accepts the token-hash link, which works in any browser,
and the PKCE code link, which works only in the browser that asked for it. Every Supabase
project that runs this app needs the setup below, or a link opened on another device fails
(D-034).

1. **Authentication → Emails → SMTP Settings:** custom SMTP through Resend (Supabase's built-in
   sender allows only a few emails an hour and locks the templates).
   Host `smtp.resend.com`, port `465`, username `resend` (lowercase), password: a Resend API key
   with sending access to the verified domain; sender `noreply@mail.gencut.ai`.
2. **Authentication → Emails → Templates:** in both **Magic link or OTP** and **Confirm sign up**,
   the link is
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/home`.
3. **Authentication → URL Configuration:** Site URL is the app's public address
   (`https://gencutv1.netlify.app`); redirect URLs cover it, deploy previews and
   `http://localhost:3000/**`.

Check: ask for a link on one device and open it on another; it should land on Home.
