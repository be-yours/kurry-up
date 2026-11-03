import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"

/**
 * The engine packages a client installs must load under plain Node.
 *
 * WHAT BROKE (#516's mirror run). `packages/restaurant` ships a bundled `dist`,
 * and it left `@be-yours/convex-schema` external — a package that publishes
 * raw `.ts` on purpose, because the Convex bundler compiles it and a schema has
 * to stay readable as source. So `dist` carried a runtime import of TypeScript.
 *
 * It worked everywhere it was tried. In this monorepo `convex-schema` resolves
 * OUTSIDE `node_modules`, and Node strips types there. A client site installs it
 * from the registry, where it is under `node_modules`, and Node refuses:
 *
 *   Error: Stripping types is currently unsupported for files under
 *   node_modules, for ".../@be-yours/convex-schema/src/index.ts"
 *
 * That is every Playwright spec importing a value from `@be-yours/restaurant`
 * — `e2e/storefront/cart-line-identity.spec.ts` imports `CART_STORAGE_VERSION` —
 * on every client repo. It stayed invisible until the boilerplate's own CI got
 * far enough to run its e2e suite, which it had not done while its unit tests
 * were red.
 *
 * WHY A CHILD PROCESS. Vitest transforms TypeScript, so importing the package
 * from inside a suite proves nothing: it would resolve and compile the raw `.ts`
 * quite happily and the defect would not reproduce. Playwright's config loader
 * and a client's own scripts are plain Node. This spawns one.
 */

/** Values every consumer of this package reaches for, and that a client's e2e imports. */
const RUNTIME_VALUES = ["CART_STORAGE_VERSION"] as const

/*
 * The name deliberately carries no bare package specifier followed by prose.
 * `mirror-engine-exports.test.ts` scrapes engine package specifiers out of every
 * source file in the tree and reads the words after one as part of the package
 * name, so a describe that put a specifier in front of "under plain Node" sent
 * it looking for a directory by that whole name. A specimen of the bad form is
 * not written out here for the same reason — the scanner would read this comment
 * too, which is how the first attempt at this note failed.
 */
describe("the published restaurant bundle, under plain Node", () => {
  test("loads, and hands back a runtime value", () => {
    // `require.resolve` from this file, so the assertion follows whatever the
    // consumer resolves — the workspace link here, `node_modules` on a client.
    const script = `
      const m = require(require.resolve("@be-yours/restaurant"));
      const missing = ${JSON.stringify(RUNTIME_VALUES)}.filter((k) => m[k] === undefined);
      if (missing.length) { console.error("missing:" + missing.join(",")); process.exit(2); }
      process.stdout.write(String(m.CART_STORAGE_VERSION));
    `

    let out: string
    try {
      out = execFileSync(process.execPath, ["-e", script], {
        cwd: __dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error)
      throw new Error(
        "the published bundle does not load under plain Node — a client's " +
          `Playwright config and scripts are plain Node:\n${stderr}`
      )
    }

    // Anti-vacuity: an empty stdout would pass a bare "did not throw".
    expect(out).toMatch(/^\d+$/)
  })
})
