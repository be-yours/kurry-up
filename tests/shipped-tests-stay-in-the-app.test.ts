/// <reference types="vite/client" />

/**
 * No shipped test may read a path above the application root unguarded.
 *
 * WHY THIS EXISTS. `scripts/lib/mirror-tree.mjs` copies every git-tracked file
 * under `apps/themes` onto `be-yours/beyours-boilerplate`, `tests/`
 * included, and `check:mirror-build` runs that delivered tree's own suite
 * before a sync is allowed. A test that reaches for `packages/` or for the
 * sibling app is reaching for something only this monorepo has: in the
 * delivered tree the same expression resolves to the directory ABOVE the
 * repository, and the two ways it then fails are not equally visible.
 *
 *   LOUD  — a `readFileSync` or `readdirSync` on a path that is not there.
 *           ENOENT, the suite dies, the sync is refused, and no client site
 *           receives anything until somebody reads the run.
 *
 *   QUIET — a scan root guarded by `existsSync` that returns an empty list.
 *           No error: a number, and the wrong one. `public-surface.test.ts`
 *           once reported the 79 public functions whose callers live in the
 *           engine as having no caller at all.
 *
 * `tests/lib/repo-layout.ts` was written for exactly this and says so at
 * length. What was missing was anything that MADE a new file use it.
 *
 * WHAT IT COST, measured. The class has now fired twice. `a7862e90` was the
 * first: three files, and the boilerplate's CI red since 7 September. The
 * second ran from 15 September 12:48 to the commit that adds this file — the
 * mirror refused every sync for the whole of that window, so seven merged
 * commits reached no client at all, and the run says `Test Files 4 failed |
 * 173 passed` on four separate causes that arrived in three different pull
 * requests (#540, #549, #555). None of them was a wrong path anybody could see
 * in review: `join(process.cwd(), "../../packages/…")` is what the file next
 * to it already did.
 *
 * WHY THIS FILE HAS NO TWIN IN `apps/reference`, alone among its neighbours.
 * The rule is about the tree that SHIPS, and only `apps/themes` does. The bench
 * is the agency's: fifteen of its suites read the root `scripts/` and
 * `.github/workflows/` on purpose — `mirror-publisher`, `publish-plan`,
 * `commit-attribution` — and there is no client for whom those paths are
 * missing. Copying this guard there would have accused all fifteen of a defect
 * they do not have. `check-app-divergence.mjs` permits the asymmetry: parity is
 * enforced over `e2e/` and `convex/` only, and a file one app lacks is skipped
 * rather than failed.
 *
 * WHY A RESOLVER AND NOT A PATTERN. The literal `"../.."` is the wrong thing
 * to match on — 110 of these 156 files contain one, almost all of them
 * ordinary imports that stay inside the app (`"../../convex/schema"` from
 * `tests/convex/` IS the app root). What matters is where the path LANDS, so
 * each expression is resolved against its real base and compared to the app
 * root. Measured against the CI run above, this scan names the four failing
 * files and nothing else — a pattern match on the literal would have cried
 * wolf 106 times, and a guard that does that is switched off within a week.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

import { APP_ROOT } from "./lib/repo-layout"

/**
 * The files allowed to resolve above the app root, and why.
 *
 * Not a suppression list: every entry asks the question POSITIVELY — "which
 * shape of checkout am I standing in?" — before it reads anything, so each is
 * correct in a delivered site rather than merely quiet there. A new entry is a
 * decision, and the reason is the entry.
 */
const ALLOWED = new Map([
  [
    "tests/lib/repo-layout.ts",
    "the module that answers the question; it is where the one `../..` belongs",
  ],
  [
    "__tests__/client-stylesheet.test.ts",
    "the precedent repo-layout was extracted from — it derives its own IN_MONOREPO " +
      "and skips the monorepo-only half",
  ],
])

/** Every file the mirror ships under the two test trees. */
function shippedTestFiles(): string[] {
  const found: string[] = []

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) found.push(path.relative(APP_ROOT, full))
    }
  }

  walk(path.join(APP_ROOT, "tests"))
  walk(path.join(APP_ROOT, "__tests__"))
  return found.sort()
}

/** `const NAME = process.cwd()` / `= __dirname` — the two roots a base can start from. */
const ALIAS = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(process\.cwd\(\)|__dirname)\s*$/gm

/** `[const NAME =] join(BASE, "literal")`, with `path.` and `resolve` both allowed. */
const CALL =
  /(?:const\s+([A-Za-z_$][\w$]*)\s*=\s*)?(?:path\.)?(?:join|resolve)\(\s*([A-Za-z_$][\w$]*|process\.cwd\(\))\s*,\s*["'`]([^"'`]+)["'`]/g

/**
 * Where each path expression in `file` lands, for the ones that walk upwards.
 *
 * Bases are followed transitively — `const APP = process.cwd()` then
 * `const ROOT = join(APP, "../..")` then `join(ROOT, "packages")` — because
 * that is how the four real defects were written. An expression whose base
 * cannot be determined is skipped rather than guessed at: this guard reports
 * what it can prove.
 */
function escapesAppRoot(file: string): string[] {
  const source = fs
    .readFileSync(path.join(APP_ROOT, file), "utf8")
    // Comments are stripped because this very file quotes the defect it
    // forbids, and a scanner that reads its own prose accuses itself.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")

  const here = path.dirname(path.join(APP_ROOT, file))
  const bases = new Map([
    ["__dirname", here],
    ["process.cwd()", APP_ROOT],
  ])

  for (const [, name, root] of source.matchAll(ALIAS)) {
    bases.set(name!, root === "__dirname" ? here : APP_ROOT)
  }

  const escapes: string[] = []
  for (const [, assignTo, base, literal] of source.matchAll(CALL)) {
    const from = bases.get(base!)
    if (from === undefined) continue

    const target = path.resolve(from, literal!)
    if (assignTo) bases.set(assignTo, target)
    if (!literal!.includes("..")) continue
    if (target !== APP_ROOT && !target.startsWith(APP_ROOT + path.sep)) {
      escapes.push(path.relative(APP_ROOT, target))
    }
  }
  return escapes
}

describe("a test that ships stays inside the app it ships with", () => {
  test("there are files to scan, and the resolver reads them", () => {
    // Anti-vacuity, both halves. A broken walk finds nothing and every
    // assertion below passes over an empty set; a resolver that matched
    // nothing would do the same while looking busy.
    const files = shippedTestFiles()
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain("tests/lib/repo-layout.ts")
    expect(escapesAppRoot("tests/lib/repo-layout.ts").length).toBeGreaterThan(0)
  })

  test("nothing reaches above the app root but the files allowed to", () => {
    const offenders = shippedTestFiles()
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => escapesAppRoot(file).length > 0)

    expect(
      offenders,
      "these resolve outside the app a client receives, where that path does not exist: " +
        "read the engine through `enginePackageFile`, or stand the suite down with " +
        "`describe.skipIf(!IN_MONOREPO)` — see tests/lib/repo-layout.ts"
    ).toEqual([])
  })

  test("and the allow-list names only files that still reach out", () => {
    // The half that makes the list shrink. A file that stops reaching above the
    // root has to leave, so the list cannot go on permitting something that no
    // longer happens — the same rule the UNWRAPPED ledger keeps.
    const stale = [...ALLOWED.keys()].filter((file) => escapesAppRoot(file).length === 0)

    expect(stale, "these no longer reach above the app root: remove them").toEqual([])
  })

  test("the allow-list names only files that exist", () => {
    const ghosts = [...ALLOWED.keys()].filter(
      (file) => !fs.existsSync(path.join(APP_ROOT, file))
    )

    expect(ghosts, "these are gone: remove them from the allow-list").toEqual([])
  })
})
