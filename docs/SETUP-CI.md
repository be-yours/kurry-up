# CI & secrets setup — maintainer runbook

Everything that has to be configured once on the **boilerplate** repo, then on
every **client site** repo. Without these settings the workflows degrade
cleanly (jobs skipped with a notice) but do not do their job.

## 1. Boilerplate repo

### Secrets (Settings → Secrets and variables → Actions → Secrets)

| Secret | Contents | Used by |
| --- | --- | --- |
| `GH_PACKAGES_TOKEN` | classic `read:packages` PAT | `ci.yml` (install) |

> `ENGINE_SYNC_KEY` / `ENGINE_SYNC_TOKEN` are no longer needed. They fed
> `sync-engine.yml`, which pulled the engine from a separate repository.
> Since the merge the direction is reversed: the `beyours` monorepo pushes to
> this repository through its own `publish-mirror.yml`, using a secret held on
> the monorepo side. If those two secrets still exist here, they can be
> deleted.

### The lockfile

This repository is a generated mirror: its `pnpm-lock.yaml` is regenerated on
every sync by `scripts/publish-mirror.mjs` on the monorepo side, and committed
here. Nothing to do.

In a **client site**, however, right after the first clone:

```bash
export NODE_AUTH_TOKEN=ghp_xxx
pnpm install
git add pnpm-lock.yaml && git commit -m "chore: lockfile registre" && git push
```

From then on CI switches automatically to `--frozen-lockfile` and transitive
versions are pinned (we have already been bitten by drift: an eslint plugin
newer than the one the engine tested against — hence the
`eslint-plugin-react-hooks` override in `package.json`, worth revisiting once
the lockfile is in place).

### `main` branch protection

Required status check: `Lint + Test + Build`. Optional: `E2E tests
(Playwright)` once they are enabled.

## 2. Client site repos

Same settings as the boilerplate, **without** `ENGINE_SYNC_TOKEN` (sites do
not sync against the engine — they take template updates through
`pnpm update:template`).

### Playwright E2E — on by default, nothing to configure

Nothing. The `e2e` job runs on every pull request and needs no variable and no
secret beyond the `GH_PACKAGES_TOKEN` the rest of CI already uses: it downloads
`convex-local-backend`, starts it on the runner, deploys the functions to it,
seeds an account and runs the suite against that.

It used to be gated on a `CONVEX_E2E_ENABLED` variable plus a set of `E2E_*`
secrets pointing at a Convex deployment somebody had to create. Nobody created
them, so the job was skipped on every run — and a skipped job reports neutral,
which GitHub counts as satisfied. The check was green because nothing ran.

**Require `E2E Status`, never `E2E tests (Playwright)`.** `E2E Status` is an
aggregate that runs unconditionally and fails on anything that is not a real
pass, skips included. Requiring the test job itself reintroduces exactly the
bug above.

## 3. Vercel (per site)

- Env vars: the `[REQUIS]` entries from `.env.example` plus `NODE_AUTH_TOKEN`
  (install).
- `pnpm convex:deploy` for the production backend, then carry over the
  production `NEXT_PUBLIC_CONVEX_URL` / `CONVEX_SITE_URL`.
- `NEXT_PUBLIC_SENTRY_DSN` — the client's **own** Sentry project, one per site.
  Left empty, production errors are reported to nobody. It is a `NEXT_PUBLIC_`
  variable, so it takes effect at the next build, not at the next request.
  Optionally `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` for readable
  stack traces — all three or none. See [`SENTRY.md`](SENTRY.md).

## 4. Test routes in production

The routes in the `app/(test)/` group (Playwright harnesses, e.g.
`/address-test`) return 404 in production through `app/(test)/layout.tsx` (a
boilerplate guard). To re-enable them exceptionally:
`NEXT_PUBLIC_ENABLE_TEST_ROUTES=true`.
