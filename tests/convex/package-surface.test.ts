/// <reference types="vite/client" />

/**
 * The reverse of `public-surface.test.ts` (#524).
 *
 * That file asks whether every function this app REGISTERS has a caller. This
 * one asks the other question, which nothing asked: whether every complete
 * Convex definition the engine package EXPORTS is wrapped by an app at all.
 *
 * WHY IT MATTERS. A `{ args, handler }` in `@be-yours/convex-functions` is
 * not reachable by anything until an app wraps it in `query`, `mutation` or one
 * of the guarded forms. Unwrapped, it compiles, it is covered by its unit tests,
 * it appears in the package's exports — and no screen, script or webhook can
 * call it. It is indistinguishable from a working feature except by looking.
 *
 * Three of them were features the product needed and nobody could reach:
 * `emailSegments.refreshCount` was the only writer of a real subscriber count,
 * so the campaign wizard read « 0 abonnés » for every segment ever made;
 * `blog.deleteTag` meant tags accumulated for the life of an establishment; and
 * `translations.bulkUpsert` could not be wrapped as written at all, its
 * `storeId` sitting inside each array element where no store guard can read it.
 *
 * WHAT THE LEDGER BELOW IS, AND IS NOT. It is every definition no app
 * references today, and it is NOT a list of approved ones — most have not been
 * looked at. Pinning it turns "how many are there?" from a question nobody was
 * asking into a number that cannot grow silently: a new unwrapped definition
 * fails, and wrapping one fails too until the entry comes out. Each entry that
 * gets judged should leave, either by being wrapped or by being deleted with
 * its reason, the way `cmsPublish.publishPage` and `translations.bulkUpsert`
 * were.
 *
 * WHY A NAME MATCH. The apps wrap through `blogDefs.deleteTag.handler` and
 * through a dozen other spellings, and a parser for all of them would be a
 * second implementation of the wrapping convention. A name that appears nowhere
 * in either app's `convex/` is unreachable whatever the spelling, which is the
 * direction this file needs to be exact in. The opposite error — a name that
 * collides with an unrelated identifier and reads as wrapped — makes the ledger
 * shorter than the truth, never longer, so it can hide an entry but never
 * invent one.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import { IN_MONOREPO, MONOREPO_ROOT } from "../lib/repo-layout"

/*
 * WHY THIS SUITE DOES NOT RUN IN A DELIVERED SITE.
 *
 * It ships, like every file under `tests/`. It used to derive its roots as
 * `join(process.cwd(), "../..")` — an address only this monorepo has — and in
 * the tree a client receives that resolves to the directory ABOVE the
 * repository, so all five cases died on ENOENT and the mirror refused to sync.
 *
 * The right answer here is to stand down rather than to re-address, which makes
 * it the exception among its neighbours. `enginePackageFile` would find the
 * package half — `convex-functions` publishes `src`, so a client has it — but
 * the question this file asks is *is this definition wrapped by AN APP*, and
 * "an app" means `themes` AND `reference` together. A client has one, and the
 * `UNWRAPPED` ledger below was measured against both: read against one, every
 * definition the sibling wraps would read as unwrapped. That is not a failure a
 * client could act on — the ledger is the agency's, and so is the convention it
 * pins.
 *
 * `IN_MONOREPO` is a positive test for the engine checkout (`pnpm-workspace.yaml`
 * next to `packages/`), not "the file I wanted is missing" — a suite that
 * shrugged at a missing file would be the vacuum this ledger exists to refuse.
 */
const PACKAGE_SRC = join(MONOREPO_ROOT ?? "", "packages/convex-functions/src")

/**
 * Definitions no app references. Not approved — unreviewed.
 *
 * Remove an entry when it is wrapped, or when it is deleted with its reason in
 * the file it lived in.
 */
const UNWRAPPED = [
  "bidSubscription.getByStripeCustomerId",
  "bidSubscription.getByStripeSubscriptionId",
  "blog.listByCategory",
  "blog.listByTag",
  "blogAutoConfig.listByOwnerId",
  "blogAutoUsage.getByOwnerIdPeriod",
  "cms.getBlockDraft",
  "cms.getPage",
  "cmsMedia.getMedia",
  "emailCampaigns.listByStatus",
  "emailCampaigns.listRecent",
  "emailSubscribers.addTag",
  "emailSubscribers.getByEmail",
  "emailSubscribers.removeTag",
  "emailSubscribers.reverseMetadataIncremental",
  "emailTemplates.listByCategory",
  "externalProductMappings.removeAllByStorePlatform",
  "favorites.clearAll",
  "favorites.listByUserAndStore",
  "kitchenTickets.assignStation",
  "kitchenTickets.assignTo",
  "kitchenTickets.getByStation",
  "kitchenTickets.incrementPrintCount",
  "orders.getByViewToken",
  "paymentConnections.getByProvider",
  "products.getByCategory",
  "products.getFeatured",
  "storeIntegrations.toggleAutoAccept",
  "translations.getByLanguage",
  "translations.getForEntity",
].sort()

/** `export const name = {` immediately followed by an `args:` line. */
const DEFINITION = /^export const (\w+)\s*=\s*\{\s*\n\s*args:/gm

/** Every `module.name` the package exports as a complete Convex definition. */
function packageDefinitions(): string[] {
  const found: string[] = []
  for (const file of readdirSync(PACKAGE_SRC)) {
    if (!file.endsWith(".ts")) continue
    const source = readFileSync(join(PACKAGE_SRC, file), "utf8")
    // Not `module`: Next's `no-assign-module-variable` rule forbids the name.
    const moduleName = file.replace(/\.ts$/, "")
    for (const [, name] of source.matchAll(DEFINITION)) found.push(`${moduleName}.${name}`)
  }
  return found.sort()
}

/** Both apps' `convex/` trees as one string. They are held byte-identical. */
function appConvexSources(): string {
  let haystack = ""
  for (const app of ["themes", "reference"]) {
    const dir = join(MONOREPO_ROOT ?? "", "apps", app, "convex")
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".ts")) haystack += "\n" + readFileSync(join(dir, file), "utf8")
    }
  }
  return haystack
}

function unwrapped(): string[] {
  const haystack = appConvexSources()
  return packageDefinitions()
    .filter((key) => !new RegExp(`\\b${key.split(".")[1]}\\b`).test(haystack))
    .sort()
}

describe.skipIf(!IN_MONOREPO)("every definition the engine package exports", () => {
  test("there are definitions and app wrappers to compare", () => {
    // Anti-vacuity, both sides: a broken path makes the ledger empty or total,
    // and either reads as a clean result.
    expect(packageDefinitions().length).toBeGreaterThan(200)
    expect(appConvexSources().length).toBeGreaterThan(50_000)
  })

  test("is wrapped by an app, or is on the ledger", () => {
    const strays = unwrapped().filter((key) => !UNWRAPPED.includes(key))

    expect(
      strays,
      "this definition is reachable by nothing: wrap it, or delete it with its reason"
    ).toEqual([])
  })

  test("and the ledger names nothing that is wrapped after all", () => {
    /*
     * The half that makes the ledger shrink. Wrapping `blog.deleteTag` removes
     * it from the measured list, and this fails until it comes out of `UNWRAPPED`
     * too — so the list cannot quietly keep permitting something that is now
     * fine.
     */
    const measured = unwrapped()
    const stale = UNWRAPPED.filter((key) => !measured.includes(key))

    expect(stale, "these are wrapped now: remove them from UNWRAPPED").toEqual([])
  })

  test("the ledger names only definitions that exist", () => {
    // A renamed or deleted definition must not go on holding a place.
    const defined = new Set(packageDefinitions())
    const ghosts = UNWRAPPED.filter((key) => !defined.has(key))

    expect(ghosts, "these no longer exist: remove them from UNWRAPPED").toEqual([])
  })

  test("the three this issue was about are wrapped or gone", () => {
    /*
     * Named directly rather than left to the ledger's absence, so deleting the
     * list would not silently release them. Two were deleted with their reasons
     * (`translations.bulkUpsert` could not be guarded as written;
     * `cmsPublish.publishPage` took `updatedBy` from the client and each app's
     * own wrapper supersedes it) and one is now wrapped.
     */
    const defined = new Set(packageDefinitions())
    expect(defined.has("translations.bulkUpsert")).toBe(false)
    expect(defined.has("cmsPublish.publishPage")).toBe(false)
    expect(defined.has("emailSegments.refreshCount")).toBe(false)

    expect(appConvexSources()).toMatch(/export const deleteTag = storeMutation\(/)
  })
})
