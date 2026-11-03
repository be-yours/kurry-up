# Updates: engine → boilerplate → client sites

## Overview

```
┌──────────────────────────┐
│ beyours              │  logique métier + shell de référence
│ (monorepo, changesets)   │  apps/reference + packages/*
└─────────┬────────────────┘
          │ ① publish npm (@be-yours/* → GitHub Packages)
          │ ② sync du shell (maintainer, voir § Maintenance)
          ▼
┌──────────────────────────┐
│ beyours-boilerplate  │  ce repo — template des sites
└─────────┬────────────────┘
          │ ③ pnpm update:engine   (canal npm)
          │ ④ pnpm update:template (canal git, remote `template`)
          ▼
┌──────────────────────────┐
│ site client (par resto)  │  zone client intouchée par ③ et ④
└──────────────────────────┘
```

Why two channels? Because the product lives in two places:

- The **business logic** (Convex functions, domain components, integrations)
  is **versioned on npm**. Update = semver bump, rollback = downgrade. This is
  the frequent, safe, granular channel.
- The **application shell** (`app/` routes, `convex/` wrappers, local
  components, configs, scripts) cannot live on npm (Next.js requires physical
  route files). It is updated through a **git merge** from the boilerplate.
  This is the rare channel (new pages, new wrappers).

A typical engine release is consumed like this: `update:engine` first; if the
release adds routes or wrappers, the boilerplate is resynced and the sites
then also run `update:template`.

## npm channel — `pnpm update:engine`

```bash
pnpm update:engine -- --check    # versions installées vs publiées
pnpm update:engine               # update DANS les ranges (^2.x)
pnpm update:engine -- --latest   # réécrit les ranges (franchit les majeures)
```

The script refuses to run in engine-link mode, chains `convex codegen` +
`typecheck` + `test` after the install, prints the per-package CHANGELOG
links, and exits non-zero if any check fails. Then commit `package.json`,
`pnpm-lock.yaml` and `convex/_generated/`.

After an update that touches the schema: `pnpm convex:deploy` (Convex
migrations are additive; breaking schema changes only land in an engine major,
with migration notes in the CHANGELOG).

## git channel — `pnpm update:template`

```bash
pnpm update:template -- --dry-run   # ce qui arriverait
pnpm update:template                # fetch + merge template/main
```

Prerequisite: a clean git tree. The `template` remote is created
automatically (by `pnpm setup` or by the script).

- **Site created by cloning** (recommended): standard incremental merge.
- **Site created with "Use this template"**: no common ancestor — do the first
  merge with `pnpm update:template -- --first`, subsequent ones are normal.

On a conflict the script prints the guide: engine zones → `--theirs`, client
zones → `--ours`. By contract the template never touches client zones, so
conflicts only appear if the site modified engine zones (avoid this, see
`docs/CUSTOMIZATION.md`).

A client-zone file the template adds after a site exists reaches that site
once, with the first `update:template` that carries it, and no update rewrites
it afterwards. `site/routes.ts` and `site/components/SiteEffects.tsx` are two of
those. If the site already has a file at that path with other contents, that
first merge reports an add/add conflict: keep yours (`git checkout --ours
<file> && git add <file>`).

`site/routes.ts` is one of those client files, and the one a site edits most
often once it has pages of its own. It ships empty and no update rewrites it, so
the pages a site registered survive every `update:template`; a route file the
site added is a brand-new file and cannot conflict either. The contract that
reads the registry lives in `lib/site-routes.ts`, an engine file, and it only
grows: a field added there is optional, so a `site/routes.ts` written before the
update keeps working.

`site/components/SiteEffects.tsx` is the other: `return null` as shipped, the
mount for the site's own browser-side code (`docs/CUSTOMIZATION.md`, "Run code in
the browser"). A dependency you added to `package.json` for it (`pnpm add lenis`,
say) is yours too: when `package.json` conflicts, keep that line.

## Patched files (boilerplate vs engine delta)

The boilerplate keeps a DELIBERATELY minimal delta against the engine's
`apps/reference`:

| File | Nature of the patch |
| --- | --- |
| `app/layout.tsx` | metadata (title, description, tab icons)/fonts/theme/layout/color scheme from the site zone, and the site's `SiteEffects` (`site/components/SiteEffects.tsx`) handed to the engine's `SiteEffectsSlot` |
| `next.config.ts` | registry `transpilePackages` + images via `site.config.ts` |
| `eslint.config.mjs` | ignores `mobile/**` + `.template/**` (`PATCH BOILERPLATE` block) |
| `package.json` | `workspace:^` deps → registry versions `^2.x` |
| `tsconfig.json` | flattened monorepo base + excludes `mobile`/`.template` |
| `.env.example` | root-path header |

Everything else (`app/`, `components/`, `lib/`, `hooks/`, `cms/`, `convex/`,
`public/`, test configs) is an exact mirror. Every patched file carries a
`PATCH BOILERPLATE` header.

The slot the layout mounts, `components/site-effects-slot.tsx`, is not a patch:
it is engine code, identical in both apps. The engine's own `app/layout.tsx`
mounts it too, with nothing inside, so the delta stays what the table says:
where the layout reads the site zone, and what it hands the slot.

## Maintaining the boilerplate (BeYours team)

Resyncing the shell from the engine is **tooled and automated**:

- **`pnpm sync:engine`** (maintainer, local) — a strict mirror from
  `apps/reference` of an engine clone (`--engine <path>`, `--check`
  for a dry run). The script protects the patched and boilerplate files,
  re-applies the `.env.example` header patch, reports the dependency diff
  (never auto-applied) and writes `.engine-sync.json` (the reference engine
  commit).
- **`.github/workflows/sync-engine.yml`** — weekday cron plus manual
  dispatch: clones the engine (secret `ENGINE_SYNC_TOKEN`, see
  `docs/SETUP-CI.md`), runs the resync and **opens a PR**
  `sync/engine-<sha>` when there is drift, with a validation checklist.

Validation before merging a sync PR:

```bash
pnpm engine:link ../beyours && pnpm typecheck && pnpm test && pnpm build
pnpm engine:unlink
```

Sites then pick it up through `update:template`.

**`site/components/SiteEffects.tsx` is write-once**, like `site/routes.ts`. The
template ships it empty and sites put their own code in it. Do not change it in
`apps/themes` after a release: a changed line, a comment included, becomes a
conflict on every site that has edited the file. Change how it is mounted in
the engine's slot (`components/site-effects-slot.tsx`) or in the layout patch.
The monorepo-only half of `tests/site-effects.test.tsx` holds the shipped
default to `return null`.

## Maintenance gate (« gel de version »)

A site is sold with one year of maintenance, renewable annually. Renewing is
what pays for the engine work, so a site that stops renewing keeps running but
stops receiving updates.

Both channels check the contract before pulling anything
(`scripts/lib/maintenance.mjs`). The check reads `licenseKey` and `licenseApi`
from `.beindigital-site.json`, asks
`GET {licenseApi}/maintenance/status?key=…` on the beyours.fr Convex
deployment, and refuses the update when the contract has lapsed — naming the
reason and the way to resume. `--check` and `--dry-run` stay open on purpose:
a lapsed client can still see what they are missing, which is the argument for
renewing.

Ways the check stays silent, all deliberate:

| Situation | Behaviour |
|---|---|
| No sentinel (this repo, the engine monorepo) | Skipped, no network call |
| A sentinel with no `licenseKey` (site provisioned before the gate) | Skipped |
| API unreachable, timeout, non-2xx | Warns, **update proceeds** |
| A key no deployment holds | Depends on enforcement, below |

The third one is the important one. An outage on our side must never cost a
paying client their update — which is also why a refusal arrives as an HTTP 200
carrying `entitled: false`, never as a 4xx: a status code the script reads as
"unreachable" would let the update through.

### Enforcement — what an unknown key is worth

`BEYOURS_LICENSE_ENFORCEMENT` on the beyours.fr Convex deployment decides, and
only the exact string `strict` closes the gate:

| Value | A key no deployment holds |
|---|---|
| unset, or anything else | `entitled: true`, `reason: "unregistered"` — the update proceeds |
| `strict` | `entitled: false`, `reason: "unknown_key"` — the update stops |

The default forgives because every site delivered before keys were handed over
carries none, and refusing theirs would freeze clients who pay. It is also the
hole: while it forgives, an invented key entitles exactly as well as a real one,
so a lapsed contract is collectable only by asking. Closing it is a one-line
console action, and it must not be taken before every delivered site is
registered — `tasks/license-key-registration-runbook.md` is that sequence.

A near miss (`Strict`, `1`, `true`) leaves the gate open on purpose: a fumbled
flag must not brick a paying client's updates.

**This gate is a courtesy, not a lock.** Anyone holding the repo can run
`git merge template/main` by hand or bump a version in `package.json`. What
actually freezes a lapsed site is revoking its access to the two private
sources:

1. **git channel** — remove the client from `be-yours/beyours-boilerplate`
2. **npm channel** — revoke the `read:packages` PAT in their `NODE_AUTH_TOKEN`
   (and their access to the `@be-yours/*` packages)

Do those, and the client hits a raw `403` with no explanation. The gate exists
so they read a sentence about their contract first.

### Issuing a key

A key is stamped on the deployment when it is created in the BeYours console
(`saDeployments.licenseKey`), and again at go-live if the deployment somehow
reached handover without one — so no site is handed over unkeyed.

Read it on the deployment's page in the console, under **Licence**: it shows the
key, and the exact line to run in the client repo, with the licence API filled
in. Sites provisioned before the gate existed have no key; the fleet page lists
them and the same panel issues one.

```bash
pnpm setup -- --license-key bys_… --license-api https://<deployment>.convex.site
```

Rotating a key invalidates the one the site holds — it has to be written back
into `.beindigital-site.json`, or the site starts answering as unknown.

**A key in our database checks nothing.** It only starts working when it is in
the site's sentinel; until then the update scripts make no call at all.

## Operational reminders

- One Convex deployment per client; storefront on ISR/static by default.
- `NODE_AUTH_TOKEN`: a **classic** personal access token with the `read:packages`
  scope, issued from an account that can read the `@be-yours/*` packages (a classic
  token cannot be limited to one scope or package), rotated every 90 days (CI: the
  `GH_PACKAGES_TOKEN` secret).
- Engine rollback: `pnpm update:engine` with the previous version pinned in
  `package.json` (git revert the update commit).
