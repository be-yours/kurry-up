/// <reference types="vite/client" />

/**
 * A transactional send that fails gives its claim back (#530).
 *
 * THE BUG. `readyEmailAt` and `confirmationEmailAt` are stamped on the order
 * inside the mutation that decides the send, before SES is called — that is
 * what stops two tablets producing two emails, and it has to be transactional.
 * The action then rendered, called SES, and on any failure logged and returned
 * `{ sent: false }` with the claim still standing.
 *
 * So a transient outage was indistinguishable from a delivered mail: no retry,
 * no admin surface, nothing on the order. The owner saw a normal order and the
 * diner sat waiting for food that was ready. Both actions had the shape; the
 * « no sender address » branch a few lines above each one already released,
 * with the right reason written beside it, and the catch never got the same
 * treatment.
 *
 * WHY THIS IS A SOURCE-LEVEL CHECK. `convex/customerEmail.ts` is `"use node"`
 * and these suites run under `edge-runtime`, so the module does not load here
 * and no behavioural test can reach the catch block — the same limit
 * `settlement-binding.test.ts` states about the payment paths, and the same
 * answer: what can be proved is that the call is in it.
 *
 * WHY IT IS NOT ENOUGH TO GREP THE MODULE. Both release mutations were already
 * called before this fix, in the branch that handles a missing sender. A check
 * asking only "does this file mention `releaseReadyNoticeClaim`" was green over
 * the defect. The block is extracted and the assertion made inside it.
 *
 * Comments are stripped first, because the comment in each catch now explains
 * the release at length and names the mutation while doing so.
 */

import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCE = join(__dirname, "../../convex/customerEmail.ts")

/** The two sends that claim on the order before they call the transport. */
const SENDS = [
  {
    fn: "sendOrderReady",
    release: "releaseReadyNoticeClaim",
    log: "[orderReady]",
  },
  {
    fn: "sendOrderConfirmation",
    release: "releaseConfirmationClaim",
    log: "[orderConfirmation]",
  },
] as const

/** The module with comments removed, so prose about a call cannot pass for one. */
function source(): string {
  return readFileSync(SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
}

/**
 * The balanced `{ … }` that starts at or after `from`.
 *
 * A regex cannot do this: every one of these bodies contains nested braces,
 * template literals and object arguments, and a non-greedy match stops at the
 * first `}` while a greedy one swallows the rest of the file. Both failures
 * read as a passing test, which is the direction that matters.
 */
function blockAt(text: string, from: number): string {
  const open = text.indexOf("{", from)
  if (open === -1) return ""

  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return ""
}

/** The body of `if (<condition>) { … }` inside one send, by brace balancing. */
function branchBody(fn: string, condition: string): string {
  const text = source()
  const start = text.indexOf(`export const ${fn}`)
  if (start === -1) return ""

  const body = blockAt(text, start)
  const at = body.indexOf(`if (${condition})`)
  if (at === -1) return ""

  return blockAt(body, at)
}

/** The `catch (…) { … }` body of the try around the transport call, for one send. */
function catchBody(fn: string): string {
  const text = source()
  const start = text.indexOf(`export const ${fn}`)
  if (start === -1) return ""

  const body = blockAt(text, start)
  const caught = body.indexOf("catch")
  if (caught === -1) return ""

  return blockAt(body, caught)
}

describe("a transactional send that fails gives its claim back", () => {
  test("both sends exist and their catch blocks are found", () => {
    // Anti-vacuity. A renamed export or a changed shape makes every assertion
    // below run against "" and pass, which is exactly how a guard stops
    // guarding without anybody noticing.
    for (const send of SENDS) {
      const body = catchBody(send.fn)
      expect(body, `${send.fn}: no catch block found`).not.toBe("")
      expect(body.length, `${send.fn}: catch block implausibly short`).toBeGreaterThan(40)
    }
  })

  test.each(SENDS)("$fn releases its claim when the transport fails", (send) => {
    expect(
      new RegExp(`\\b${send.release}\\b`).test(catchBody(send.fn)),
      `${send.fn}'s catch must call ${send.release}: a claim kept over a failed ` +
        `send loses the email for ever, and looks exactly like one that was sent`
    ).toBe(true)
  })

  test.each(SENDS)("$fn does not log the raw transport error", (send) => {
    const body = catchBody(send.fn)

    // Some SES rejections carry the recipient's address inside the error
    // object, and this line lands in a log an operator reads. `error.message`
    // and the order id say what happened without carrying a diner's address
    // into it.
    expect(
      /console\.error\([^)]*,\s*error\s*\)/.test(body),
      `${send.fn} logs the raw error object; log error.message instead`
    ).toBe(false)
    expect(
      /error instanceof Error \? error\.message/.test(body),
      `${send.fn} should log error.message`
    ).toBe(true)
    expect(body).toContain(send.log)
  })

  test("the detector can say no", () => {
    // The half that keeps the three above honest: run the same extraction over
    // a catch that releases nothing, and it must fail. Without this, a broken
    // `blockAt` would report every send compliant.
    const nothingReleased = `
      export const sendSomething = internalAction({
        handler: async (ctx, args) => {
          try { await sendViaSES({}) } catch (error) {
            console.error("[x] send failed:", error);
            return { sent: false };
          }
        },
      });
    `
    const start = nothingReleased.indexOf("export const sendSomething")
    const body = blockAt(nothingReleased, start)
    const caught = blockAt(body, body.indexOf("catch"))

    expect(caught).not.toBe("")
    expect(/\breleaseReadyNoticeClaim\b/.test(caught)).toBe(false)
    expect(/console\.error\([^)]*,\s*error\s*\)/.test(caught)).toBe(true)
  })

  test("the failure is recorded with the same string that was logged", (): void => {
    // Not the raw error object, for the reason the log test above gives: the
    // order detail screen is read by every member who can open an order, and
    // some SES rejections carry the recipient's address inside the object.
    for (const send of SENDS) {
      const body = catchBody(send.fn)
      expect(body, `${send.fn} should record reason "transport"`).toMatch(
        /reason:\s*"transport"/
      )
      expect(
        /failure:\s*\{[^}]*detail\s*\}/.test(body),
        `${send.fn} should pass the detail it logged, not the error object`
      ).toBe(true)
    }
  })

  test("the branches that report and the branch that stays quiet are found", () => {
    // Anti-vacuity for the two below. A renamed condition makes both run
    // against "" — one would pass for the wrong reason and the other would
    // pass for no reason at all.
    for (const send of SENDS) {
      expect(branchBody(send.fn, "!payload").length).toBeGreaterThan(40)
      expect(branchBody(send.fn, "!fromAddress").length).toBeGreaterThan(40)
    }
  })

  test.each(SENDS)("$fn names the configuration gap when no sender is set", (send) => {
    // The one failure an owner can repair themselves, so it is the one most
    // worth putting on the order.
    expect(branchBody(send.fn, "!fromAddress")).toMatch(
      /reason:\s*"no_sender_address"/
    )
  })

  test.each(SENDS)("$fn reports nothing when the order itself is gone", (send) => {
    /*
     * THE ASYMMETRY THIS WHOLE CHANGE RESTS ON (#530).
     *
     * This branch releases the claim too, but nothing failed: the order was
     * cancelled, refunded or deleted between the claim and the send. Recording
     * a failed notice here would put « e-mail non parti » on the screen of an
     * order that no longer exists, which is worse than silence — and it is the
     * mistake an implementation makes by hanging the record on the release
     * itself rather than on the caller.
     */
    const body = branchBody(send.fn, "!payload")

    expect(body, `${send.fn}: the claim still goes back here`).toContain(send.release)
    expect(
      /failure:/.test(body),
      `${send.fn} must NOT report a failure for an order that is gone`
    ).toBe(false)
  })

  test("the claim is still written before the transport is called", () => {
    // The fix must not have been made by dropping the claim instead. The
    // release only makes sense over a claim that exists: without one, two
    // tablets marking an order ready produce two emails, which is the defect
    // the claim was introduced for.
    const text = source()
    for (const send of SENDS) {
      const body = blockAt(text, text.indexOf(`export const ${send.fn}`))
      expect(body).toContain(send.release)
      expect(body).toContain("sendViaSES")
    }
  })
})
