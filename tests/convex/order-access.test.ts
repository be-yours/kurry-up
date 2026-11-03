// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Who may read one order, asserted through the real `orders.getById`.
 *
 * WHY THIS FILE EXISTS. `getById` granted access on two questions — "do you
 * hold this order's view token" and "did you place this order" — and had no
 * branch for the people who cook it. A guest order carries no `customerId`:
 * checkout stores `session?.user?.id`, which is `undefined` without an account.
 * So both questions answered no to every member of staff, and
 * `/dashboard/orders/<id>` rendered "Commande introuvable" for the majority of
 * a restaurant's orders. Access was decided by "did you place this order",
 * never by "do you work here".
 *
 * The staff branch that fixes it is an authorisation change, so the interesting
 * assertions are the refusals. Three audiences share this one query — the
 * guest with a token, the signed-in customer, the administration — and each is
 * pinned below, in both directions.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const NOW = 1_700_000_000_000

type Role =
  | "super_admin"
  | "client_admin"
  | "manager"
  | "kitchen"
  | "waiter"
  | "delivery"
  | "customer"

/** A store record with only the fields the schema demands. */
async function seedStore(t: ReturnType<typeof convexTest>, name: string) {
  return t.run((ctx) =>
    ctx.db.insert("stores", {
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
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

/** A user whose profile grants `role` over `storeIds`. */
async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role,
  storeIds: Id<"stores">[],
  permissions: string[] = []
) {
  await t.run((ctx) =>
    ctx.db.insert("userProfiles", {
      userId: subject,
      role,
      storeIds,
      permissions,
      language: "fr",
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
  )
  return t.withIdentity({ subject })
}

/**
 * An order, guest by default.
 *
 * `customerId` is left off unless a test asks for it, because that is what
 * checkout writes for somebody who orders without an account — and it is the
 * exact shape the defect made unreadable.
 */
async function seedOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<"stores">,
  extra: { customerId?: string; viewToken?: string } = {}
) {
  return t.run((ctx) =>
    ctx.db.insert("orders", {
      storeId,
      orderNumber: "ORD-2026-872M0E",
      customerInfo: { name: "Camille" },
      type: "delivery" as const,
      status: "confirmed" as const,
      items: [
        {
          productName: "Margherita",
          quantity: 1,
          unitPrice: 1000,
          selectedOptions: [],
          subtotal: 1000,
        },
      ],
      subtotal: 1000,
      taxAmount: 100,
      total: 1100,
      paymentStatus: "paid" as const,
      source: "website" as const,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    })
  )
}

// ============================================================================
// The staff branch — the one that was missing
// ============================================================================

describe("the staff of a restaurant can read its orders", () => {
  test("the owner opens a guest order", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedUser(t, "user:owner", "client_admin", [storeId])
    const orderId = await seedOrder(t, storeId)

    // The premise: this order belongs to nobody's account.
    const stored = await t.run((ctx) => ctx.db.get(orderId))
    expect(stored?.customerId).toBeUndefined()

    const order = await asOwner.query(api.orders.getById, { id: orderId })
    expect(order?._id).toBe(orderId)
    expect(order?.orderNumber).toBe("ORD-2026-872M0E")
  })

  test.each(["client_admin", "manager", "kitchen", "waiter", "delivery"] as const)(
    "%s holds `orders:read` and opens a guest order",
    async (role) => {
      // Not the owner alone: the kitchen display and the rider's screen reach
      // the same order, and `orders:read` is what they hold in common.
      const t = convexTest(schema, modules)
      const storeId = await seedStore(t, "Chez Luigi")
      const asStaff = await seedUser(t, `user:${role}`, role, [storeId])
      const orderId = await seedOrder(t, storeId)

      const order = await asStaff.query(api.orders.getById, { id: orderId })
      expect(order?._id).toBe(orderId)
    }
  )

  test("what staff read is what `list` already gave them", async () => {
    // The branch widens the audience of nothing: `orders.list` is wrapped in
    // `storeQuery({ permission: "orders:read" })` and already returns these
    // documents whole, to these very people. Opening one adds ONLY the
    // computed invoice surface (#375) — the number-or-reason `getById`
    // derives for its reader, never a stored field `list` withholds. This
    // paid order sits on a deployment with no seller identity, so the
    // surface says exactly that.
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const asOwner = await seedUser(t, "user:owner", "client_admin", [storeId])
    const orderId = await seedOrder(t, storeId, { viewToken: "vt-secret" })

    const listing = await asOwner.query(api.orders.list, {
      storeId,
      paginationOpts: { numItems: 10, cursor: null },
    })
    const [listed] = listing.page
    const opened = await asOwner.query(api.orders.getById, { id: orderId })
    expect(opened).toEqual({
      ...listed,
      invoiceNumber: null,
      invoiceRefusal: "seller_incomplete",
    })
  })
})

// ============================================================================
// …and only its own orders
// ============================================================================

describe("the staff of one restaurant cannot read another's", () => {
  test("an owner is refused an order of a restaurant they do not administer", async () => {
    // THE assertion of this file. `client_admin` holds `orders:read`; what must
    // refuse them here is the store the order belongs to, and nothing else.
    const t = convexTest(schema, modules)
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const asOwner = await seedUser(t, "user:owner", "client_admin", [mine])
    const theirOrder = await seedOrder(t, theirs)

    expect(await asOwner.query(api.orders.getById, { id: theirOrder })).toBeNull()
  })

  test("a manager of one restaurant is refused the other's", async () => {
    const t = convexTest(schema, modules)
    const mine = await seedStore(t, "Chez Luigi")
    const theirs = await seedStore(t, "Chez Marco")
    const asManager = await seedUser(t, "user:m1", "manager", [mine])

    expect(
      await asManager.query(api.orders.getById, { id: await seedOrder(t, theirs) })
    ).toBeNull()
    // And the control: the same account, the same query, its own restaurant.
    const ours = await seedOrder(t, mine)
    expect((await asManager.query(api.orders.getById, { id: ours }))?._id).toBe(ours)
  })

  test("a super admin's remit is the whole chain", async () => {
    // Inherited from `requireStoreAccess`, deliberately: the staff branch adds
    // no rule of its own, it asks the chain every admin function asks.
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const asSuper = await seedUser(t, "user:root", "super_admin", [])
    const orderId = await seedOrder(t, storeId)

    expect((await asSuper.query(api.orders.getById, { id: orderId }))?._id).toBe(orderId)
  })
})

// ============================================================================
// Roles and modules that do NOT carry the right
// ============================================================================

describe("a signed-in account without the right reads nothing", () => {
  test("a customer attached to the store is refused someone else's order", async () => {
    // Being listed on a store is not working there: the `customer` role holds
    // `orders:view_own`, never `orders:read`.
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const asCustomer = await seedUser(t, "user:c1", "customer", [storeId])
    const orderId = await seedOrder(t, storeId)

    expect(await asCustomer.query(api.orders.getById, { id: orderId })).toBeNull()
  })

  test("a manager whose modules exclude orders is refused", async () => {
    // The invite dialog's checkboxes narrow what a role granted. The staff
    // branch runs through `requireStorePermission`, so it inherits that gate
    // rather than stepping around it.
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const asKitchenOnly = await seedUser(t, "user:m2", "manager", [storeId], ["kitchen"])
    const orderId = await seedOrder(t, storeId)

    expect(await asKitchenOnly.query(api.orders.getById, { id: orderId })).toBeNull()
  })

  test("a signed-in account with no profile at all is refused", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId)

    const asStranger = t.withIdentity({ subject: "user:nobody" })
    expect(await asStranger.query(api.orders.getById, { id: orderId })).toBeNull()
  })
})

// ============================================================================
// The two paths that already worked, and still must
// ============================================================================

describe("the guest's route to their own order still works", () => {
  test("the view token issued at checkout opens the order", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId, { viewToken: "vt-secret" })

    const order = await t.query(api.orders.getById, { id: orderId, viewToken: "vt-secret" })
    expect(order?._id).toBe(orderId)
  })

  test("a guessed view token opens nothing", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId, { viewToken: "vt-secret" })

    expect(
      await t.query(api.orders.getById, { id: orderId, viewToken: "vt-guessed" })
    ).toBeNull()
  })

  test("a token from one order does not open another", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    await seedOrder(t, storeId, { viewToken: "vt-mine" })
    const theirs = await seedOrder(t, storeId, { viewToken: "vt-theirs" })

    expect(await t.query(api.orders.getById, { id: theirs, viewToken: "vt-mine" })).toBeNull()
  })

  test("no token and no session opens nothing", async () => {
    // The floor the staff branch must not have lowered: an anonymous caller
    // holding only an order id gains nothing from it.
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const orderId = await seedOrder(t, storeId, { viewToken: "vt-secret" })

    expect(await t.query(api.orders.getById, { id: orderId })).toBeNull()
  })
})

describe("the customer's route to their own order still works", () => {
  test("the account that placed the order opens it, with no token", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const asCustomer = await seedUser(t, "user:c1", "customer", [])
    const orderId = await seedOrder(t, storeId, { customerId: "user:c1" })

    const order = await asCustomer.query(api.orders.getById, { id: orderId })
    expect(order?._id).toBe(orderId)
  })

  test("another customer's order stays shut", async () => {
    const t = convexTest(schema, modules)
    const storeId = await seedStore(t, "Chez Luigi")
    const asCustomer = await seedUser(t, "user:c1", "customer", [])
    const theirs = await seedOrder(t, storeId, { customerId: "user:c2" })

    expect(await asCustomer.query(api.orders.getById, { id: theirs })).toBeNull()
  })
})
