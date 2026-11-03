// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Creating a table QR code (#130).
 *
 * `gameQRCodesTable` declares `scannedCount` as a required `v.number()`, and
 * `gameQRCodes.create` spread the caller's args over `createdAt`/`updatedAt`
 * without ever stamping it. Convex rejected every insert with "Missing
 * required field `scannedCount`", so no QR code could be created — and since
 * the QR code is the entry point of the whole gamification flow, nobody could
 * ever play.
 *
 * Nothing caught it for four rounds, and the reason is worth recording. The
 * two existing assertions on this mutation live in `authorization.test.ts` and
 * are both negative: the RBAC guard throws before the handler runs, so the
 * validator never speaks. The unit suite in `packages/convex-functions` calls
 * the handlers past a hand-rolled mock `db` that validates nothing. There was
 * no positive-path test of `gameQRCodes.create` anywhere in the repo.
 *
 * These tests go through the real Convex function, the real validator and the
 * real schema, which is the seam that broke. Every consumer of the field
 * tolerates `undefined` (`recordScan` and both admin readers use `?? 0`), so
 * the schema is the only thing that ever objected — which is exactly why the
 * assertion has to be made here.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

const STORE_CREATE_PAYLOAD = {
  name: "Pizzeria Napoli",
  slug: "pizzeria-napoli",
  description: "Napolitaine au feu de bois",
  address: {
    street: "12 rue Oberkampf",
    city: "Paris",
    postalCode: "75011",
    country: "France",
  },
  phone: "+33145678901",
  email: "napoli@example.com",
}

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Catalogue writes queue an Uber Eats / Deliveroo sync through the scheduler.
 * Left pending, they fire against a closed transaction and surface as an
 * unhandled rejection that fails a run whose tests all passed. Same guard as
 * `store-creation.test.ts`.
 */
afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query("_scheduled_functions").collect()
      for (const job of pending) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

/** An owner with one establishment, signed in. */
async function seedOwnerWithStore(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: "marie",
      role: "client_admin",
      storeIds: [],
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  const marie = t.withIdentity({ subject: "marie" })
  const storeId: Id<"stores"> = await marie.mutation(
    api.stores.create,
    STORE_CREATE_PAYLOAD
  )
  return { marie, storeId }
}

describe("gameQRCodes.create, called the way the QR codes page calls it", () => {
  test("creates the QR code", async () => {
    // The exact payload `qr-codes-page.tsx` sends — `scannedCount` is not among
    // the mutation's args, and must not become one: it is server state.
    const t = newHarness()
    const { marie, storeId } = await seedOwnerWithStore(t)

    const qrId = await marie.mutation(api.gameQRCodes.create, {
      storeId,
      code: "TABLE-01",
      tableNumber: "1",
      location: "Terrasse",
      isActive: true,
    })

    const qr = await t.run((ctx) => ctx.db.get(qrId))
    expect(qr?.code).toBe("TABLE-01")
    expect(qr?.tableNumber).toBe("1")
    expect(qr?.location).toBe("Terrasse")
    expect(qr?.isActive).toBe(true)
  })

  test("opens the scan counter at zero", async () => {
    // The regression itself. `scannedCount` is required by the schema and comes
    // from nowhere but here.
    const t = newHarness()
    const { marie, storeId } = await seedOwnerWithStore(t)

    const qrId = await marie.mutation(api.gameQRCodes.create, {
      storeId,
      code: "TABLE-02",
      isActive: true,
    })

    const qr = await t.run((ctx) => ctx.db.get(qrId))
    expect(qr?.scannedCount).toBe(0)
  })

  test("works with only the required fields", async () => {
    // `tableNumber` and `location` are optional in the dialog and in the args.
    const t = newHarness()
    const { marie, storeId } = await seedOwnerWithStore(t)

    const qrId = await marie.mutation(api.gameQRCodes.create, {
      storeId,
      code: "TABLE-03",
      isActive: true,
    })

    const qr = await t.run((ctx) => ctx.db.get(qrId))
    expect(qr?.scannedCount).toBe(0)
    expect(qr?.tableNumber).toBeUndefined()
  })

  test("lists what it created", async () => {
    const t = newHarness()
    const { marie, storeId } = await seedOwnerWithStore(t)

    await marie.mutation(api.gameQRCodes.create, {
      storeId,
      code: "TABLE-04",
      isActive: true,
    })
    await marie.mutation(api.gameQRCodes.create, {
      storeId,
      code: "TABLE-05",
      isActive: true,
    })

    const listed = await marie.query(api.gameQRCodes.list, { storeId })
    expect(listed.map((q) => q.code).sort()).toEqual(["TABLE-04", "TABLE-05"])
  })
})

describe("the counter the create path opens", () => {
  test("a scan increments it", async () => {
    // Proves the field `create` stamps is the one `recordScan` accumulates —
    // that the two halves agree, not merely that each compiles.
    const t = newHarness()
    const { marie, storeId } = await seedOwnerWithStore(t)

    const qrId = await marie.mutation(api.gameQRCodes.create, {
      storeId,
      code: "TABLE-06",
      isActive: true,
    })

    await t.mutation(api.gamePlay.recordScan, { code: "TABLE-06" })

    const qr = await t.run((ctx) => ctx.db.get(qrId))
    expect(qr?.scannedCount).toBe(1)
    expect(qr?.lastScannedAt).toEqual(expect.any(Number))
  })

  test("counts each scan of the same table", async () => {
    const t = newHarness()
    const { marie, storeId } = await seedOwnerWithStore(t)

    const qrId = await marie.mutation(api.gameQRCodes.create, {
      storeId,
      code: "TABLE-07",
      isActive: true,
    })

    await t.mutation(api.gamePlay.recordScan, { code: "TABLE-07" })
    await t.mutation(api.gamePlay.recordScan, { code: "TABLE-07" })
    await t.mutation(api.gamePlay.recordScan, { code: "TABLE-07" })

    const qr = await t.run((ctx) => ctx.db.get(qrId))
    expect(qr?.scannedCount).toBe(3)
  })
})
