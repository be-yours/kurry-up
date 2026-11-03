// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * What the order records when a transactional notice does not go out (#530).
 *
 * #558 made a failed send give its claim back, so a later legitimate transition
 * can still write. Nobody was told it had happened: from the admin an outage and
 * a delivered mail were the same thing, and the diner waited for a « Commande
 * prête » that no longer existed anywhere.
 *
 * WHAT IS TESTED HERE AND WHAT IS TESTED NEXT DOOR. The mutations are ordinary
 * Convex mutations, so they run here against a real database. The ACTION that
 * calls them is `"use node"` and these suites run under `edge-runtime`, so it
 * cannot be loaded at all — which of the two reasons each call site names is
 * pinned at source level in `transactional-send-claims.test.ts`, the same split
 * #558 used and for the same reason.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { planOrderReady } from "@be-yours/convex-functions/orderReady"
import { readSubscriberStanding } from "@be-yours/convex-functions/orderConfirmation"
import { internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_800_000_000_000
const EMAIL = "camille@example.fr"

function newHarness() {
  return convexTest(schema, modules)
}

async function seedStore(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Chez Camille",
      slug: "chez-camille",
      address: {
        street: "1 rue de la Paix",
        city: "Paris",
        postalCode: "75002",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

/**
 * An order a ready notice may legitimately be sent for.
 *
 * `pickup` rather than `delivery`: `orderReadyRefusal` refuses a delivery order
 * outright, so a delivery fixture would make every case below pass by refusing
 * before it reached anything this file is about.
 */
async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  extra: Record<string, unknown> = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: "A-1",
      customerInfo: { name: "Camille", email: EMAIL },
      type: "pickup" as const,
      status: "pending" as const,
      items: [],
      subtotal: 4000,
      taxAmount: 0,
      total: 4000,
      paymentMethod: "card" as const,
      paymentStatus: "paid" as const,
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    })
  )
}

const read = (t: ReturnType<typeof convexTest>, orderId: Id<"orders">) =>
  t.run((ctx) => ctx.db.get(orderId))

/** The two notices, and the mutation and fields each one owns. */
const NOTICES = [
  {
    label: "ready",
    release: "releaseReadyNoticeClaim",
    claimField: "readyEmailAt",
    failureField: "readyEmailFailure",
  },
  {
    label: "confirmation",
    release: "releaseConfirmationClaim",
    claimField: "confirmationEmailAt",
    failureField: "confirmationEmailFailure",
  },
] as const

describe("releasing a claim records why, when there is a why", () => {
  test.each(NOTICES)(
    "$label: a named failure is written on the order",
    async (notice) => {
      const t = newHarness()
      const storeId = await seedStore(t)
      const orderId = await seedOrder(t, storeId, { [notice.claimField]: NOW })

      await t.mutation(internal.orders[notice.release], {
        orderId,
        failure: { reason: "transport", detail: "Throttling: rate exceeded" },
      })

      const order = await read(t, orderId)
      expect(order?.[notice.claimField]).toBeUndefined()
      expect(order?.[notice.failureField]).toMatchObject({
        reason: "transport",
        detail: "Throttling: rate exceeded",
      })
      expect(typeof order?.[notice.failureField]?.at).toBe("number")
    }
  )

  test.each(NOTICES)(
    "$label: a release with no failure named reports nothing",
    async (notice) => {
      /*
       * THE ASYMMETRY THE WHOLE CHANGE RESTS ON. This is the shape of the two
       * call sites that release because the order was cancelled or deleted
       * between the claim and the send. Nothing failed, and putting « e-mail non
       * parti » on the screen of an order that no longer exists would be worse
       * than silence.
       */
      const t = newHarness()
      const storeId = await seedStore(t)
      const orderId = await seedOrder(t, storeId, { [notice.claimField]: NOW })

      await t.mutation(internal.orders[notice.release], { orderId })

      const order = await read(t, orderId)
      expect(order?.[notice.claimField]).toBeUndefined()
      expect(order?.[notice.failureField]).toBeUndefined()
    }
  )

  test.each(NOTICES)(
    "$label: the reason for a configuration gap carries no provider message",
    async (notice) => {
      const t = newHarness()
      const storeId = await seedStore(t)
      const orderId = await seedOrder(t, storeId, { [notice.claimField]: NOW })

      await t.mutation(internal.orders[notice.release], {
        orderId,
        failure: { reason: "no_sender_address" },
      })

      const order = await read(t, orderId)
      expect(order?.[notice.failureField]?.reason).toBe("no_sender_address")
      expect(order?.[notice.failureField]?.detail).toBeUndefined()
    }
  )

  test("a confirmation failure is recorded even when the claim has already gone", async () => {
    // The two halves of the release are separately conditional. An owner's
    // question is "did my diner get the mail", and the answer must not depend on
    // which of the claim and the failure was written first.
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId)

    await t.mutation(internal.orders.releaseConfirmationClaim, {
      orderId,
      failure: { reason: "transport", detail: "connection reset" },
    })

    const order = await read(t, orderId)
    expect(order?.confirmationEmailFailure?.reason).toBe("transport")
  })
})

describe("a new dispatch clears the last one's failure", () => {
  test("claiming a ready notice wipes a recorded outage", async () => {
    /*
     * Otherwise a repaired notice leaves a stale failure on the order detail for
     * ever, and the screen starts lying in the other direction: an owner is told
     * a mail did not go out when the next attempt delivered it.
     *
     * `planOrderReady` is called directly rather than through a status
     * transition: the claim is what this asserts, and driving `updateStatus`
     * would put a kitchen-ticket fixture between the test and the thing tested.
     */
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedOrder(t, storeId, {
      readyEmailFailure: { at: NOW - 60_000, reason: "transport" as const },
    })

    const planned = await t.run((ctx) =>
      planOrderReady(ctx, orderId, readSubscriberStanding)
    )

    // Anti-vacuity: a refusal returns null and would clear nothing, so a fixture
    // the refusal rejects would make this pass while proving nothing.
    expect(planned, "the notice must actually have been claimed").not.toBeNull()

    const order = await read(t, orderId)
    expect(typeof order?.readyEmailAt).toBe("number")
    expect(order?.readyEmailFailure).toBeUndefined()
  })
})
