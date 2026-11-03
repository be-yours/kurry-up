// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The verifier a client runs, and what its logs are allowed to carry.
 *
 * TWO FINDINGS OF #433, both invisible to every test that existed.
 *
 * **The hardened verifier was dead code (#433.2).**
 *
 *     $ grep -rn "verifyWebhookSignature" packages apps --include='*.ts' \
 *         | grep -v __tests__ | grep -v /dist/
 *     packages/integrations/src/deliveroo/security.ts:44:export async function …
 *     apps/themes/e2e/deliveroo/webhook-signing.test.ts:59
 *     apps/reference/e2e/deliveroo/webhook-signing.test.ts:59
 *
 * Only the two test files imported it. The delivered route had its own copy,
 * which dropped the package's hex-format check and its 64-character length
 * check and stripped a `sha256=` prefix the package deliberately refuses. So
 * `webhook-signing.test.ts`'s docblock — *"The real verifier and the real
 * route … put in front of the code that will judge it in production"* — was
 * false of the tree it ran on. The suite proved a function no client executed.
 *
 * **The debug logging printed the diner's allergy note (#433.3).** Four
 * `[Sync Debug]` lines were unconditional and compiled into the artefact
 * `convex deploy` produces, and one of them printed `note="…"` — free text the
 * codebase documents elsewhere as a food-safety path. Health data, into a
 * client's Convex log, on every Deliveroo order.
 *
 * These are source assertions rather than behavioural ones, deliberately. Both
 * defects are about which code the delivered tree contains: a behavioural test
 * of the route passes identically whether the route verifies with its own copy
 * or with the package's, which is exactly why neither was caught.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const CONVEX = join(__dirname, "..", "..", "convex")
const read = (file: string) => readFileSync(join(CONVEX, file), "utf8")

// ===========================================================================
// One verifier, and it is the hardened one
// ===========================================================================

describe("the Deliveroo webhook route", () => {
  test("verifies with the package's function, not a copy of its own", async () => {
    const source = read("deliverooWebhookHandler.ts")
    expect(source).toMatch(/deliveroo\.verifyWebhookSignature\(/)
  })

  test("and keeps no private HMAC of its own", async () => {
    // The copy is what drifted. A route that still builds its own message and
    // calls `crypto.subtle.verify` has a second verifier, whatever else it
    // also calls.
    const source = read("deliverooWebhookHandler.ts")
    expect(source).not.toMatch(/crypto\.subtle\.(importKey|verify)/)
    expect(source).not.toMatch(/function hexToBuffer/)
  })

  test("it no longer strips a `sha256=` prefix the package refuses", async () => {
    // The measured difference between the two copies, and the direction that
    // matters: the route accepted a shape the hardened verifier rejects.
    const source = read("deliverooWebhookHandler.ts")
    expect(source).not.toMatch(/\^sha256=/)
  })

  test("and a rejection is not an oracle", async () => {
    // It logged the first eight characters of the signature it received and
    // confirmed that a secret was configured — the first is a free oracle for
    // anyone probing the endpoint, the second tells them it is live and
    // misconfigured rather than simply refusing.
    const source = read("deliverooWebhookHandler.ts")
    expect(source).not.toMatch(/Sig Debug/)
    // `secret configured: yes` specifically. "No signing secret configured" a
    // few lines up is a different fact for a different reader — our own
    // misconfiguration, logged for the operator — and removing it would take a
    // real diagnostic away.
    expect(source).not.toMatch(/secret configured: yes/)
    expect(source).not.toMatch(/cleanSig\.substring/)
  })

  test("the hardened verifier is importable from the V8 runtime at all", async () => {
    // The reason the delegation is possible: nothing under
    // `packages/integrations/src` touches a Node built-in, so the runtime this
    // `httpAction` runs in can bundle the barrel. Checked rather than assumed,
    // because the day it stops being true this route stops deploying.
    const { deliveroo } = await import("@be-yours/integrations")
    expect(typeof deliveroo.verifyWebhookSignature).toBe("function")
  })

  test("and it still refuses what it was hardened to refuse", async () => {
    // Driven, not read: this is the behaviour the route now inherits.
    const { deliveroo } = await import("@be-yours/integrations")
    const body = new TextEncoder().encode("{}")
    const guid = "11111111-2222-3333-4444-555555555555"

    // Not hex.
    expect(await deliveroo.verifyWebhookSignature(body, "zz".repeat(32), guid, "s")).toBe(false)
    // Right alphabet, wrong length — a truncated header.
    expect(await deliveroo.verifyWebhookSignature(body, "ab".repeat(20), guid, "s")).toBe(false)
    // A prefix the route used to strip.
    expect(await deliveroo.verifyWebhookSignature(body, `sha256=${"a".repeat(64)}`, guid, "s")).toBe(false)
    // No guid at all: nothing binds the payload to its delivery.
    expect(await deliveroo.verifyWebhookSignature(body, "a".repeat(64), "", "s")).toBe(false)
  })
})

// ===========================================================================
// What the logs may carry
// ===========================================================================

describe("the Deliveroo sync-status logging", () => {
  test("never prints what the diner wrote", async () => {
    // `orders.ts` calls the note a food-safety path. The keyword scan below it
    // reads the note and has to; printing it is a separate act, and a DEBUG
    // flag set to diagnose something else must not start logging a customer's
    // allergies.
    const source = read("deliverooWebhook.ts")
    expect(source).not.toMatch(/note="\$\{/)
    expect(source).not.toMatch(/notes="\$\{/)
  })

  test("and every debug line is gated", async () => {
    // Unconditional `console.log` with a `[Sync Debug]` tag is what shipped.
    // `packages/integrations/src/common/logger.ts` has gated on
    // NODE_ENV/DEBUG for as long as it has existed: the package did it right
    // and the app code the client runs did not.
    const source = read("deliverooWebhook.ts")
    const raw = source
      .split("\n")
      .filter((line) => /console\.log\(`\[Sync Debug\]/.test(line))
      // The helper's own body is the one place the string may appear.
      .filter((line) => !line.includes("${message}"))
    expect(raw).toEqual([])
  })

  test("the gate is the same one the package uses", async () => {
    const source = read("deliverooWebhook.ts")
    expect(source).toMatch(/NODE_ENV === "production"/)
    expect(source).toMatch(/process\.env\.DEBUG/)
  })

  test("and it still reports the shape the decision is made from", async () => {
    // Removing the lines outright would have been the other failure: the PLU
    // decision below them is what they exist to debug, and a mismatch on a live
    // order is diagnosed from them.
    const source = read("deliverooWebhook.ts")
    expect(source).toMatch(/char\(s\)/)
    expect(source).toMatch(/hasMissingPLU=/)
  })
})
