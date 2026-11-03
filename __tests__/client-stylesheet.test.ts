import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * `app/globals.css` must be readable from the client repository, not just from
 * here.
 *
 * This app is published verbatim to `beyours-boilerplate`, the repository a
 * client site is cloned from, where it is the REPOSITORY ROOT rather than
 * `apps/themes` inside a monorepo. Every relative path in a shipped file
 * therefore has to resolve without leaving this directory. Two `@source` globs
 * did not:
 *
 *     @source "../../../packages/ui/src/**\/*.{ts,tsx}"
 *     @source "../../../packages/admin/src/**\/*.{ts,tsx}"
 *
 * Here they reach `packages/`. On a client site they resolve above the
 * repository root and match nothing, and Tailwind does not complain about a
 * source glob that finds no files — so the monorepo built 3102 rules and every
 * client built 2526. The 576 missing rules were every class used only inside
 * `packages/ui` or `packages/admin`: the viewport-height cap on the promotion
 * form's scrolling body, the minimum height that centres the store guard. The
 * dialog that had already been fixed once for rendering 1549px tall with its
 * submit button off screen was doing it again, on every site we had sold, while
 * CI here was green.
 *
 * Those class names are described rather than spelled on purpose. Tailwind's
 * automatic detection scans this directory too, so writing one here would emit
 * its rule from THIS FILE — and the canary would keep singing in a client build
 * that had lost every other rule the engine contributes.
 *
 * `scripts/check-mirror-css.mjs` is the proof: it materialises the published
 * tree and compiles it. This file is the fast half of the same guarantee — it
 * runs in the Test job in milliseconds and states the rule that makes the
 * compile come out right, so a bad path is caught where it is written rather
 * than at the far end of a build.
 */

const APP_ROOT = path.join(__dirname, "..")
const REPO_ROOT = path.join(APP_ROOT, "../..")
const GLOBALS = "app/globals.css"

/**
 * This file ships too — `__tests__/` crosses to the client repository like
 * everything else here — so it has to obey the rule it enforces. Everything
 * above this line reads nothing outside the app and is exactly as true on a
 * client site, where it guards the clone against the same mistake. The suites
 * gated below read `packages/` and the CI workflow, which exist only here.
 * Writing those ungated would have turned `pnpm test` red on every site we
 * sell: the same defect, one directory across.
 */
const IN_MONOREPO = fs.existsSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"))

const globals = fs.readFileSync(path.join(APP_ROOT, GLOBALS), "utf8")

/**
 * Every path the stylesheet asks the build to go and find.
 *
 * Absolute ones are included, not filtered out as "not relative". An absolute
 * `@source` resolves perfectly on the machine that wrote it — including in a
 * build of the published tree, since that runs on the same filesystem — and
 * points at nothing whatsoever on a client's. It is the one spelling that
 * survives a comparison of the two builds, so it has to be rejected by name.
 * A bare specifier (`@import "tailwindcss"`) is resolved from node_modules and
 * travels fine.
 */
function pathReferences(css: string): { directive: string; target: string }[] {
  return [...css.matchAll(/@(source|import)\s+"([./][^"]*)"/g)].map((m) => ({
    directive: m[1] as string,
    target: m[2] as string,
  }))
}

/** What a path resolves to, relative to the stylesheet that declares it. */
function resolveFromStylesheet(target: string): string {
  return path.resolve(path.join(APP_ROOT, path.dirname(GLOBALS)), target)
}

/** The directory a `@source` glob starts walking: everything before the first wildcard. */
function scanRoot(target: string): string {
  const literal = target.split(/[*?[{]/)[0] as string
  return resolveFromStylesheet(literal.endsWith("/") ? literal : path.dirname(literal))
}

/** Where a directive actually points, glob or plain path. */
function resolved({ directive, target }: { directive: string; target: string }): string {
  return directive === "source" ? scanRoot(target) : resolveFromStylesheet(target)
}

describe("the stylesheet survives the crossing to a client repository", () => {
  test("it declares the engine packages as Tailwind sources", () => {
    const sources = pathReferences(globals).filter((r) => r.directive === "source")
    expect(sources.map((s) => s.target)).toEqual([
      "../node_modules/@be-yours/ui/src/**/*",
      "../node_modules/@be-yours/admin/src/**/*",
    ])
  })

  test.each(pathReferences(globals))(
    '@$directive "$target" stays inside the app, so it still resolves when the app is the repository root',
    (reference) => {
      const target = resolved(reference)
      const escapes = path.isAbsolute(reference.target) || path.relative(APP_ROOT, target).startsWith("..")
      expect(
        escapes,
        `${reference.target} resolves to ${target}, which is not inside the app — on a client site that is ` +
          `another machine's filesystem, or above the repository root, where it matches nothing and ` +
          `Tailwind reports no error. Reach the engine through node_modules/@be-yours/*: pnpm links ` +
          `it to packages/* inside this workspace.`,
      ).toBe(false)
    },
  )

  test.each(pathReferences(globals))(
    '@$directive "$target" points at something that exists',
    (reference) => {
      const target = resolved(reference)
      expect(fs.existsSync(target), `${reference.target} resolves to ${target}, which does not exist`).toBe(
        true,
      )
    },
  )
})

/** The engine packages the stylesheet scans, as `{ pkg, directory }`. */
const scanned = pathReferences(globals)
  .filter((r) => r.directive === "source")
  .map((r) => r.target.match(/^\.\.\/node_modules\/(@be-yours\/[^/]+)\/([^/*]+)/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => ({ pkg: m[1] as string, directory: m[2] as string }))

describe("the stylesheet scans packages this app actually installs", () => {
  test("every @source names an engine package and a directory", () => {
    expect(scanned.length).toBe(2)
  })

  test("no @source restricts itself by extension", () => {
    // Tailwind's automatic detection scans this app's own files whatever they
    // are called. Holding the engine packages to `*.{ts,tsx}` meant a `.jsx`
    // under `packages/ui/src` produced no CSS while the identical file under
    // `app/` produced it fine — and both layouts agreed on the wrong answer,
    // so comparing them could not see it.
    for (const { target } of pathReferences(globals).filter((r) => r.directive === "source")) {
      expect(target, `${target} scans only some extensions`).toMatch(/\*\*\/\*$/)
    }
  })

  test("each one is a dependency, so node_modules has it at all", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    for (const { pkg } of scanned) expect(Object.keys(manifest.dependencies ?? {})).toContain(pkg)
  })
})

/**
 * A path that is correct is still worthless if the package it points into does
 * not publish that directory: a client installs the registry tarball, and the
 * tarball holds `files` and nothing else. Dropping `src` from `packages/ui`
 * would empty the same rules out of the client build, silently, with every path
 * in this file still perfectly correct.
 */
describe.skipIf(!IN_MONOREPO)("the engine packages publish what the stylesheet scans", () => {
  test.each(scanned)("$pkg publishes $directory", ({ pkg, directory }) => {
    const name = pkg.slice("@be-yours/".length)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "packages", name, "package.json"), "utf8"),
    ) as { files?: string[] }
    expect(
      manifest.files ?? [],
      `packages/${name} does not publish ${directory}, so a client's install has no ${directory} to scan`,
    ).toContain(directory)
  })
})

/**
 * The compile-both-layouts check is the only thing that has ever caught this,
 * and a check nobody runs is a comment. `Lint` is one of the four contexts
 * branch protection requires by name, which is why the other two repository
 * checks live there too.
 */
describe.skipIf(!IN_MONOREPO)("the check that compiles both layouts stays wired to CI", () => {
  const root = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")

  test("the root package.json defines it", () => {
    const manifest = JSON.parse(root("package.json")) as { scripts?: Record<string, string> }
    expect(manifest.scripts?.["check:mirror-css"]).toBe("node scripts/check-mirror-css.mjs")
  })

  test("the Lint job runs it", () => {
    expect(root(".github/workflows/ci.yml")).toContain("pnpm check:mirror-css")
  })
})
