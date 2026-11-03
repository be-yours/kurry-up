/// <reference types="vite/client" />

/**
 * Every variable the Convex tree reads is one an operator can provision (#502,
 * held here since #532).
 *
 * WHY IT MATTERS, measured once already. `convex/system.ts` reads
 * `ENGINE_RELEASE_PACKUMENT_URL` and `ENGINE_RELEASE_REGISTRY_TOKEN` to tell an
 * operator which engine version they could move to, and neither key was
 * declared anywhere — not in `packages/core/src/env/schemas.ts`, not in the
 * provisioning manifest. `infisical-bootstrap.mjs migrate` refuses an
 * out-of-spec key, so there was **no documented way to provision the feed at
 * all**: the Système screen reported "unconfigured" on every deployment, and the
 * only way to learn the two names was to read the source.
 *
 * WHAT #532 FOUND. Removing the schema entry and the manifest entry together
 * left every suite green — 12/12, 46/46, 27/27. Nothing compared what the code
 * READS against what the tooling can SET, so the fix was held by nothing and
 * the same gap could reopen on the next variable.
 *
 * WHY A SWEEP AND NOT TWO ASSERTIONS. The defect is not about those two names;
 * it is about the class. A variable read inside Convex and declared nowhere is
 * unprovisionable whichever one it is, and the failure is silent — the feature
 * reports itself unconfigured for ever, on every deployment, and looks like a
 * feature nobody finished.
 *
 * BOTH LISTS, because they answer different questions. `schemas.ts` is what
 * `instrumentation.ts` validates at boot; `manifest.ts` is what the provisioning
 * tooling will accept. A name in one and not the other is provisionable and
 * unvalidated, or validated and unprovisionable.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import { APP_ROOT, enginePackageFile } from "../lib/repo-layout"

const CONVEX = join(APP_ROOT, "convex")

/**
 * A file in `@be-yours/core`'s env module, at whichever of its two
 * addresses this checkout uses.
 *
 * This file SHIPS. `join(process.cwd(), "../../packages/core/src/env")` is an
 * address only the engine monorepo has, so in a delivered site both reads below
 * died on ENOENT and took the whole suite with them — `core` publishes `src`
 * as well as `dist`, so the file a client has is perfectly readable and only
 * the path to it was wrong.
 */
function envSource(name: string): string {
  const file = enginePackageFile("core", `src/env/${name}`)
  if (file === null) {
    throw new Error(
      `@be-yours/core/src/env/${name} is not in this checkout, so every ` +
        "variable below would read as undeclared"
    )
  }
  return readFileSync(file, "utf8")
}

/**
 * Names a Convex module may read without anybody provisioning them.
 *
 * Runtime built-ins only. Every entry has to be something the PLATFORM sets, not
 * something an operator forgets — anything else on this list is the gap this
 * file exists to close, wearing a different hat.
 */
const RUNTIME_BUILTINS = new Set(["NODE_ENV", "DEBUG"])

function code(file: string): string {
  return readFileSync(file, "utf8")
    // A comment naming a variable is not a read of it, and several of these
    // files explain their own configuration at length.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

/** `{ NAME: [file, …] }` over every `process.env` read under `convex/`. */
function envReads(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const entry of readdirSync(CONVEX)) {
    if (!entry.endsWith(".ts")) continue
    const source = code(join(CONVEX, entry))
    const names = [
      ...source.matchAll(/process\.env\.([A-Z0-9_]+)/g),
      ...source.matchAll(/process\.env\[["']([A-Z0-9_]+)["']\]/g),
    ].map((m) => m[1]!)
    for (const name of names) {
      const seen = found.get(name) ?? []
      if (!seen.includes(entry)) seen.push(entry)
      found.set(name, seen)
    }
  }
  return found
}

const SCHEMAS = envSource("schemas.ts")
const MANIFEST = envSource("manifest.ts")

/** Declared, whichever list is asked — a whole-word match on the name. */
const declaredIn = (source: string, name: string) =>
  new RegExp(`\\b${name}\\b`).test(source)

describe("what the Convex tree reads from the environment", () => {
  const reads = envReads()

  test("there are reads to check", () => {
    // Anti-vacuity: a wrong CONVEX path, or a regex that stopped matching,
    // makes every assertion below pass by finding nothing at all.
    expect(reads.size).toBeGreaterThan(15)
    expect([...reads.keys()]).toContain("OPENAI_API_KEY")
  })

  test("is validated at boot", () => {
    const undeclared = [...reads]
      .filter(([name]) => !RUNTIME_BUILTINS.has(name))
      .filter(([name]) => !declaredIn(SCHEMAS, name))
      .map(([name, files]) => `${name} (${files.join(", ")})`)

    expect(
      undeclared,
      "read inside Convex and absent from packages/core/src/env/schemas.ts"
    ).toEqual([])
  })

  test("is provisionable by the tooling", () => {
    const unprovisionable = [...reads]
      .filter(([name]) => !RUNTIME_BUILTINS.has(name))
      .filter(([name]) => !declaredIn(MANIFEST, name))
      .map(([name, files]) => `${name} (${files.join(", ")})`)

    expect(
      unprovisionable,
      "read inside Convex and absent from packages/core/src/env/manifest.ts — " +
        "`infisical-bootstrap.mjs migrate` refuses an out-of-spec key"
    ).toEqual([])
  })

  test("the exemptions are runtime built-ins, and are actually read", () => {
    /*
     * A guard whose exemption list can hold anything is an exemption list. Both
     * halves: an entry nothing reads is dead weight that would quietly cover a
     * future variable of the same name, and the list must stay short enough to
     * read.
     */
    for (const name of RUNTIME_BUILTINS) {
      expect(reads.has(name), `${name} is exempted and read by nothing`).toBe(true)
    }
    expect(RUNTIME_BUILTINS.size).toBeLessThanOrEqual(3)
  })

  test("the engine update feed is declared in both lists", () => {
    /*
     * Named directly as well as covered by the sweep, so deleting the sweep or
     * widening the exemptions would not silently release the two names #502 was
     * about.
     */
    for (const name of [
      "ENGINE_RELEASE_PACKUMENT_URL",
      "ENGINE_RELEASE_REGISTRY_TOKEN",
    ]) {
      expect(reads.get(name), `${name} is no longer read by convex/`).toContain("system.ts")
      expect(declaredIn(SCHEMAS, name), `${name} missing from schemas.ts`).toBe(true)
      expect(declaredIn(MANIFEST, name), `${name} missing from manifest.ts`).toBe(true)
    }
  })
})
