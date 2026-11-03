/// <reference types="vite/client" />

/**
 * A caller-supplied url is fetched through the guard, not through bare `fetch`
 * (#618).
 *
 * The behaviour itself is tested where it lives —
 * `packages/core/src/net/__tests__/public-url.test.ts` drives a redirect chain
 * into the metadata endpoint and asserts it is never asked for. What that
 * cannot tell you is whether THIS app calls it, and the defect was exactly
 * that: a correct-looking `validateImageUrl` sat three lines above a
 * `fetch(imageUrl)` that followed redirects, so the check was real and the
 * fetch ignored it.
 *
 * So this reads source. It is the only way to assert "the guard is on the
 * path": driving `analyze` needs an OpenAI key, an S3 bucket and a real image.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const CONVEX = join(process.cwd(), "convex")

function source(file: string): string {
  return readFileSync(join(CONVEX, file), "utf8")
}

/** Comments removed: this fix is explained in one, and it names what it replaced. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

describe("imageToProduct fetches a caller's url", () => {
  const body = code("imageToProduct.ts")

  it("through the shared guard", () => {
    expect(body).toMatch(/from "@be-yours\/core\/net\/public-url"/)
    expect(body).toMatch(/fetchPublicUrl\(/)
  })

  it("and never with a bare fetch", () => {
    // The three remaining `fetch` calls in this file are to api.openai.com,
    // which is a constant in the source and not a caller's url.
    const fetches = [...body.matchAll(/(?<!\w)fetch\(\s*([^\n]*)/g)].map((m) =>
      (m[1] ?? "").trim(),
    )
    const notConstant = fetches.filter((argument) => !argument.startsWith('"https://'))
    expect(notConstant).toEqual([])
  })

  it("and refuses one before it spends the quota reservation", () => {
    expect(body).toMatch(/parsePublicUrl\(args\.imageUrl\)/)
  })

  it("no longer carries its own block-list", () => {
    // Anti-vacuity, and the thing that would quietly come back: a second copy
    // of the list is how both apps ended up with the same defect.
    expect(body).not.toMatch(/169\.254\.169\.254/)
    expect(body).not.toMatch(/function validateImageUrl/)
  })

  it("resolves the hostname, which is what catches a public name pointing inside", () => {
    expect(body).toMatch(/lookup:/)
    expect(body).toMatch(/node:dns/)
  })
})
