// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The Design screen's three save buttons, end to end.
 *
 * `stores.updateBranding` did not exist. `packages/admin` receives the Convex
 * API as `api: any`, so `useMutation(api?.stores?.updateBranding)` resolved to
 * `undefined` and every click on "Enregistrer les couleurs", "Enregistrer la
 * typographie" and "Enregistrer le logo" threw — the third dead button of that
 * class, in a screen every client uses.
 *
 * The mutation exists now, and the interesting half is what it does rather than
 * that it is there: the page saves in three pieces and the schema stores
 * `branding` as one untyped blob, so a mutation that assigned its argument
 * would have made saving the typography erase the colours. That is the case
 * these tests are mostly about.
 *
 * Byte-identical with `apps/themes/tests/convex/store-branding.test.ts` —
 * `pnpm check:divergence` requires it.
 */

import { convexTest } from "convex-test"
import { afterEach, describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

/** What the "Couleurs" tab sends (design-page.tsx). */
const COLOURS = {
  primaryColor: "#FF6B00",
  secondaryColor: "#FFF3E0",
  accentColor: "#FF9800",
}

/** What the "Typographie" tab sends. */
const TYPOGRAPHY = { fontHeading: "Playfair Display", fontBody: "Inter" }

/** What the "Logo" tab sends. */
const LOGO = {
  logoUrl: "https://cdn.example.test/logo.png",
  faviconUrl: "https://cdn.example.test/favicon.png",
}

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Cancel whatever the test left on the scheduler.
 *
 * Store mutations queue work through `ctx.scheduler.runAfter`. A test finishes
 * in milliseconds and leaves those pending; whatever fires them next writes
 * against a transaction that closed, and because nothing awaits it that arrives
 * as an unhandled rejection — a run where every test is green and the process
 * still exits 1, blaming whichever file happened to be running. Same guard as
 * `kitchen-sound-config.test.ts`.
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

async function seedStore(t: ReturnType<typeof convexTest>, slug = "pizzeria-napoli") {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name: "Pizzeria Napoli",
      slug,
      address: {
        street: "12 rue Oberkampf",
        city: "Paris",
        postalCode: "75011",
        country: "France",
      },
      hours: [],
      status: "open" as const,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
}

async function seedStaff(
  t: ReturnType<typeof convexTest>,
  role: "client_admin" | "manager",
  storeIds: Id<"stores">[],
  subject = `user:${role}`
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
      storeIds,
      permissions: [],
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

/**
 * The establishment's stored branding, or `null` when it has none.
 *
 * `null` rather than `undefined` on purpose: `t.run` returns through the Convex
 * value encoding, which has no `undefined` — an absent `branding` comes back as
 * `null` however the callback spells it.
 */
const brandingOf = (t: ReturnType<typeof convexTest>, id: Id<"stores">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.branding ?? null)

// ============================================================================

describe("stores.updateBranding merges rather than replaces", () => {
  test("the three tabs each keep what the other two saved", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })
    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: TYPOGRAPHY })
    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: LOGO })

    // Every field design-page.tsx reads back on mount.
    expect(await brandingOf(t, storeId)).toEqual({ ...COLOURS, ...TYPOGRAPHY, ...LOGO })
  })

  test("saving the typography does not clear the colours", async () => {
    // The failure the merge exists to prevent, stated on its own so a
    // regression names itself rather than arriving as a seven-field diff.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })
    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: TYPOGRAPHY })

    expect(await brandingOf(t, storeId)).toMatchObject(COLOURS)
  })

  test("saving the colours does not clear the typography", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: TYPOGRAPHY })
    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })

    expect(await brandingOf(t, storeId)).toMatchObject(TYPOGRAPHY)
  })

  test("overwrites the field it names, rather than merging its value", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })
    await asOwner.mutation(api.stores.updateBranding, {
      id: storeId,
      branding: { primaryColor: "#1B5E20" },
    })

    const branding = await brandingOf(t, storeId)
    expect(branding?.primaryColor).toBe("#1B5E20")
    expect(branding?.accentColor).toBe(COLOURS.accentColor)
  })

  test("an emptied field is cleared, not preserved", async () => {
    // `<input>` gives back `""` for a box the owner cleared, and the Logo tab
    // sends it as written. Treating `""` as "no change" would leave the old
    // logo in place and report success — a fourth button that does nothing.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: LOGO })
    await asOwner.mutation(api.stores.updateBranding, {
      id: storeId,
      branding: { logoUrl: "", faviconUrl: LOGO.faviconUrl },
    })

    const branding = await brandingOf(t, storeId)
    expect(branding?.logoUrl).toBeUndefined()
    expect(branding?.faviconUrl).toBe(LOGO.faviconUrl)
  })

  test("carries through a key it does not name", async () => {
    // `branding` is a legacy `v.any()` blob; a deployment may hold something
    // this validator has never heard of. Dropping it on a colour save would be
    // silent data loss.
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.run((ctx) => ctx.db.patch(storeId, { branding: { legacyTheme: "pizzeria" } }))
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })

    expect(await brandingOf(t, storeId)).toEqual({ legacyTheme: "pizzeria", ...COLOURS })
  })

  test("writes to a store that has no branding at all", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })

    expect(await brandingOf(t, storeId)).toEqual(COLOURS)
  })
})

describe("stores.updateBranding is gated like the settings mutation it is", () => {
  test("a manager, who may read the store but not write it, is refused", async () => {
    // `manager` holds `stores:read` and reaches the Design screen; the save
    // buttons are the part their role does not cover.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asManager = await seedStaff(t, "manager", [storeId])

    await expect(
      asManager.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })
    ).rejects.toThrow(/lacks permission stores:write/)

    expect(await brandingOf(t, storeId)).toBeNull()
  })

  test("an owner cannot brand an establishment that is not theirs", async () => {
    const t = newHarness()
    const mine = await seedStore(t, "chez-moi")
    const theirs = await seedStore(t, "chez-eux")
    const asOwnerOfMine = await seedStaff(t, "client_admin", [mine])

    await expect(
      asOwnerOfMine.mutation(api.stores.updateBranding, { id: theirs, branding: COLOURS })
    ).rejects.toThrow(/n'avez pas accès à cet établissement/)

    expect(await brandingOf(t, theirs)).toBeNull()
  })

  test("an anonymous caller is refused", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)

    await expect(
      t.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })
    ).rejects.toThrow(/Not authenticated/)
  })
})

describe("stores.updateBranding refuses input the Design screen could not send", () => {
  test("a field the validator does not name", async () => {
    // The whole reason this defect lived so long is that nothing declared a
    // shape. `v.object` is that declaration, and it is enforced at the door.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await expect(
      asOwner.mutation(api.stores.updateBranding, {
        id: storeId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        branding: { primaryColour: "#FF6B00" } as any,
      })
    ).rejects.toThrow(/Unexpected field `primaryColour`/)
  })

  test("a protocol-relative logo URL", async () => {
    // `//evil.example/x.png` is not a root-relative path: a browser resolves it
    // against the current scheme and fetches it from that host. The check was
    // `^/`, which accepted it — a third party's image on every page of the
    // storefront and in the favicon, chosen by anyone who can write branding.
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    for (const logoUrl of ["//evil.example/x.png", "///evil.example/x.png"]) {
      await expect(
        asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: { logoUrl } }),
        logoUrl
      ).rejects.toThrow(/http\(s\) or root-relative URL/)
    }

    expect(await brandingOf(t, storeId)).toBeNull()

    // The genuine root-relative path still lands.
    await asOwner.mutation(api.stores.updateBranding, {
      id: storeId,
      branding: { logoUrl: "/logo.png" },
    })
    expect(await brandingOf(t, storeId)).toEqual({ logoUrl: "/logo.png" })
  })

  test("a logo URL with a scheme an <img> should not be given", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await expect(
      asOwner.mutation(api.stores.updateBranding, {
        id: storeId,
        branding: { logoUrl: "javascript:alert(1)" },
      })
    ).rejects.toThrow(/http\(s\) or root-relative URL/)

    expect(await brandingOf(t, storeId)).toBeNull()
  })

  test("a value longer than the field is meant to hold", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await expect(
      asOwner.mutation(api.stores.updateBranding, {
        id: storeId,
        branding: { fontHeading: "x".repeat(513) },
      })
    ).rejects.toThrow(/exceeds 512 characters/)
  })

  test("but accepts a root-relative logo, which is how an S3-backed asset arrives", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, {
      id: storeId,
      branding: { logoUrl: "/uploads/branding/logo.png" },
    })

    expect((await brandingOf(t, storeId))?.logoUrl).toBe("/uploads/branding/logo.png")
  })

  test("refuses an establishment that does not exist", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await t.run((ctx) => ctx.db.delete(storeId))

    await expect(
      asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })
    ).rejects.toThrow(/Store not found/)
  })
})

describe("stores.updateBranding leaves the same trail every store mutation does", () => {
  test("records the operation and what the branding became", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const asOwner = await seedStaff(t, "client_admin", [storeId])

    await asOwner.mutation(api.stores.updateBranding, { id: storeId, branding: COLOURS })

    const entries = await t.run((ctx) => ctx.db.query("systemAuditLog").collect())
    const entry = entries.find((e) => e.details?.includes("updateBranding"))
    expect(entry).toBeDefined()
    expect(entry?.action).toBe("store_updated")
    expect(entry?.targetStoreId).toBe(storeId)
    // The merged result, not the argument: the entry should say what the
    // establishment's branding IS, which is the point of merging at all.
    expect(JSON.parse(entry!.details!).changes.branding.after).toEqual(COLOURS)
  })
})
