// @vitest-environment edge-runtime
/**
 * ┌──────────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Prep Stages & Menu Upload      │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * @description
 * Three contracts the earlier scenarios did not reach, each one a defect that
 * shipped:
 *
 *  - PREP STAGES. The kitchen screen told Deliveroo « ready » with
 *    `POST /v1/orders/{id}/prep_stages { stage: "ready" }`. The path is
 *    `prep_stage` (singular) and the stage is `ready_for_collection`, so every
 *    press failed, was caught, and left Deliveroo not knowing the food was
 *    ready. `in_kitchen` and `collected` were never sent at all.
 *
 *  - MENU UPLOAD IS ASYNCHRONOUS. `PUT .../menus/{id}` returns before the menu
 *    is live. The sync used to write « success » on the spot, hiding a menu
 *    Deliveroo went on to reject. It now stays `syncing` until
 *    `menu.upload_result` arrives, except for `MATCH_EXISTING_MENU`, which is
 *    answered at once because nothing is processing.
 *
 *  - EVENT NAMES. Deliveroo's docs spell the order event `order.new` in the
 *    callback reference and `orders.new` in the index. A plural event used to
 *    fall into the « unhandled » branch with a 200: a paid order, acknowledged
 *    and never created.
 *
 * Every Deliveroo call is recorded rather than made (`withDeliverooApi`), so
 * what is asserted is the URL, the method and the body the product sent.
 *
 * @reference https://api-docs.deliveroo.com/docs/prep-stages-endpoint
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  NOW,
  apiCallsExcludingAuth,
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postSigned,
  readIntegrations,
  readKitchenTickets,
  readOrders,
  readScheduledJobs,
  seedStore,
  seedDeliverooIntegration,
  seedStoreWithDeliveroo,
  withDeliverooApi,
} from './convex-harness'
import { config, createNewOrderWebhook, generateOrderId } from './test-config'

beforeAll(() => configureDeliverooEnv({ withApiCredentials: true }))
afterEach(cancelPendingScheduledJobs)

type Harness = ReturnType<typeof newHarness>

/** A kitchen account that may work the pass of this store. */
async function cookFor(t: Harness, storeId: Id<'stores'>) {
  await t.run((ctx) =>
    ctx.db.insert('userProfiles', {
      userId: 'user:cook',
      role: 'client_admin' as const,
      storeIds: [storeId],
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  return t.withIdentity({ subject: 'user:cook' })
}

/** An order that reached the pass: placed by Deliveroo, ticket on the display. */
async function orderOnThePass(t: Harness) {
  const storeId = await seedStoreWithDeliveroo(t)
  const orderId = generateOrderId('stages')
  const response = await postSigned(t, JSON.stringify(createNewOrderWebhook({ id: orderId })))
  expect(response.status).toBe(200)
  const [ticket] = await readKitchenTickets(t)
  const asCook = await cookFor(t, storeId)
  return { orderId, ticketId: ticket!._id, asCook }
}

const stageCalls = (calls: Array<{ url: string; method: string; body?: string }>) =>
  apiCallsExcludingAuth(calls).filter((c) => c.url.includes('/prep_stage'))

describe('Prep stages from the kitchen screen', () => {
  it('tells Deliveroo cooking started when the kitchen takes the ticket', async () => {
    const t = newHarness()
    const { orderId, ticketId, asCook } = await orderOnThePass(t)

    const calls = await withDeliverooApi(async (recorded) => {
      await asCook.action(api.kitchenTickets.acceptTicket, { id: ticketId })
      return apiCallsExcludingAuth(recorded)
    })

    const accept = calls.find((c) => c.method === 'PATCH')
    expect(accept?.url).toContain(encodeURIComponent(orderId))
    expect(JSON.parse(accept!.body ?? '{}')).toEqual({ status: 'accepted' })

    const stage = calls.find((c) => c.url.includes('/prep_stage'))
    expect(stage, 'no prep stage was sent').toBeDefined()
    expect(stage!.method).toBe('POST')
    expect(stage!.url).toContain(`/v1/orders/${encodeURIComponent(orderId)}/prep_stage`)
    expect(JSON.parse(stage!.body ?? '{}').stage).toBe('in_kitchen')
  })

  it('still sends in_kitchen when Deliveroo says the order is already accepted', async () => {
    // Deliveroo's sandbox accepts a tabletless order by itself, so our accept is
    // answered 409 « already in status accepted ». That used to abort the whole
    // handler and the cooking-started stage was never sent.
    const t = newHarness()
    const { orderId, ticketId, asCook } = await orderOnThePass(t)

    const calls = await withDeliverooApi(
      async (recorded) => {
        await asCook.action(api.kitchenTickets.acceptTicket, { id: ticketId })
        return apiCallsExcludingAuth(recorded)
      },
      (call) =>
        call.method === 'PATCH'
          ? new Response(JSON.stringify({ error: { code: 'invalid_status_transition' } }), {
              status: 409,
            })
          : new Response('{}', { status: 200 }),
    )

    const stage = calls.find((c) => c.url.includes('/prep_stage'))
    expect(stage, 'in_kitchen was never sent').toBeDefined()
    expect(stage!.url).toContain(encodeURIComponent(orderId))
    expect(JSON.parse(stage!.body ?? '{}').stage).toBe('in_kitchen')
  })

  it('tells Deliveroo the food is ready with the documented stage and path', async () => {
    const t = newHarness()
    const { orderId, ticketId, asCook } = await orderOnThePass(t)

    const calls = await withDeliverooApi(async (recorded) => {
      await asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })
      return stageCalls(recorded)
    })

    // « soon » first, then ready: Deliveroo's scenario 13 asks for every stage.
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.method).toBe('POST')
      // Singular. `/prep_stages` is not a Deliveroo endpoint.
      expect(call.url).toContain(`/v1/orders/${encodeURIComponent(orderId)}/prep_stage`)
      expect(call.url).not.toContain('prep_stages')
    }
    const bodies = calls.map((c) => JSON.parse(c.body ?? '{}'))
    expect(bodies.map((b) => b.stage)).toEqual([
      'ready_for_collection_soon',
      'ready_for_collection',
    ])
    expect(new Date(bodies[1].occurred_at).toISOString()).toBe(bodies[1].occurred_at)
  })

  it("walks all four stages, in Deliveroo's order, across accept, ready and hand-over", async () => {
    // Scenario 13: « send a prep stage update for each of the four stages ».
    const t = newHarness()
    const { ticketId, asCook } = await orderOnThePass(t)

    const calls = await withDeliverooApi(async (recorded) => {
      await asCook.action(api.kitchenTickets.acceptTicket, { id: ticketId })
      await asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })
      await asCook.action(api.kitchenTickets.completeTicket, { id: ticketId })
      return stageCalls(recorded)
    })

    expect(calls.map((c) => JSON.parse(c.body ?? '{}').stage)).toEqual([
      'in_kitchen',
      'ready_for_collection_soon',
      'ready_for_collection',
      'collected',
    ])
  })

  it('tells Deliveroo the order was collected once it leaves the pass', async () => {
    const t = newHarness()
    const { ticketId, asCook } = await orderOnThePass(t)

    const calls = await withDeliverooApi(async (recorded) => {
      await asCook.action(api.kitchenTickets.completeTicket, { id: ticketId })
      return stageCalls(recorded)
    })

    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.body ?? '{}').stage).toBe('collected')
  })

  it('still marks the ticket ready when Deliveroo refuses the stage', async () => {
    // The food is ready whether or not Deliveroo hears about it; a failed call
    // must not turn the pass into an error.
    const t = newHarness()
    const { ticketId, asCook } = await orderOnThePass(t)

    await withDeliverooApi(
      async () => {
        await asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })
      },
      (call) =>
        call.url.includes('/prep_stage')
          ? new Response('boom', { status: 500 })
          : new Response('{}', { status: 200 }),
    )

    const [ticket] = await readKitchenTickets(t)
    expect(ticket!.status).toBe('ready')
  })

  it('refuses a pre-accept order with a reason Deliveroo knows', async () => {
    const t = newHarness()
    const { orderId, ticketId, asCook } = await orderOnThePass(t)

    const calls = await withDeliverooApi(async (recorded) => {
      await asCook.action(api.kitchenTickets.cancelTicket, { id: ticketId })
      return apiCallsExcludingAuth(recorded)
    })

    const reject = calls.find((c) => c.method === 'PATCH')
    expect(reject?.url).toContain(encodeURIComponent(orderId))
    expect(JSON.parse(reject!.body ?? '{}')).toEqual({ status: 'rejected', reject_reason: 'busy' })
  })

  it("sends a kitchen reason outside Deliveroo's list as other, keeping the words", async () => {
    const t = newHarness()
    const { ticketId, asCook } = await orderOnThePass(t)

    const calls = await withDeliverooApi(async (recorded) => {
      await asCook.action(api.kitchenTickets.cancelTicket, { id: ticketId, reason: 'oven broke' })
      return apiCallsExcludingAuth(recorded)
    })

    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')!.body ?? '{}')).toEqual({
      status: 'rejected',
      reject_reason: 'other',
      notes: 'oven broke',
    })
  })
})

describe('Menu upload is asynchronous', () => {
  async function menuStore(t: Harness) {
    const storeId = await seedStore(t)
    await seedDeliverooIntegration(t, storeId, { brandId: 'brand-under-test' })
    await t.run(async (ctx) => {
      const [integration] = await ctx.db.query('storeIntegrations').collect()
      await ctx.db.patch(integration!._id, { syncMenu: true })
    })
    return storeId
  }

  const sync = (t: Harness, storeId: Id<'stores'>) =>
    t.action(internal.deliverooMenuSync.internalSyncStore, { storeId })

  it('stays syncing after the upload is accepted, until the result arrives', async () => {
    const t = newHarness()
    const storeId = await menuStore(t)

    const calls = await withDeliverooApi(async (recorded) => {
      const result = await sync(t, storeId)
      expect(result).toMatchObject({ success: true, pending: true })
      return apiCallsExcludingAuth(recorded)
    })

    const [integration] = await readIntegrations(t)
    expect(integration!.menuSyncStatus).toBe('syncing')
    // One PUT, and no availability call yet: Deliveroo asks for the result first.
    expect(calls.map((c) => c.method)).toEqual(['PUT'])
    expect(calls[0]!.url).toContain('/v1/brands/brand-under-test/menus/menu-')
  })

  it('finishes at once when Deliveroo answers MATCH_EXISTING_MENU', async () => {
    const t = newHarness()
    const storeId = await menuStore(t)

    await withDeliverooApi(
      async () => {
        const result = await sync(t, storeId)
        expect(result).toEqual({ success: true })
      },
      () => new Response(JSON.stringify({ result: 'MATCH_EXISTING_MENU' }), { status: 200 }),
    )

    const [integration] = await readIntegrations(t)
    expect(integration!.menuSyncStatus).toBe('success')
  })

  it('records a rejected upload instead of reporting success', async () => {
    const t = newHarness()
    const storeId = await menuStore(t)

    const result = await withDeliverooApi(
      () => sync(t, storeId),
      () => new Response('invalid menu', { status: 400 }),
    )

    expect(result).toMatchObject({ success: false })
    const [integration] = await readIntegrations(t)
    expect(integration!.menuSyncStatus).toBe('error')
  })

  it('books the availability push when the upload result is a success', async () => {
    const t = newHarness()
    const storeId = await menuStore(t)
    await t.run(async (ctx) => {
      const [integration] = await ctx.db.query('storeIntegrations').collect()
      await ctx.db.patch(integration!._id, { menuSyncStatus: 'syncing' })
    })

    const response = await postSigned(
      t,
      JSON.stringify({
        event: 'menu.upload_result',
        body: {
          menu_upload_result: {
            http_status: 200,
            brand_id: 'brand-under-test',
            menu_id: 'menu-x',
            site_ids: [config.SITE_ID],
            errors: {},
          },
        },
      }),
      config.MENU_WEBHOOK_PATH,
    )
    expect(response.status).toBe(200)

    const [integration] = await readIntegrations(t)
    expect(integration!.menuSyncStatus).toBe('success')
    const jobs = await readScheduledJobs(t)
    expect(jobs.map((j) => j.name)).toContain('deliverooMenuSync:internalPushAvailability')
    expect(storeId).toBeDefined()
  })

  it('books no availability push when the upload failed', async () => {
    const t = newHarness()
    await menuStore(t)

    await postSigned(
      t,
      JSON.stringify({
        event: 'menu.upload_result',
        body: {
          menu_upload_result: {
            http_status: 200,
            brand_id: 'brand-under-test',
            menu_id: 'menu-x',
            site_ids: [config.SITE_ID],
            errors: { processing: 'duplicate item id' },
          },
        },
      }),
      config.MENU_WEBHOOK_PATH,
    )

    const [integration] = await readIntegrations(t)
    expect(integration!.menuSyncStatus).toBe('error')
    expect(await readScheduledJobs(t)).toHaveLength(0)
  })
})

describe('The plural order event', () => {
  it("creates the order for orders.new, the spelling in Deliveroo's index", async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = generateOrderId('plural')

    const payload = { ...createNewOrderWebhook({ id: orderId }), event: 'orders.new' }
    const response = await postSigned(t, JSON.stringify(payload))
    expect(response.status).toBe(200)

    const orders = await readOrders(t)
    expect(orders, 'a paid order was acknowledged and never created').toHaveLength(1)
    expect(orders[0]!.externalOrderId).toBe(orderId)
  })

  it('applies orders.status_update to an existing order', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = generateOrderId('plural-status')
    await postSigned(t, JSON.stringify(createNewOrderWebhook({ id: orderId })))

    const response = await postSigned(
      t,
      JSON.stringify({
        event: 'orders.status_update',
        body: {
          order: {
            id: orderId,
            location_id: config.SITE_ID,
            status: 'canceled',
            status_log: [{ at: new Date().toISOString(), status: 'canceled' }],
          },
        },
      }),
    )
    expect(response.status).toBe(200)

    const [order] = await readOrders(t)
    expect(order!.status).toBe('cancelled')
  })
})

describe('The hourly availability reconcile', () => {
  // Deliveroo resets `unavailable` items to `available` when a site opens, so a
  // dish the kitchen had run out of was orderable again every morning until the
  // next menu upload. The reconcile re-asserts the stock state once an hour.

  async function trackedStore(t: Harness, options: { syncMenu?: boolean; enabled?: boolean } = {}) {
    const storeId = await seedStore(t)
    await seedDeliverooIntegration(t, storeId, {
      brandId: 'brand-under-test',
      enabled: options.enabled,
    })
    await t.run(async (ctx) => {
      const [integration] = await ctx.db.query('storeIntegrations').collect()
      await ctx.db.patch(integration!._id, { syncMenu: options.syncMenu ?? true })
      const categoryId = await ctx.db.insert('categories', {
        storeId,
        name: 'Burgers',
        slug: 'burgers',
        sortOrder: 1,
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW,
      })
      await ctx.db.insert('products', {
        storeId,
        categoryId,
        name: 'Chicken Burger',
        slug: 'chicken-burger',
        price: 900,
        taxRate: 10,
        images: [],
        options: [],
        allergens: [],
        tags: [],
        isActive: true,
        isFeatured: false,
        sortOrder: 1,
        source: 'manual',
        // Sold out, and tracked, so the reconcile has something to say.
        stock: { tracked: true, quantity: 0, lowStockThreshold: 0 },
        createdAt: NOW,
        updatedAt: NOW,
      })
    })
    return storeId
  }

  const pendingPushes = async (t: Harness) =>
    (await readScheduledJobs(t)).filter(
      (j) => j.state.kind === 'pending' && j.name === 'deliverooMenuSync:internalPushAvailability',
    )

  it('books one quiet push per store that syncs its menu', async () => {
    const t = newHarness()
    await trackedStore(t)

    const result = await t.action(internal.deliverooMenuSync.reconcileAvailability, {})

    expect(result).toEqual({ reconciled: 1 })
    const pushes = await pendingPushes(t)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.args[0]).toMatchObject({ quiet: true })
  })

  it('leaves out a store that does not sync its menu, and a disabled integration', async () => {
    const off = newHarness()
    await trackedStore(off, { syncMenu: false })
    expect(await off.action(internal.deliverooMenuSync.reconcileAvailability, {})).toEqual({
      reconciled: 0,
    })

    const disabled = newHarness()
    await trackedStore(disabled, { enabled: false })
    expect(await disabled.action(internal.deliverooMenuSync.reconcileAvailability, {})).toEqual({
      reconciled: 0,
    })
    expect(await pendingPushes(off)).toHaveLength(0)
    expect(await pendingPushes(disabled)).toHaveLength(0)
  })

  const setSyncStatus = (t: Harness, menuSyncStatus: 'syncing' | 'success', updatedAt: number) =>
    t.run(async (ctx) => {
      const [integration] = await ctx.db.query('storeIntegrations').collect()
      await ctx.db.patch(integration!._id, { menuSyncStatus, updatedAt })
    })

  it('waits for a menu upload that Deliveroo is still processing', async () => {
    const t = newHarness()
    await trackedStore(t)
    await setSyncStatus(t, 'syncing', Date.now() - 60_000)

    expect(await t.action(internal.deliverooMenuSync.reconcileAvailability, {})).toEqual({
      reconciled: 0,
    })
    expect(await pendingPushes(t)).toHaveLength(0)
  })

  it('stops waiting for an upload whose result never came', async () => {
    const t = newHarness()
    await trackedStore(t)
    await setSyncStatus(t, 'syncing', Date.now() - 2 * 60 * 60_000)

    expect(await t.action(internal.deliverooMenuSync.reconcileAvailability, {})).toEqual({
      reconciled: 1,
    })
  })

  it('pushes nothing for a job that ran after the menu sync was switched off', async () => {
    const t = newHarness()
    const storeId = await trackedStore(t, { syncMenu: false })

    const calls = await withDeliverooApi(async (recorded) => {
      await t.action(internal.deliverooMenuSync.internalPushAvailability, { storeId })
      return apiCallsExcludingAuth(recorded)
    })

    expect(calls).toHaveLength(0)
  })

  it('tells Deliveroo a sold-out tracked dish is unavailable', async () => {
    const t = newHarness()
    const storeId = await trackedStore(t)

    const calls = await withDeliverooApi(async (recorded) => {
      await t.action(internal.deliverooMenuSync.internalPushAvailability, { storeId, quiet: true })
      return apiCallsExcludingAuth(recorded)
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toContain('/v1/brands/brand-under-test/menus/menu-')
    expect(calls[0]!.url).toContain('/item_unavailabilities/')
    expect(JSON.parse(calls[0]!.body ?? '{}').item_unavailabilities).toEqual([
      expect.objectContaining({ status: 'unavailable' }),
    ])
  })

  it('does not mark a published menu as errored when an hourly push fails', async () => {
    const t = newHarness()
    const storeId = await trackedStore(t)
    await t.run(async (ctx) => {
      const [integration] = await ctx.db.query('storeIntegrations').collect()
      await ctx.db.patch(integration!._id, { menuSyncStatus: 'success' })
    })

    const result = await withDeliverooApi(
      () => t.action(internal.deliverooMenuSync.internalPushAvailability, { storeId, quiet: true }),
      () => new Response('boom', { status: 400 }),
    )

    expect(result).toMatchObject({ success: false })
    const [integration] = await readIntegrations(t)
    expect(integration!.menuSyncStatus).toBe('success')
  })

  it('still marks the menu errored when the push that follows an upload fails', async () => {
    // The two paths differ on purpose: after an upload, « published but not
    // sold out » is a state the owner has to hear about.
    const t = newHarness()
    const storeId = await trackedStore(t)

    await withDeliverooApi(
      () => t.action(internal.deliverooMenuSync.internalPushAvailability, { storeId }),
      () => new Response('boom', { status: 400 }),
    )

    const [integration] = await readIntegrations(t)
    expect(integration!.menuSyncStatus).toBe('error')
  })
})
