/**
 * A delivered restaurant site must not trust a development origin.
 *
 * `convex/auth.ts` has carried a comment saying exactly that — "un site client
 * n'a aucune raison d'accepter une origine de développement" — while the line
 * underneath it appended `http://localhost:3000` to every deployment, this
 * one included. A comment is not a control. This is the control.
 *
 * WHY IT READS THE SOURCE. Both files build their config at module scope
 * against `process.env`, and `convex/auth.ts` pulls in the Better Auth Convex
 * component, which needs a Convex runtime to import at all. What can be
 * checked without one is the thing that actually went wrong: a hard-coded dev
 * origin in the list. So this asserts on the text, and asserts the ONE shape
 * that is still allowed — a dev origin reachable only when the build is not a
 * production build.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const APP = process.cwd()

/** Any localhost or loopback origin, however it is spelled. */
const DEV_ORIGIN = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/

function read(relative: string): string {
  return readFileSync(join(APP, relative), "utf8")
}

/**
 * The `trustedOrigins` value as written, with comments removed.
 *
 * Comments are stripped for the same reason the Convex auth ESLint rule stopped
 * reading them: this file's own history is a comment that said the right thing
 * above code that did the wrong one, and a test that reads both cannot tell
 * them apart.
 */
function trustedOriginsSource(source: string): string {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
  const at = withoutComments.indexOf("trustedOrigins")
  expect(at, "the file no longer configures trustedOrigins at all").toBeGreaterThan(-1)
  // To the end of the property value: the next line that closes the object or
  // starts the following property at the same depth is far enough.
  return withoutComments.slice(at, at + 600)
}

describe("the shipped site trusts only the origins it was configured with", () => {
  it("names no development origin in the Convex auth config", () => {
    const value = trustedOriginsSource(read("convex/auth.ts"))
    expect(value).not.toMatch(DEV_ORIGIN)
  })

  it("derives its Convex origins from SITE_URL, which a deployment cannot boot without", () => {
    // `siteRequiredShape` in `@be-yours/core/env` refuses to start without
    // it, so this is not a fallback that can quietly be missing — which is what
    // makes dropping the literal safe for a developer as well.
    expect(read("convex/auth.ts")).toMatch(/trustedOrigins:\s*process\.env\.SITE_URL/)
  })

  it("reaches a development origin in the Next handler only outside production", () => {
    const source = read("lib/convex.ts")
    // The literals may exist — a developer still signs in on localhost — but
    // every one of them has to sit behind the production check.
    expect(source).toMatch(/process\.env\.NODE_ENV\s*===\s*"production"/)

    const devOrigins = source.slice(source.indexOf("DEV_ORIGINS"))
    expect(devOrigins).toMatch(DEV_ORIGIN)

    // And the production branch must be the configured list alone.
    expect(source).toMatch(/\?\s*configured\s*\n?\s*:\s*\[\s*\.\.\.configured/)
  })

  it("uses no development origin as the fallback for an unset variable", () => {
    // The shape that made this unconditional in the first place:
    // `process.env.BETTER_AUTH_URL ?? "http://localhost:3000"`. An unset
    // variable in production must yield nothing, not a developer's machine.
    for (const file of ["convex/auth.ts", "lib/convex.ts"]) {
      expect(read(file), file).not.toMatch(
        /process\.env\.\w+\s*(?:\?\?|\|\|)\s*["'`]https?:\/\/(?:localhost|127\.0\.0\.1)/,
      )
    }
  })
})
