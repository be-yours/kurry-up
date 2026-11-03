/**
 * Nothing an establishment types can end the JSON-LD script tag.
 *
 * WHAT WAS BROKEN. `JsonLd` escaped the literal string `</script>` with a
 * regular expression and nothing else. An HTML parser ends a script element at
 * `</script` followed by whitespace, `/` or `>`, so `</script >`, `</script/>`
 * and `</script\n>` were all left intact in the output and closed the tag —
 * everything after them parsed as markup, on the restaurant's own domain.
 *
 * The values reaching this serialiser are an establishment's own copy: the
 * blog article title (`lib/json-ld` puts it in the breadcrumb trail), the dish
 * name, the address. The blog title is now also cleaned on write, but that
 * only covers rows written since; this is the layer that has to hold for every
 * row and every field, including the ones nobody has thought about yet.
 *
 * WHY THE CASES BELOW ARE SPELLINGS OF ONE THING. The fix is not "catch more
 * spellings" — it is escaping `<` at all, which no variant survives. Each case
 * is a spelling that walked through the old regex, kept as a record of what
 * "escape the tag" missed.
 */

import { describe, expect, it, vi } from "vitest"

// `lib/json-ld` is a server module. Same stub the SSR suites use.
vi.mock("server-only", () => ({}))

import { serializeJsonLd } from "@/lib/json-ld"

/** What a browser would see inside `<script type="application/ld+json">…`. */
const breakouts = [
  "</script>",
  "</script >",
  "</script/>",
  "</script\n>",
  "</SCRIPT>",
  "</script\tfoo>",
  "<!--<script>",
  "<img src=x onerror=alert(1)>",
]

describe("serializeJsonLd", () => {
  it.each(breakouts)("cannot be ended by %j", (payload) => {
    const out = serializeJsonLd({ name: `Pizza ${payload}` })

    // The only assertion that matters: no `<` reaches the document at all, so
    // there is no tag to close and no comment to open.
    expect(out).not.toContain("<")
    expect(out).toContain("\\u003c")
  })

  it("escapes the characters that reconstruct a tag, not just the tag", () => {
    const out = serializeJsonLd({ name: "a < b > c & d" })
    expect(out).not.toMatch(/[<>&]/)
  })

  it("still produces the same document once parsed", () => {
    // Escaping must be a change of spelling, not of content: `\\u003c` is a
    // JSON string escape, so every consumer reads back what was written.
    const data = {
      "@context": "https://schema.org",
      name: "Chez Luigi </script><script>alert(1)</script>",
      description: "Pâtes & pizzas — l'été",
    }
    expect(JSON.parse(serializeJsonLd(data))).toEqual(data)
  })

  it("leaves ordinary copy readable once parsed", () => {
    const parsed = JSON.parse(serializeJsonLd({ name: "Bar & Grill" })) as {
      name: string
    }
    expect(parsed.name).toBe("Bar & Grill")
  })
})
