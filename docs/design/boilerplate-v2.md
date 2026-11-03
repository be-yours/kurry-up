# Boilerplate v2 — full rewrite

> Status: ACCEPTED (2026-07-04)
> Supersedes: `monorepo-restructure.md` (deleted — see git history)

## Context

Boilerplate v1 was a pnpm+Turborepo monorepo (apps/web + an apps/mobile
placeholder + packages/backend) built up incrementally, ahead of the engine on
some versions (Next 16.2, convex 1.34) and behind it on scope (~25 convex
wrappers out of ~50 published modules, a partial storefront). The ask: start
over to get a template that is **ready to use for every client site, fully
customizable, and able to receive updates from the engine repo**.

## Decisions

### D1 — The boilerplate mirrors `apps/reference`

The engine's reference app is thick (~440 TS files: 128 routes, 160 local
components, 94 convex wrappers). A 100% npm "thin" shell is not possible
today: Next.js requires physical route files and the shell is not packaged.
So the boilerplate copies the reference app verbatim — that app is the product
being sold — and the business logic stays consumed through the
`@be-yours/*` npm packages (GitHub Packages, TS source).

Accepted consequence: the boilerplate has to be resynced whenever the engine
shell changes (procedure in § UPDATES.md, minimal patched delta: 2 app files
plus 3 configs).

### D2 — Single-app, no more monorepo

turbo/pnpm-workspace/apps/packages are gone:

- A client site = ONE Next.js app + `convex/`. The monorepo only ever served
  the hypothetical mobile app (a placeholder that was never filled in and does
  not exist in the engine).
- `packages/backend` (re-exporting `@repo/backend`) has no reason to exist any
  more: direct `@/convex/_generated/api` imports, as in the engine — which
  makes the shell copy exact, with no import rewriting.
- Per-site maintenance drops sharply (~10 clients per maintainer).

If mobile comes back, it will be a separate engine product with its own
template — not a dormant placeholder in every site.

**Addendum (same day)** — the "web + app" setup was reintroduced on request,
WITHOUT a monorepo: `mobile/` is a **self-contained** Expo app (its own
`package.json`, independent install, no private packages), wired to the same
Convex backend through `EXPO_PUBLIC_CONVEX_URL`. The dormant snapshot lives in
`.template/mobile/` (activation: `pnpm setup` option 2, or `pnpm add:mobile`);
the web root stays single-app. For as long as the engine ships no mobile
product, `mobile/` is a **client zone** (a starting point, with no update
channel). One-shot creation: `scripts/create-site.mjs` (clone + GitHub repo +
install + config + push).

### D3 — Versions aligned with the engine, never ahead

next 16.2.12, convex 1.44.0 (exact), better-auth 1.6.33 (exact),
@convex-dev/better-auth ^0.12.6: the combination the engine tests against.
v1 had bumped ahead at the cost of workarounds (a custom auth proxy,
`ignoreBuildErrors: true`). Version bumps come from the engine; the boilerplate
follows.

The rule is *aligned*, not *frozen*. `convex` was held at 1.31.7 after an
incident where two copies of it produced two React contexts and crashed the
admin. That is now prevented differently — **every manifest in the monorepo
declares the same exact `convex`**, so no resolution can pick a second copy.
When the engine moves, `.template/mobile/package.json` moves with it; it was
missed the last time and handed clients a stale client library.

### D4 — Two update channels

- **npm** (`update:engine`): semver-versioned business logic. Frequent,
  granular, rollbackable.
- **git** (`update:template`, the `template` remote): shell + wrappers +
  configs. Rare. Merges cleanly because sites only modify the client zone.

Sites are created by **cloning** (shared history → incremental merges); "Use
this template" is supported through `--first` (--allow-unrelated-histories).

### D5 — The client/engine zone contract

Client zone = `site.config.ts` + `site/` (theme.css, fonts.ts, routes.ts,
components/) + `public/` + `.env*`. Engine zone = everything else, not modifiable on a
site. The only two engine files the boilerplate patches (`app/layout.tsx`,
`next.config.ts`) carry a `PATCH BOILERPLATE` header.
Runtime customization (content, opening hours, CMS section colors) stays in
Convex through the dashboard — the contract only covers build time.

### D6 — engine-link mode for development and local CI

`pnpm engine:link <clone>` writes pnpm `link:` overrides pointing at a local
(installed) engine clone, which allows install/typecheck/build without a
`NODE_AUTH_TOKEN` and lets you develop the engine and a site in parallel.
Guardrails: preinstall skips the token check in link mode, CI rejects a
`package.json` containing `link:`, and `engine:unlink` purges the overrides
and the contaminated lockfile.

### D7 — No lockfile committed in the first commit

The registry lockfile can only be generated with a token. The first tokened
`pnpm install` (maintainer or CI) produces it; it is committed at that point
and CI switches to `--frozen-lockfile` automatically.

## Risks being watched

1. **Boilerplate ↔ engine drift**: the copied shell ages if engine releases do
   not trigger a resync. Mitigation: documented procedure, `repository_dispatch`
   automation in the backlog.
2. **Sites patching the engine zone**: conflicts at `update:template` time.
   Mitigation: documented contract (CUSTOMIZATION.md), a resolution guide in
   the script, and review of client repos.
3. **TS-source packages in node_modules**: requires an exhaustive
   `transpilePackages` (next.config.ts) — verified by the CI build.
