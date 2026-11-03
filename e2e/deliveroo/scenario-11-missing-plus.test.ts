// @vitest-environment edge-runtime

/**
 * ┌──────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Scenario 11: Missing PLUs          │
 * └──────────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo's certification scenario 11: an order whose items carry a
 * `pos_item_id` (PLU) we do not recognise, or none at all. Two things have to
 * happen and this file drives both through the real Convex route:
 *
 *  - the order is still taken and still reaches the kitchen, identified by
 *    name, because refusing food a customer has paid for is worse than
 *    printing a line the POS cannot match;
 *  - the sync status reported back to Deliveroo says so — `failed` with
 *    `pos_item_id_not_found` when a line has no identifier, and
 *    `pos_item_id_mismatched` when it has one that matches no product here.
 *
 * The second half is the point of the scenario and no test had ever run it.
 * The nine blocks replaced here built a payload with an "UNKNOWN-PLU-123"
 * item and then asserted `item.pos_item_id === "UNKNOWN-PLU-123"`.
 *
 * PLU = Price Look-Up code, the product identifier in the POS.
 *
 * @reference https://api-docs.deliveroo.com/docs/order-integration
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  apiCallsExcludingAuth,
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postSigned,
  readKitchenTickets,
  readOrders,
  seedStoreWithDeliveroo,
  withDeliverooApi,
  NOW,
} from "./convex-harness";
import {
  createNewOrderWebhook,
  createStatusUpdateWebhook,
  generateOrderId,
} from "./test-config";

// The sync status is reported over the API, so this suite needs credentials
// and records what the product sent instead of letting it reach the sandbox.
beforeAll(() => configureDeliverooEnv({ withApiCredentials: true }));
afterEach(cancelPendingScheduledJobs);

/** A line whose PLU is not in our catalogue, plus one that is. */
const MIXED_ITEMS = [
  {
    pos_item_id: "UNKNOWN-PLU-123",
    quantity: 1,
    name: "Burger mystère",
    unit_price: { fractional: 1500, currency_code: "EUR" },
    total_price: { fractional: 1500, currency_code: "EUR" },
    modifiers: [
      {
        pos_item_id: "UNKNOWN-MODIFIER",
        quantity: 1,
        name: "Sauce du chef",
        unit_price: { fractional: 100, currency_code: "EUR" },
      },
    ],
  },
  {
    pos_item_id: "ITEM-VALID-001",
    quantity: 2,
    name: "Frites maison",
    unit_price: { fractional: 500, currency_code: "EUR" },
    total_price: { fractional: 1000, currency_code: "EUR" },
  },
];

function orderWithItems(id: string, items: Array<Record<string, unknown>>) {
  return JSON.stringify(
    createNewOrderWebhook({
      id,
      total_price: { fractional: 2600, currency_code: "EUR" },
      partner_order_total: { fractional: 2600, currency_code: "EUR" },
      items,
    }),
  );
}

describe("Scenario 11: an order whose PLUs we do not know", () => {
  it("is accepted and reaches the kitchen anyway", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    const response = await postSigned(
      t,
      orderWithItems(generateOrderId("missing-plu"), MIXED_ITEMS),
    );
    expect(response.status).toBe(200);

    expect(await readOrders(t)).toHaveLength(1);
    expect(await readKitchenTickets(t)).toHaveLength(1);
  });

  it("falls back to the item name, so the kitchen knows what to make", async () => {
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, orderWithItems(generateOrderId("fallback"), MIXED_ITEMS));

    const [ticket] = await readKitchenTickets(t);
    expect(ticket!.items.map((i) => i.productName)).toEqual([
      "Burger mystère",
      "Frites maison",
    ]);
    expect(ticket!.items[1]!.quantity).toBe(2);
    // A modifier we cannot match is still something the cook has to add.
    expect(ticket!.items[0]!.options).toContain("Sauce du chef");
  });

  it("keeps the unrecognised PLU on the line, so it can be mapped later", async () => {
    // Thrown away, an unmatched PLU cannot be turned into a product mapping
    // afterwards — the only record of what Deliveroo called it is gone.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);

    await postSigned(t, orderWithItems(generateOrderId("keep-plu"), MIXED_ITEMS));

    const [order] = await readOrders(t);
    expect(order!.items[0]!.externalId).toBe("UNKNOWN-PLU-123");
  });

  it("warns, by name, about the PLU it could not match", async () => {
    // The warning is the only signal a menu sync has drifted. It is asserted
    // on the real `console.warn` the handler emits, not on a comment claiming
    // it should log something.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = newHarness();
      await seedStoreWithDeliveroo(t);

      await postSigned(t, orderWithItems(generateOrderId("warn"), MIXED_ITEMS));

      const messages = warn.mock.calls.map((args) => args.join(" "));
      expect(messages.some((m) => m.includes("UNKNOWN-PLU-123"))).toBe(true);
      expect(messages.some((m) => m.includes("Burger mystère"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports sync failed with pos_item_id_not_found when a line has no PLU", async () => {
    // Deliveroo's contract for this scenario: acknowledge the order, then say
    // the POS could not identify it. Sent on acceptance, like every sync
    // status, and asserted on the request the product made.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("no-plu");
    const noPluItems = [
      {
        quantity: 1,
        name: "Plat sans référence",
        unit_price: { fractional: 2500, currency_code: "EUR" },
        total_price: { fractional: 2500, currency_code: "EUR" },
      },
    ];

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, orderWithItems(orderId, noPluItems));
      // A status update carries the items again; the handler otherwise fetches
      // them from the API before deciding.
      await postSigned(
        t,
        JSON.stringify(createStatusUpdateWebhook(orderId, "accepted", { items: noPluItems })),
      );
      return apiCallsExcludingAuth(recorded);
    });

    const sync = calls.find((c) => c.url.includes("sync_status"));
    expect(sync, "nothing was reported back to Deliveroo").toBeDefined();
    expect(JSON.parse(sync!.body ?? "{}")).toMatchObject({
      status: "failed",
      reason: "pos_item_id_not_found",
    });
  });

  it("reports sync failed with pos_item_id_mismatched for a PLU we cannot resolve", async () => {
    // A PLU that is present but matches no `externalProductMappings` row is a
    // different failure from one that is absent, and Deliveroo distinguishes
    // them: this is the menu having drifted, not the payload being thin.
    const t = newHarness();
    await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("mismatch");

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, orderWithItems(orderId, MIXED_ITEMS));
      await postSigned(
        t,
        JSON.stringify(createStatusUpdateWebhook(orderId, "accepted", { items: MIXED_ITEMS })),
      );
      return apiCallsExcludingAuth(recorded);
    });

    const sync = calls.find((c) => c.url.includes("sync_status"));
    expect(sync).toBeDefined();
    expect(JSON.parse(sync!.body ?? "{}")).toMatchObject({
      status: "failed",
      reason: "pos_item_id_mismatched",
    });
  });

  it("reports sync succeeded once every PLU maps to a product", async () => {
    // The other side of the same check, so the two failures above cannot be
    // the only answer the code is capable of giving.
    const t = newHarness();
    const storeId = await seedStoreWithDeliveroo(t);
    const orderId = generateOrderId("known-plu");
    const knownItems = [
      {
        pos_item_id: "ITEM-VALID-001",
        quantity: 1,
        name: "Frites maison",
        unit_price: { fractional: 500, currency_code: "EUR" },
        total_price: { fractional: 500, currency_code: "EUR" },
      },
    ];

    await t.run(async (ctx) => {
      const categoryId = await ctx.db.insert("categories", {
        storeId,
        name: "Accompagnements",
        slug: "accompagnements",
        sortOrder: 1,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const productId = await ctx.db.insert("products", {
        storeId,
        categoryId,
        name: "Frites maison",
        slug: "frites-maison",
        price: 500,
        taxRate: 10,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 1,
        source: "manual",
        externalIds: { deliverooId: "ITEM-VALID-001" },
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("externalProductMappings", {
        storeId,
        platform: "deliveroo" as const,
        internalProductId: productId,
        externalId: "ITEM-VALID-001",
        lastSyncAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, orderWithItems(orderId, knownItems));
      await postSigned(
        t,
        JSON.stringify(createStatusUpdateWebhook(orderId, "accepted", { items: knownItems })),
      );
      return apiCallsExcludingAuth(recorded);
    });

    const sync = calls.find((c) => c.url.includes("sync_status"));
    expect(sync).toBeDefined();
    expect(JSON.parse(sync!.body ?? "{}")).toMatchObject({ status: "succeeded" });
  });
});

/**
 * Scenario 12: mismatched PLUs.
 *
 * Deliveroo sends an order whose lines carry each other's PLU: « Veggie Burger »
 * under the Chicken Burger's PLU and the reverse. Both PLUs EXIST in our
 * catalogue, so a check that only asks « is this PLU known? » answers
 * `succeeded` and the order prints the wrong dish. Deliveroo's portal marked the
 * run « Error: the sync_status call was expected to contain a fail reason ».
 */
describe("Scenario 12: PLUs that exist but sit on the wrong dish", () => {
  async function burgerMenu(t: ReturnType<typeof newHarness>) {
    const storeId = await seedStoreWithDeliveroo(t);
    await t.run(async (ctx) => {
      const categoryId = await ctx.db.insert("categories", {
        storeId,
        name: "Burgers",
        slug: "burgers",
        sortOrder: 1,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      for (const [slug, name, plu, price] of [
        ["chicken-burger", "Chicken Burger", "MU11001", 900],
        ["veggie-burger", "Veggie Burger (V)", "MU11002", 800],
      ] as const) {
        const productId = await ctx.db.insert("products", {
          storeId,
          categoryId,
          name,
          slug,
          price,
          taxRate: 10,
          images: [],
          options: [],
          allergens: [],
          tags: [],
          isActive: true,
          isFeatured: false,
          sortOrder: 1,
          source: "manual",
          createdAt: NOW,
          updatedAt: NOW,
        });
        await ctx.db.insert("externalProductMappings", {
          storeId,
          platform: "deliveroo" as const,
          internalProductId: productId,
          externalId: plu,
          externalName: name,
          externalPrice: price,
          lastSyncAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    return storeId;
  }

  const line = (plu: string, name: string, cents: number) => ({
    pos_item_id: plu,
    quantity: 1,
    name,
    unit_price: { fractional: cents, currency_code: "EUR" },
    total_price: { fractional: cents, currency_code: "EUR" },
  });

  async function syncFor(items: ReturnType<typeof line>[]) {
    const t = newHarness();
    await burgerMenu(t);
    const orderId = generateOrderId("scenario-12");
    const calls = await withDeliverooApi(async (recorded) => {
      await postSigned(t, orderWithItems(orderId, items));
      await postSigned(
        t,
        JSON.stringify(createStatusUpdateWebhook(orderId, "accepted", { items })),
      );
      return apiCallsExcludingAuth(recorded);
    });
    const sync = calls.find((c) => c.url.includes("sync_status"));
    expect(sync, "nothing was reported back to Deliveroo").toBeDefined();
    return JSON.parse(sync!.body ?? "{}");
  }

  it("fails the sync when two dishes carry each other's PLU", async () => {
    const body = await syncFor([
      line("MU11001", "Veggie Burger (V)", 800),
      line("MU11002", "Chicken Burger", 900),
    ]);
    expect(body).toMatchObject({ status: "failed", reason: "pos_item_id_mismatched" });
  });

  it("fails the sync when a single line carries another dish's PLU", async () => {
    const body = await syncFor([
      line("MU11001", "Chicken Burger", 900),
      line("MU11001", "Veggie Burger (V)", 800),
    ]);
    expect(body).toMatchObject({ status: "failed", reason: "pos_item_id_mismatched" });
  });

  it("succeeds when every PLU sits on its own dish", async () => {
    const body = await syncFor([
      line("MU11001", "Chicken Burger", 900),
      line("MU11002", "Veggie Burger (V)", 800),
    ]);
    expect(body).toMatchObject({ status: "succeeded" });
  });

  it("ignores case, accents and spacing in the dish name", async () => {
    const body = await syncFor([
      line("MU11001", "  chicken   BURGER ", 900),
      line("MU11002", "VEGGIE burger (v)", 800),
    ]);
    expect(body).toMatchObject({ status: "succeeded" });
  });

  it("does not refuse a dish renamed since the menu was pushed", async () => {
    // A name we have never seen proves nothing about the PLU. Failing the sync
    // on it would turn every rename into a refused order.
    const body = await syncFor([
      line("MU11001", "Poulet croustillant (nouveau nom)", 900),
      line("MU11002", "Veggie Burger (V)", 800),
    ]);
    expect(body).toMatchObject({ status: "succeeded" });
  });
});
