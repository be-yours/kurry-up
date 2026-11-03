/**
 * Every publicly registered Convex function is called by something.
 *
 * WHAT WAS BROKEN. This app registered **359** public Convex functions and
 * **81** of them had no caller anywhere — no screen, no package, no test, no
 * script, no cron. A registered public function is reachable by anyone holding
 * the deployment URL whether or not a screen calls it, so each one was an
 * unreviewed, untested surface on every client's backend. Eleven were
 * unauthenticated storefront reads (`products.getFeatured`, `products.getBySlug`,
 * `products.getByCategory`, `cms.getPage`, `menus.getById`, `categories.getById`,
 * two blog listings, two translation reads, and `orders.getByViewToken`) whose
 * live siblings — `products.list`, `cms.getPageBlocks`, `orders.getById` — are
 * what the storefront actually opens. #281 is the precedent for what one of
 * these becomes when it takes its identity from its caller.
 *
 * The sweep confirmed none of the 81 was an unguarded write, so this was never
 * an open door. It was surface, and surface is what gets found later.
 *
 * WHY THE ISSUE'S OWN COUNT WAS WRONG. #413 said 36. That number comes from
 * looking only at bare `query(`/`mutation(`/`action(`, which misses the 200
 * exports built with `storeQuery`/`storeMutation`/`authedQuery`/`authedMutation`
 * — and those are *also* public registrations: `lib/storeFunctions.ts` binds
 * them to the generated `query`/`mutation` builders, so they are routed exactly
 * as publicly and merely permission-checked inside. Counting them gives 81.
 *
 * A caller sweep also has to allow for optional chaining. `packages/admin`
 * receives the API as `api: any` through `stores/admin-api-store.ts` and calls
 * `api?.products?.list`; a scan for `api\.x\.y` alone reports 132 dead where
 * there are 81, and would have deleted live screens' backends.
 *
 * WHAT THIS DOES NOT CLAIM. Having a caller is not the same as being safe or
 * being tested. This test closes one hole only: a function that is reachable by
 * the whole internet and reached by nothing in this repository.
 */

import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { APP_ROOT, engineSourceRoots, monorepoPath } from "../lib/repo-layout"

const APP = APP_ROOT
const CONVEX = path.join(APP, "convex")

/**
 * The engine, wherever this checkout keeps it.
 *
 * This used to be `path.join(APP, "../..", "packages")`, which is a path only
 * the monorepo has. This file SHIPS — the mirror copies every tracked file
 * under `apps/themes` onto the boilerplate a client clones — and `walk()`
 * returns an empty list for a root that is not there rather than raising, so on
 * a client site the scan quietly lost every caller that lives in the engine and
 * reported 79 public functions as unreached. See `tests/lib/repo-layout.ts` for
 * the measurement; the two layouts leave the same ten unreferenced.
 */
const ENGINE = engineSourceRoots()

/** Builders that register a function on the PUBLIC router. */
const PUBLIC_BUILDERS = [
  "query",
  "mutation",
  "action",
  // Publicly routed too — see the note above. Guarded inside, not hidden.
  "storeQuery",
  "storeMutation",
  "authedQuery",
  "authedMutation",
]

/**
 * Public functions with no caller in this repository, kept on purpose.
 *
 * Each is reached from outside the code — an ops script or a documented
 * operator instruction — so "nothing imports it" is not the whole story. Each
 * also carries a `@kept-callerless` note at its declaration saying the same
 * thing next to the code. Adding a name here is a deliberate act; it is the one
 * way past this test.
 */
const KEPT_CALLERLESS: Record<string, string> = {
  // Called by the bench's own ops scripts. The two apps' convex trees are
  // byte-identical, so they stay registered in the template too.
  //
  // `emailAutomations.create` and `.activate` WERE here, kept for
  // `apps/reference/scripts/verify-resume-and-automation.mjs`. The automations
  // screen calls both now (#270), so they left — which is what the sibling test
  // below is for: an entry the product has started calling must not sit here
  // claiming a script is its only caller.
  "emailEvents.listByCampaign":
    "apps/reference/scripts/verify-campaign-send.mjs",

  // Named in a runbook or guide as something an operator runs by hand. Deleting
  // one of these removes a capability the shipped documentation still promises.
  "uberEatsActions.runValidation":
    "apps/docs/guides/delivery-integrations.md tells an operator to run it",
  "uberEatsOAuth.activateAndListStores":
    "tasks/uber-eats-go-live-runbook.md:89 makes it a go-live step",
  "maintenance.setContract":
    "apps/docs/guides/maintenance-and-migration.md:84",
  "maintenance.updateMigrationRequestStatus":
    "apps/docs/guides/maintenance-and-migration.md:88",
  "maintenance.listMigrationRequests":
    "the read half of that same documented flow; requestMigration is live",
  "auth.getCurrentUser":
    "tasks/convex-account-cutover-runbook.md:39 uses it as the cut-over smoke test",
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "_generated",
  ".git",
])

/**
 * Every file under `dir`, minus the directories `skip` names.
 *
 * `skip` is per-root because the engine roots need `dist/` and the application
 * roots must not have it — see ENGINE_SKIP.
 *
 * No symlink handling, and that is measured rather than assumed. Under pnpm
 * every engine package IS a link (`node_modules/@be-yours/admin` ->
 * `.pnpm/…`), and `readdirSync` resolves a link it is handed as the root, so a
 * root arrives here already followed. Below the root there is nothing to
 * follow: an engine package holds real directories, and its own
 * `node_modules/` — the one place links reappear — is in SKIP_DIRS. Checked on
 * a tarball install of all nine packages: zero nested symlinks. The trap that
 * would matter is `entry.isDirectory()`, which is FALSE for a link to a
 * directory; it is avoided by resolving each package to its own root rather
 * than walking the scope directory that holds the nine links.
 */
function walk(dir: string, out: string[] = [], skip: Set<string> = SKIP_DIRS): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out, skip)
    else out.push(p)
  }
  return out
}

/** `api.<module>.<export>` for every public registration under convex/. */
function publicRegistrations(): Array<{ key: string; kind: string }> {
  const regs: Array<{ key: string; kind: string }> = []
  const builders = PUBLIC_BUILDERS.join("|")
  for (const file of walk(CONVEX)) {
    if (!file.endsWith(".ts")) continue
    const mod = path.relative(CONVEX, file).replace(/\.ts$/, "")
    const source = fs.readFileSync(file, "utf8")
    const re = new RegExp(`^export const (\\w+)\\s*=\\s*(${builders})\\(`, "gm")
    for (const m of source.matchAll(re)) {
      regs.push({ key: `${mod}.${m[1]}`, kind: m[2]! })
    }
  }
  return regs
}

/** A directory to scan, and what to leave out while scanning it. */
type ScanRoot = { dir: string; skip: Set<string> }

/**
 * `dist/` is skipped in a monorepo checkout and scanned in an installed engine.
 *
 * Not a workaround: they are different artefacts. Under `packages/` it is
 * build output regenerated from the `src` beside it, so it can only repeat
 * references already seen — or, when stale, assert callers that no longer
 * exist. Under `node_modules/` it is half of what the engine actually ships:
 * `cms`, `integrations`, `marketing` and `restaurant` publish `dist` and no
 * source at all. `engineSourceRoots()` decides which of the two this is.
 */
const ENGINE_SKIP = ENGINE.includesBuildOutput
  ? new Set([...SKIP_DIRS].filter((name) => name !== "dist"))
  : SKIP_DIRS

const ENGINE_ROOTS: ScanRoot[] = ENGINE.sources.map((dir) => ({ dir, skip: ENGINE_SKIP }))

const appRoot = (rel: string): ScanRoot => ({ dir: path.join(APP, rel), skip: SKIP_DIRS })

/** The agency's own ops scripts, at the monorepo root. `null` in a client site. */
const OPS_SCRIPTS = monorepoPath("scripts")

/** Everywhere a Convex function can be named from. */
const CALLER_ROOTS: ScanRoot[] = [
  appRoot("app"),
  appRoot("components"),
  appRoot("lib"),
  appRoot("tests"),
  appRoot("e2e"),
  // A client's own `scripts/` — the template ships one. The monorepo root's is
  // separate and comes next; there is nothing above a client site to read.
  appRoot("scripts"),
  { dir: CONVEX, skip: SKIP_DIRS },
  ...ENGINE_ROOTS,
  ...(OPS_SCRIPTS === null ? [] : [{ dir: OPS_SCRIPTS, skip: SKIP_DIRS }]),
]

/**
 * Where the product itself lives — screens, shared code and the backend.
 *
 * Narrower than CALLER_ROOTS on purpose: it excludes `tests/`, `e2e/` and
 * `scripts/`. A function reached only from those is reached by the team, not by
 * the product, and that is exactly what the kept-callerless list records.
 */
const PRODUCT_ROOTS: ScanRoot[] = [
  appRoot("app"),
  appRoot("components"),
  appRoot("lib"),
  { dir: CONVEX, skip: SKIP_DIRS },
  ...ENGINE_ROOTS,
]

function referencedKeys(roots: ScanRoot[] = CALLER_ROOTS): Set<string> {
  let haystack = ""
  for (const root of roots) {
    for (const f of walk(root.dir, [], root.skip)) {
      if (/\.(ts|tsx|mts|mjs|js|jsx)$/.test(f)) haystack += "\n" + fs.readFileSync(f, "utf8")
    }
  }
  const keys = new Set<string>()
  // `api.x.y`, `internal.x.y`, `anyApi.x.y` — optional chaining tolerated,
  // because packages/admin calls through an `any` and writes `api?.x?.y`.
  for (const m of haystack.matchAll(
    /\b(?:api|anyApi|internal)\??\.([A-Za-z0-9_]+)\??\.([A-Za-z0-9_]+)/g
  )) {
    keys.add(`${m[1]}.${m[2]}`)
  }
  // `makeFunctionReference("module:export")` and the ops scripts' "mod:fn".
  for (const m of haystack.matchAll(/["']([A-Za-z0-9_/]+):([A-Za-z0-9_]+)["']/g)) {
    keys.add(`${m[1]}.${m[2]}`)
  }
  return keys
}

describe("the public Convex surface", () => {
  const registrations = publicRegistrations()
  const referenced = referencedKeys()

  it("is enumerated at all — the scan itself must not silently find nothing", () => {
    // Without this, a regex that stops matching turns every assertion below
    // into a vacuous pass, which is the failure mode this whole file is about.
    expect(registrations.length).toBeGreaterThan(200)
    expect(registrations.some((r) => r.kind === "storeMutation")).toBe(true)
    expect(registrations.some((r) => r.kind === "query")).toBe(true)
  })

  /**
   * The mirror of the test above, for the other half of the comparison.
   *
   * WHAT WAS BROKEN. `walk()` returns an empty list for a root that does not
   * exist, which is right — `e2e/` is legitimately absent from some checkouts —
   * and catastrophic for a root that is load-bearing. On a delivered client
   * site the engine root was `<app>/../../packages`, a path no client has, so
   * the scan lost every caller living in the engine and the test below reported
   * 79 public functions as unreached by anything. It failed, which was lucky:
   * the same silence in the other direction (an allowlist quietly covering the
   * loss) is a green suite guarding nothing.
   *
   * So the roots are asserted rather than assumed, and asserted by what they
   * CONTRIBUTE rather than by existing. A directory that is present and yields
   * nothing — a renamed scope, a `readdir` that stops descending symlinks, an
   * engine published without the sources — is the same defect as an absent one
   * and reads identically here.
   */
  it("can see the engine — a caller root that yields nothing is a lost root", () => {
    expect(ENGINE.sources.length).toBeGreaterThan(0)
    for (const dir of ENGINE.sources) expect(fs.existsSync(dir)).toBe(true)

    // Callers the engine supplies and the application does not. 269 in this
    // monorepo and 262 through a tarball install at `a7862e90`; the floor is
    // set well below both because the number moves with every screen, and
    // what this is protecting against is 0.
    const fromApp = referencedKeys(CALLER_ROOTS.filter((r) => !ENGINE_ROOTS.includes(r)))
    const fromEngine = referencedKeys(ENGINE_ROOTS)
    const engineOnly = [...fromEngine].filter((key) => !fromApp.has(key))
    expect(engineOnly.length).toBeGreaterThan(100)
  })

  it("has a caller for every public function", () => {
    const callerless = registrations
      .filter((r) => !referenced.has(r.key))
      .filter((r) => !(r.key in KEPT_CALLERLESS))
      .map((r) => `${r.key} (${r.kind})`)
      .sort()

    expect(callerless).toEqual([])
  })

  it("keeps the kept-callerless list honest — an entry the product calls should leave", () => {
    // Measured against product code only. `apps/reference` calls three of these
    // from its own `scripts/`, which is precisely why they are on the list — so
    // asserting against the full caller scan would fail on one twin and pass on
    // the other, and the two files have to be identical.
    const byProduct = referencedKeys(PRODUCT_ROOTS)
    const nowCalled = Object.keys(KEPT_CALLERLESS).filter((k) => byProduct.has(k))
    expect(nowCalled).toEqual([])
  })

  it("keeps the kept-callerless list honest — an entry that no longer exists should leave", () => {
    const registered = new Set(registrations.map((r) => r.key))
    const gone = Object.keys(KEPT_CALLERLESS).filter((k) => !registered.has(k))
    expect(gone).toEqual([])
  })

  it("says at its declaration why each kept function is kept", () => {
    const undocumented: string[] = []
    for (const key of Object.keys(KEPT_CALLERLESS)) {
      const [mod, name] = [key.slice(0, key.lastIndexOf(".")), key.slice(key.lastIndexOf(".") + 1)]
      const source = fs.readFileSync(path.join(CONVEX, `${mod}.ts`), "utf8")
      const at = source.search(new RegExp(`^export const ${name}\\s*=`, "m"))
      const preceding = source.slice(Math.max(0, at - 1200), at)
      if (!preceding.includes("@kept-callerless")) undocumented.push(key)
    }
    expect(undocumented).toEqual([])
  })
})
