import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Nothing that runs on a schedule may call a guarded function.
 *
 * This is a source-level check, not a behavioural one, and it exists because
 * the mistake it catches has already happened twice in this repository.
 *
 * A scheduled sweep runs with no user identity. `internalAction` bodies that
 * reach for `api.something` are therefore calling a function that will either
 * refuse them — if it is guarded — or is public and should not be. The nightly
 * menu push died exactly this way: `syncAllStores` called
 * `api.uberEatsMenuSync.syncStore`, and the day that action got its permission
 * check, the sweep stopped working. Silently: a scheduler has nobody to tell.
 *
 * A behavioural test cannot catch this — the scheduler is not something
 * `convex-test` runs — so the invariant is asserted against the source.
 */

const CONVEX_DIR = join(__dirname, "../../convex")

/** Bodies of every `internalAction` declared in the app's convex/ directory. */
function internalActionBodies(): Array<{ file: string; name: string; body: string }> {
  const out: Array<{ file: string; name: string; body: string }> = []

  for (const file of readdirSync(CONVEX_DIR)) {
    if (!file.endsWith(".ts")) continue
    const source = readFileSync(join(CONVEX_DIR, file), "utf8")

    const declaration = /^export const ([A-Za-z0-9_]+) = internalAction\(/gm
    let match: RegExpExecArray | null
    while ((match = declaration.exec(source)) !== null) {
      const start = match.index
      const next = source.indexOf("\nexport const ", start + 1)
      out.push({
        file,
        name: match[1],
        body: source.slice(start, next === -1 ? source.length : next),
      })
    }
  }

  return out
}


/** Wrappers that demand a session, and therefore refuse a scheduled caller. */
const GUARDED_BUILDERS = [
  "storeQuery",
  "storeMutation",
  "authedQuery",
  "authedMutation",
]

/** Whether `convex/<module>.ts` exports `<fn>` behind one of those wrappers. */
function isGuarded(module: string, fn: string): boolean {
  let source: string
  try {
    source = readFileSync(join(CONVEX_DIR, `${module}.ts`), "utf8")
  } catch {
    return false
  }
  const declaration = new RegExp(
    `^export const ${fn} = (${GUARDED_BUILDERS.join("|")})\\(`,
    "m"
  )
  return declaration.test(source)
}

describe("scheduled and internal actions", () => {
  test("the app declares internal actions at all", () => {
    // Guards the guard: a regex that silently matches nothing would make every
    // assertion below vacuously true.
    expect(internalActionBodies().length).toBeGreaterThan(0)
  })

  test("no internal action calls a GUARDED function", () => {
    // The rule is not "never touch api.*". A scheduled sweep legitimately reads
    // the public catalogue — `products.list` and `categories.list` are open to
    // the storefront by design. What it must never touch is a function that
    // demands a session, because it has none.
    const offenders = internalActionBodies()
      .map(({ file, name, body }) => {
        const calls = [
          ...body.matchAll(/(?<![\w/.])api\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g),
        ]
          .map(([, module, fn]) => ({ module, fn }))
          .filter(({ module, fn }) => isGuarded(module, fn))
          .map(({ module, fn }) => `${module}.${fn}`)

        return { file, name, calls: [...new Set(calls)] }
      })
      .filter((entry) => entry.calls.length > 0)

    expect(
      offenders.map((o) => `${o.file}:${o.name} → ${o.calls.join(", ")}`)
    ).toEqual([])
  })

  test("the guard detector actually recognises a guarded function", () => {
    // Guards the guard: if `isGuarded` silently returned false for everything,
    // the assertion above would pass while proving nothing.
    expect(isGuarded("orders", "updateStatus")).toBe(true)
    expect(isGuarded("products", "list")).toBe(false)
  })

  test("the menu sweeps reach the platform through internal paths only", () => {
    for (const file of ["uberEatsMenuSync.ts", "deliverooMenuSync.ts"]) {
      const source = readFileSync(join(CONVEX_DIR, file), "utf8")
      const start = source.indexOf("export const syncAllStores")
      expect(start).toBeGreaterThan(-1)
      const next = source.indexOf("\nexport const ", start + 1)
      const body = source.slice(start, next === -1 ? source.length : next)

      expect(body).toContain("internalSyncStore")
      expect(body).not.toMatch(/\bapi\./)
    }
  })
})
