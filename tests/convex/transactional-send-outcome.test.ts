/// <reference types="vite/client" />

/**
 * No transactional send reports success over a failure (#631).
 *
 * `sendFromDeployment` is best-effort BY CONTRACT — it returns
 * `{ sent: false, error }` rather than throwing, because its other callers are
 * scheduled actions where an exception abandons a batch mid-campaign. Its own
 * docstring says so, and warns: « Callers are expected to READ the result —
 * four of them historically did not ».
 *
 * `teamMembersEmail.ts` and `maintenanceEmail.ts` were two of the four. Both
 * wrapped the `await` in a `try` and set a flag when nothing threw, and nothing
 * ever threw — so `emailSent` could not go false, the admin showed
 * « Invitation envoyée » whatever SES did, and the one screen that DID branch
 * on the flag (`team-page.tsx:543`) was neutralised by it.
 *
 * WHY SOURCE-LEVEL. The rule is about a SHAPE — a local `sendViaSES` wrapper
 * that discards the outcome — and the shape is what regressed. Driving the
 * actions needs a provider; the thing that broke is three lines above the call.
 */

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const CONVEX = join(process.cwd(), "convex")

function read(file: string): string {
  return readFileSync(join(CONVEX, file), "utf8")
}

/** Comments removed: every fix here is explained in one that quotes the defect. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

/**
 * The wrapper's source, from its declaration to the next top-level one.
 *
 * NOT `indexOf("\n}")`: the parameter type is an inline object literal, so the
 * first `\n}` in the function is the one closing `params: { … }`, and slicing
 * there returns the signature and none of the body. Measured — it reported all
 * three wrappers as discarding the outcome, including the one that already did
 * the right thing.
 */
function wrapperBody(source: string): string {
  const at = source.indexOf("async function sendViaSES")
  if (at < 0) return ""
  const rest = source.slice(at + 1)
  const next = rest.search(/\n(?:export |async function |function |interface |const |type )/)
  return next < 0 ? rest : rest.slice(0, next)
}

/** Every convex module that defines its own `sendViaSES` wrapper. */
function modulesWithWrapper(): string[] {
  return readdirSync(CONVEX)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /async function sendViaSES\s*\(/.test(read(f)))
}

describe("every sendViaSES wrapper", () => {
  const modules = modulesWithWrapper()

  it("there are some, and they are the ones this is about", () => {
    // Anti-vacuity: a renamed helper would empty the list and pass everything.
    expect(modules.sort()).toEqual(
      ["customerEmail.ts", "maintenanceEmail.ts", "teamMembersEmail.ts"].sort(),
    )
  })

  for (const file of modulesWithWrapper()) {
    it(`${file} reads the outcome instead of assuming it`, () => {
      const body = code(file)
      const wrapper = wrapperBody(body)

      /*
       * Either shape is correct, and both mean the same thing to a caller: a
       * failed send cannot look like a successful one.
       *
       *  - the wrapper inspects `.sent` and throws, so the `try/catch` the call
       *    sites already have becomes true rather than decorative;
       *  - or it returns the outcome and its callers branch on it.
       *
       * What is forbidden is `return sendFromDeployment(...)` / `return
       * sendEmail(...)` with nothing looking at the result, which is exactly
       * what shipped.
       */
      const inspectsOutcome = /\.sent\b/.test(wrapper)
      expect(inspectsOutcome, `${file}: the wrapper discards the send outcome`).toBe(true)
    })

    it(`${file} throws rather than returning a silent failure`, () => {
      const body = code(file)
      expect(/throw new Error/.test(wrapperBody(body)), file).toBe(true)
    })
  }
})

describe("the invitation actions", () => {
  const body = code("teamMembersEmail.ts")

  it("still report the flag their callers read", () => {
    // Anti-vacuity: deleting `emailSent` would satisfy the rule above and take
    // the warning off the screen.
    expect(body).toMatch(/emailSent/)
    expect(body.match(/emailSent = true/g)?.length).toBe(2)
  })

  it("set it inside a try whose catch leaves it false", () => {
    // The shape that is now correct BECAUSE the wrapper throws. Before, the
    // catch was unreachable on a provider failure.
    expect(body).toMatch(/let emailSent = false/)
    expect(body.match(/let emailSent = false/g)?.length).toBe(2)
  })
})

describe("the migration notice", () => {
  const body = code("maintenanceEmail.ts")

  it("reports both halves separately", () => {
    // The team alert and the client confirmation fail independently, and an
    // operator needs to know which.
    expect(body).toMatch(/bidNotified/)
    expect(body).toMatch(/clientNotified/)
  })
})
