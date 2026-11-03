import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyTemplate, listTemplates, resolveTemplateSlug } from "./apply-template.mjs"

/**
 * Alias resolution for `pnpm template:apply`.
 *
 * Five of the fifty themes the catalogue sells are their vertical's base
 * template, kept in a directory named for the bare vertical — `templates/
 * asiatique/` is sold as `asiatique-izakaya`. Applying the slug the buyer was
 * shown used to fail outright, so these tests pin both halves: the alias
 * resolves, and everything written downstream uses the directory it resolved to.
 */

/** A throwaway root with two templates, one of which carries an alias. */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-template-"))
  fs.mkdirSync(path.join(root, "site"), { recursive: true })

  const write = (slug, meta) => {
    const dir = path.join(root, "templates", slug)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify(meta))
    fs.writeFileSync(path.join(dir, "theme.css"), `/* ${slug} */\n`)
    fs.writeFileSync(path.join(dir, "fonts.ts"), `export const font = "${slug}"\n`)
    // The layout half (#507). A fixture without it exercises the refusal rather
    // than the copy, which is a different test — `refuses a template missing a
    // file` below owns that case and removes one deliberately. That test did
    // not exist until #532, and this comment cited it for as long.
    fs.writeFileSync(path.join(dir, "layout.ts"), `export const siteLayout = "${slug}"\n`)
  }

  write("asiatique", {
    slug: "asiatique",
    label: "Izakaya — contemporary Asian",
    themeName: "Izakaya",
    aliases: ["asiatique-izakaya"],
  })
  write("asiatique-wokstreet", { slug: "asiatique-wokstreet", label: "Wok Street" })

  return root
}

describe("resolveTemplateSlug", () => {
  let root
  beforeEach(() => { root = makeRoot() })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it("resolves a slug that is a real directory", () => {
    expect(resolveTemplateSlug("asiatique-wokstreet", root)).toBe("asiatique-wokstreet")
  })

  it("resolves the slug the theme is sold under to its base directory", () => {
    expect(resolveTemplateSlug("asiatique-izakaya", root)).toBe("asiatique")
  })

  it("returns null for a name nothing claims", () => {
    expect(resolveTemplateSlug("asiatique-nonesuch", root)).toBeNull()
  })

  it("prefers a real directory over an alias of the same name", () => {
    // A future templates/asiatique-izakaya/ must supersede the alias without
    // anyone remembering to delete it.
    const dir = path.join(root, "templates", "asiatique-izakaya")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify({ slug: "asiatique-izakaya" }))
    expect(resolveTemplateSlug("asiatique-izakaya", root)).toBe("asiatique-izakaya")
  })
})

describe("applyTemplate", () => {
  let root
  beforeEach(() => { root = makeRoot() })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it("applies the base template when given the slug it is sold under", () => {
    const meta = applyTemplate("asiatique-izakaya", root)

    expect(meta.slug).toBe("asiatique")
    expect(fs.readFileSync(path.join(root, "site", "theme.css"), "utf8")).toContain("asiatique")
  })

  it("records the resolved slug in the sentinel, not the alias", () => {
    // The sentinel is what `update:template` reads back later; an alias there
    // would send it looking for a directory that does not exist.
    const sentinel = path.join(root, ".beindigital-site.json")
    fs.writeFileSync(sentinel, JSON.stringify({ template: "default" }))

    applyTemplate("asiatique-izakaya", root)

    expect(JSON.parse(fs.readFileSync(sentinel, "utf8")).template).toBe("asiatique")
  })

  /*
   * THE TEST THE FIXTURE ABOVE ALREADY CITED (#510, written for #532).
   *
   * `makeRoot` says "`refuses a template missing a file` below owns that case
   * and removes one deliberately", and no such test existed. Measured by
   * inverting #510 in an isolated worktree: deleting the `layout.ts` row from
   * the applier's copy list left all eight cases green.
   *
   * WHY THE REFUSAL IS THE POINT, and not the copy. A template with no
   * `layout.ts` applied silently and left the PREVIOUS template's layout over
   * the new one's colours — a site that is half one design and half another,
   * with nothing anywhere saying so. Throwing at apply time is what turns that
   * into a message a person reads before the site ships.
   */
  for (const missing of ["theme.css", "fonts.ts", "layout.ts", "template.json"]) {
    it(`refuses a template missing a file — ${missing}`, () => {
      fs.rmSync(path.join(root, "templates", "asiatique-wokstreet", missing))

      expect(() => applyTemplate("asiatique-wokstreet", root)).toThrow()
    })
  }

  it("names the file it could not find", () => {
    // A refusal that does not say WHICH file leaves the reader to diff a
    // directory against a list they have to go and find.
    fs.rmSync(path.join(root, "templates", "asiatique-wokstreet", "layout.ts"))

    expect(() => applyTemplate("asiatique-wokstreet", root)).toThrow(/layout\.ts/)
  })

  it("writes nothing when it refuses", () => {
    /*
     * The half that makes the refusal worth having. The copy loop writes file by
     * file, so a template missing its LAST source can still have overwritten the
     * first two — leaving exactly the half-applied site the refusal exists to
     * prevent, and leaving it after an error the operator has been told to fix.
     */
    fs.writeFileSync(path.join(root, "site", "theme.css"), "/* previous */\n")
    fs.writeFileSync(path.join(root, "site", "fonts.ts"), 'export const font = "previous"\n')
    fs.rmSync(path.join(root, "templates", "asiatique-wokstreet", "layout.ts"))

    expect(() => applyTemplate("asiatique-wokstreet", root)).toThrow()

    expect(fs.readFileSync(path.join(root, "site", "theme.css"), "utf8")).toContain("previous")
    expect(fs.readFileSync(path.join(root, "site", "fonts.ts"), "utf8")).toContain("previous")
  })

  it("applies a complete template, so the refusal is about the missing file", () => {
    // Anti-vacuity: an applier that threw on everything would satisfy every
    // case above.
    expect(() => applyTemplate("asiatique-wokstreet", root)).not.toThrow()
    expect(fs.readFileSync(path.join(root, "site", "layout.ts"), "utf8")).toContain("wokstreet")
  })

  it("names the aliases among the available templates when the slug is unknown", () => {
    expect(() => applyTemplate("asiatique-nonesuch", root)).toThrow(/asiatique-izakaya/)
  })
})

describe("listTemplates", () => {
  it("exposes the aliases so the catalogue can be cross-checked", () => {
    const root = makeRoot()
    try {
      const asiatique = listTemplates(root).find((t) => t.slug === "asiatique")
      expect(asiatique.aliases).toEqual(["asiatique-izakaya"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
