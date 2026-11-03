/**
 * Where this test tree is standing, and what it is allowed to see from there.
 *
 * WHAT WAS BROKEN. These suites ship. `scripts/lib/mirror-tree.mjs` copies
 * every git-tracked file under `apps/themes` onto
 * `be-yours/beyours-boilerplate`, `tests/` included, and rule 9 of
 * `CLAUDE.md` tells every client to run `pnpm test` before they commit. Four
 * of those shipped files reached ABOVE the application root — `path.join(APP,
 * "../..")`, `new URL("../../../docs/…")` — for things that exist only in this
 * monorepo: `packages/`, the root `scripts/`, `apps/docs/`, the sibling app.
 *
 * A client has none of them, and the two ways that failed were not equally
 * visible:
 *
 *   LOUD  — `readFileSync` on a path that is not there. The file did not
 *           collect, and `tests/deployment/ses-feedback-provisioning.test.ts`
 *           and `tests/convex/nightly-backup.test.ts` died on
 *           ENOENT '/home/runner/work/beyours-boilerplate/themes/scripts/setup-aws.sh'.
 *
 *   QUIET — a scan root that simply is not there. `public-surface.test.ts`
 *           walks its caller roots with an `existsSync` guard that returns an
 *           empty list, so `packages/` being absent did not error: it reported
 *           the 79 public Convex functions whose callers live in the engine as
 *           having no caller at all. A number, not a crash, and wrong.
 *
 * Measured on the tree at `a7862e90`, materialised the way the publisher
 * materialises it: `Test Files 3 failed | 140 passed`. The boilerplate's own
 * CI had been red since 7 September for exactly this.
 *
 * WHAT THIS MODULE IS FOR. One place that answers "am I in the engine
 * monorepo, or am I a delivered client site", positively and once, so no
 * individual test has to guess from a missing file. A test that needs
 * something only the monorepo has asks for it here and gets `null` in a client
 * site; a test that needs the ENGINE — which a client does have, installed
 * under `node_modules/@be-yours/` rather than checked out under
 * `packages/` — gets it in both.
 *
 * `__tests__/client-stylesheet.test.ts` reached the same answer first, by hand,
 * and its docblock states the rule this module implements: "This file ships
 * too … so it has to obey the rule it enforces." It is the precedent, not a
 * duplicate — it guards the stylesheet's own `@source` paths, which is a
 * different question about the same boundary.
 *
 * The distinction is deliberate and is not "skip it if the file is missing".
 * A missing file is exactly what a genuine regression looks like, so a suite
 * that shrugs at one guards nothing. The question asked here is about the
 * SHAPE OF THE CHECKOUT, which is answered before any assertion runs and
 * cannot be satisfied by deleting something.
 */

import fs from "node:fs"
import path from "node:path"

/**
 * The application root.
 *
 * `apps/themes` (or `apps/reference`) in this monorepo; the repository root
 * itself in a delivered client site, where the template IS the repository.
 * Everything a client owns is at or below this path — which is the whole rule
 * these helpers exist to keep.
 */
export const APP_ROOT = path.join(__dirname, "../..")

/**
 * The engine monorepo root, or `null` when this tree is a delivered client site.
 *
 * Identified POSITIVELY, by two markers that only the engine checkout carries
 * together — the pnpm workspace manifest and the `packages/` directory it
 * declares. Deriving it the other way round ("the file I wanted is missing, so
 * I must be a client") would turn every accidental deletion into a silent pass,
 * which is the failure this module is here to stop rather than to spread.
 */
export const MONOREPO_ROOT: string | null = (() => {
  const candidate = path.join(APP_ROOT, "../..")
  const isEngineCheckout =
    fs.existsSync(path.join(candidate, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(candidate, "packages"))
  return isEngineCheckout ? candidate : null
})()

/** True in `apps/themes` and `apps/reference`; false in a client's own repository. */
export const IN_MONOREPO = MONOREPO_ROOT !== null

/**
 * A path under the monorepo root, or `null` in a delivered client site.
 *
 * For the artefacts that are the AGENCY's rather than the product's — the
 * deployment runbooks under `apps/docs/`, the sibling application, the root
 * `scripts/`. A client has no copy of these and no way to fix one, so a test
 * that reads them is a test about this repository and says so by taking `null`
 * for an answer here.
 */
export function monorepoPath(...segments: string[]): string | null {
  return MONOREPO_ROOT === null ? null : path.join(MONOREPO_ROOT, ...segments)
}

/**
 * Every directory holding ENGINE code, wherever this checkout keeps it.
 *
 * The engine is present in both layouts and that is what separates it from
 * everything above: a client installs `@be-yours/*` from GitHub Packages,
 * so the code that calls a Convex function is under
 * `node_modules/@be-yours/` there and under `packages/` here. Same code,
 * two addresses.
 *
 * `sources` is what to walk. `includesBuildOutput` says whether `dist/` is
 * among them, and the two callers need opposite answers:
 *
 *   monorepo  — walk the sources, skip `dist`. It is build output, generated
 *               from the `src` next to it, so it adds no reference the walk has
 *               not already seen — and a STALE one would add references that no
 *               longer exist, hiding precisely what such a scan is looking for.
 *
 *   installed — walk everything the package ships, `dist` included. Four engine
 *               packages publish raw `src/*.ts` and four publish only `dist`
 *               (`core` publishes both), so skipping build output here would
 *               drop half the engine on the floor and re-create the silent
 *               undercount this module documents.
 *
 * Measured, because "the two agree" is the only thing that makes this
 * substitution honest: run against `apps/themes/convex` at `a7862e90`, the
 * monorepo roots and the installed roots each leave the SAME ten public
 * functions without a caller — the ten on `public-surface.test.ts`'s
 * `KEPT_CALLERLESS` list, and no others. Scanning what a client installs is
 * not an approximation of scanning `packages/`; here it is the same answer.
 */
export function engineSourceRoots(): {
  sources: string[]
  includesBuildOutput: boolean
  layout: "monorepo" | "installed"
} {
  if (MONOREPO_ROOT !== null) {
    return {
      sources: [path.join(MONOREPO_ROOT, "packages")],
      includesBuildOutput: false,
      layout: "monorepo",
    }
  }

  // A client's engine, named by the template's own manifest rather than by a
  // hard-coded list — the set of engine packages changes, and a list here would
  // go quietly out of date in the one tree nobody in this repository runs.
  // Direct dependencies are always linked at the top of `node_modules` by pnpm,
  // npm and yarn alike, so this address does not depend on the store layout.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> }

  const sources = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@be-yours/"))
    .map((name) => path.join(APP_ROOT, "node_modules", name))
    .filter((dir) => fs.existsSync(dir))

  return { sources, includesBuildOutput: true, layout: "installed" }
}

/**
 * One file inside an engine package, resolved wherever this checkout keeps it.
 *
 * `engineSourceRoots()` answers "which directories hold engine code"; this
 * answers "where is THIS file", which is what a test asserting something about
 * a named module needs. Same two addresses: `packages/<pkg>/…` in the monorepo,
 * `node_modules/@be-yours/<pkg>/…` in a delivered site.
 *
 * `null` when it is not there, so a caller can fail loudly with its own message
 * instead of an ENOENT from a `readFileSync` three frames down. A test that
 * reads engine source must assert this is non-null before trusting anything it
 * concludes — a file that cannot be found reads exactly like a file that
 * contains nothing, and that is the silent-vacuum shape this module exists to
 * refuse.
 *
 * Only packages that PUBLISH the path work in a client site. `convex-functions`
 * ships `src`, which is why `src/payments.ts` resolves in both layouts; a
 * package that publishes only `dist` would answer `null` there, correctly.
 */
export function enginePackageFile(pkg: string, relative: string): string | null {
  const { layout } = engineSourceRoots()
  const candidate =
    layout === "monorepo"
      ? path.join(MONOREPO_ROOT as string, "packages", pkg, relative)
      : path.join(APP_ROOT, "node_modules", "@be-yours", pkg, relative)
  return fs.existsSync(candidate) ? candidate : null
}
