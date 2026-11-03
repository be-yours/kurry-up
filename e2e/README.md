# End-to-end tests

510 Playwright tests. Until August 2026 none of them had ever run — neither
locally nor in CI — so this file exists to make the setup explicit rather than
tribal.

## Why they were inert

Two independent gates, and neither says anything when it closes.

**Locally**, `playwright.config.ts` decides:

```ts
const hasRealBackend = !process.env.NEXT_PUBLIC_CONVEX_URL?.includes("placeholder")
```

Without a real Convex URL the `setup` and `admin` projects are not registered at
all. Playwright then reports success on the handful of public tests it did run —
there is no "skipped" line for a project that was never declared.

**In CI**, `.github/workflows/ci.yml` *was* gated on
`vars.CONVEX_E2E_ENABLED == 'true'`, and then again on
`secrets.E2E_NEXT_PUBLIC_CONVEX_URL` being non-empty. Neither was ever set, so
the job was skipped on every run and the check reported that skip as success.

Three ways to be green while testing nothing. Anyone reading a passing PR would
reasonably conclude the suite ran.

> **Current state.** The gate is gone. The `e2e` job in `.github/workflows/ci.yml`
> downloads and starts its own `convex-local-backend`, deploys the functions to
> it, builds, seeds and runs the whole suite — no Convex account and no `E2E_*`
> secrets, which had been the stated reason for keeping it off. `E2E Status` is
> the aggregate to require on `main`; it fails on a skip as well as a failure.
> `scripts/assert-e2e-ran.mjs` then fails the job unless `setup`, `public` and
> `admin` each report tests and at least 100 ran, so a suite that quietly runs
> nothing can no longer be green.

## Running them locally

Everything below targets a deployment you are willing to see wiped: the seed
script creates accounts, and the suite writes orders, products and team members.

**1. Link a Convex deployment** (once). Writes `CONVEX_DEPLOYMENT` and
`NEXT_PUBLIC_CONVEX_URL` into `.env.local`, and pushes the functions:

```bash
cd apps/reference && npx convex dev
```

**2. Set what the BACKEND reads.** A Convex function does not see `.env.local` —
these have to live on the deployment:

```bash
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
```

```bash
npx convex env set ENCRYPTION_KEY "$(openssl rand -hex 32)"
```

```bash
npx convex env set SITE_URL http://localhost:3000
```

`ENCRYPTION_KEY` must be exactly 64 hex characters — it is the AES-256-GCM key
protecting the payment-provider tokens in `paymentConnections`.

**2 bis. Four variables a PRODUCTION server refuses to start without.**

`instrumentation.ts` validates them at boot, so `next start` dies before serving
anything. A dev server tolerates their absence, which is why this only bites
when running against a build. Placeholders are enough — no test reaches S3, SES
or OpenAI today:

```bash
export AWS_REGION=eu-west-3 AWS_ACCESS_KEY_ID=placeholder AWS_SECRET_ACCESS_KEY=placeholder OPENAI_API_KEY=sk-placeholder
```

**3. Set what the RUNNER reads.** Copy `.env.e2e.example` to `.env.e2e` and fill
it in, or export the variables. The one that matters most:

```bash
export SEED_PASSWORD="a-throwaway-password"
```

`scripts/seed-users.mts` writes it and `e2e/auth.setup.ts` signs in with it. The
two must agree. Neither hardcodes it — `auth.setup.ts` used to carry a literal,
and not even the matching one, so the setup only worked on the machine where
they happened to coincide.

**4. Seed the accounts**, with the dev server running:

```bash
pnpm dev
```

```bash
cd apps/reference && npx tsx scripts/seed-users.mts
```

Six accounts, all `test.*@beindigital.fr`: owner (`client_admin`), manager,
cuisine (`kitchen`), service (`waiter`), and two customers. They exercise the
role boundaries the authorisation tests assert.

**5. Run:**

```bash
cd apps/reference && pnpm test:e2e
```

Check the header names three projects — `setup`, `public`, `admin`. If it names
only `public`, the backend was not detected: re-read step 1 before reading any
result as a pass.

## CI

Nothing to enable, and nothing to provision. The `e2e` job in
`.github/workflows/ci.yml` runs on every pull request and every push to `main`.

It downloads `convex-local-backend` (pinned in `CONVEX_BACKEND_VERSION`),
starts it on the runner, writes an `.env.local` pointing at it, builds, deploys
the functions self-hosted, seeds an owner account and runs the suite against
that. No Convex account, no deploy key, and no `E2E_*` secrets — the absence of
which had been the stated reason for leaving the suite switched off. The only
secret it needs is `GH_PACKAGES_TOKEN`, which the rest of CI already uses.

`scripts/assert-e2e-ran.mjs` then fails the job unless `setup`, `public` and
`admin` each report tests and at least 100 ran in total.

**The required check is `E2E Status`, never `E2E tests (Playwright)`.** A job
that does not run reports `skipped`, and GitHub counts a skip as satisfied;
`E2E Status` is an aggregate that runs unconditionally and fails on skip,
cancel and failure alike.

The Deliveroo suites no longer skip themselves: the 13 tests that needed live
credentials — 26 across the two twins — were deleted in #635, having skipped on
every run the repository ever made. What remains runs with no credential at all.

## Before trusting a green run

Neutralise something the suite claims to cover and confirm it goes red. A suite
that has never failed has never been shown to work: that is exactly how these
510 tests stayed inert for months while reporting success.
