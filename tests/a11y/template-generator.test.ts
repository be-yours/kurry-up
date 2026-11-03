/**
 * The catalogue on disk is what the generator would write.
 *
 * WHY THIS EXISTS. `templates/` is not hand-maintained — 45 of its 51 entries
 * are emitted by `scripts/gen-templates.mjs` from the demo identities, so that
 * "what we show" and "what we install" stay one thing. #436 then fixed the
 * catalogue's contrast BY HAND, across 51 `theme.css` files, and did not touch
 * the generator.
 *
 * So the generator kept the pre-#436 arithmetic, and `node
 * scripts/gen-templates.mjs` — an ordinary maintenance command, run whenever a
 * demo identity changes — silently reverted the whole fix. Measured on the tree
 * at `b9e20ea`: a regeneration rewrote 164 lines across 45 templates and put
 * `--input` back onto `--border` in every one of them, which is the defect
 * `globals.css` describes as "the product was, to a low-vision user, a
 * rectangle that was not there". Nothing would have gone red. The contrast
 * guards next door would have started failing on the NEXT run, on a diff nobody
 * had written, and the person who ran the command would have had no idea why.
 *
 * The generator now derives those values from the contrast requirement instead
 * of transcribing them, which is what makes the two agree. This test is what
 * keeps them agreeing: it regenerates into a scratch directory and compares.
 *
 * WHEN THIS GOES RED, the fix is almost never to edit `templates/` — it is to
 * change the generator and re-run it. A value hand-edited into a generated file
 * is a value the next regeneration deletes.
 */

import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const TEMPLATES = readdirSync("templates")
  .filter((slug) => existsSync(join("templates", slug, "theme.css")))
  .sort()

/**
 * A copy of the app just complete enough for the generator to run in.
 *
 * It reads `demos/assets/themes.js` and a font table out of `node_modules`, and
 * writes into `templates/`. Copying rather than running in place is the whole
 * point: this test must never be the thing that rewrites the catalogue.
 */
const scratch = mkdtempSync(join(tmpdir(), "beyours-templates-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("the template catalogue", () => {
  it("is exactly what scripts/gen-templates.mjs writes today", () => {
    cpSync("scripts", join(scratch, "scripts"), { recursive: true })
    cpSync("demos/assets", join(scratch, "demos/assets"), { recursive: true })
    cpSync("templates", join(scratch, "templates"), { recursive: true })
    // The generator reads one font table out of `next`; symlinking the whole
    // tree keeps this cheap and needs no install in the scratch copy.
    cpSync("node_modules/next/dist/compiled/@next/font/dist/google/font-data.json",
      join(scratch, "node_modules/next/dist/compiled/@next/font/dist/google/font-data.json"),
      { recursive: true })

    execFileSync("node", ["scripts/gen-templates.mjs"], { cwd: scratch, stdio: "pipe" })

    const drifted: string[] = []
    for (const slug of TEMPLATES) {
      const here = readFileSync(join("templates", slug, "theme.css"), "utf8")
      const regenerated = readFileSync(join(scratch, "templates", slug, "theme.css"), "utf8")
      if (here !== regenerated) drifted.push(slug)
    }
    // Named rather than counted: "3 templates drifted" sends you looking, a
    // list of slugs sends you to the diff.
    expect(drifted).toEqual([])
  }, 120_000)

  it("declares --primary-ink in every palette, light and dark", () => {
    // The token a WORD is written in. No template declared it before this
    // change, so all 51 fell back to the engine's orange while overriding
    // `--primary` to their own hue — and any markup still writing
    // `text-primary` met the FILL colour instead: 20 of the 51 failed AA that
    // way, worst 3.02:1 on `asiatique-dragon`. A template that stops declaring
    // it goes quietly back to that state, so it is asserted rather than assumed.
    const missing: string[] = []
    for (const slug of TEMPLATES) {
      // Comments stripped first: `templates/default/theme.css` is entirely a
      // comment — it documents the client zone and declares nothing — and its
      // worked example mentions `--primary`, which a naive match reads as a
      // palette that has one.
      const css = readFileSync(join("templates", slug, "theme.css"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
      // A template that declares no palette of its own IS the engine's.
      if (!/--primary:/.test(css)) continue
      const roots = css.match(/--primary-ink:/g) ?? []
      if (roots.length < 2) missing.push(`${slug} (${roots.length} of 2)`)
    }
    expect(missing).toEqual([])
  })
})
