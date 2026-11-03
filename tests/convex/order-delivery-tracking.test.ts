// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The diner's live delivery: what Uber's webhooks record about the courier,
 * and who may read it back through `orders.getDeliveryTracking`.
 *
 * Two halves, both driven through the real functions.
 *
 * WHO. `getDeliveryTracking` answers under exactly the rule `orders.getById`
 * answers under — the view token, the account that placed the order, or that
 * restaurant's staff. The two keep separate copies of the branches (see
 * `mayReadOrder`), so this file asks both the same question in every case and
 * fails the moment they disagree.
 *
 * WHAT. The signed webhook body is untrusted input all the same: the courier's
 * name, phone, photo and position end up on a query the diner's app polls. The
 * route is exercised end to end with a real HMAC, and the order is read back.
 */

import { convexTest } from 'convex-test'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { _resetEnvCache } from '@be-yours/core/env'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

const NOW = 1_700_000_000_000
const SECRET = 'uber-direct-test-secret'
const DELIVERY = 'del_track_1'

beforeAll(() => {
  // The package env is parsed as a whole, so what it requires has to be there
  // or the route fails for the wrong reason.
  const saved = {
    openai: process.env.OPENAI_API_KEY,
    uber: process.env.UBER_DIRECT_WEBHOOK_SECRET,
  }
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.UBER_DIRECT_WEBHOOK_SECRET = SECRET
  _resetEnvCache()
  return () => {
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.openai
    if (saved.uber === undefined) delete process.env.UBER_DIRECT_WEBHOOK_SECRET
    else process.env.UBER_DIRECT_WEBHOOK_SECRET = saved.uber
    _resetEnvCache()
  }
})

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

afterEach(async () => {
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id)
      }
    })
  }
  harnesses.length = 0
})

type Role = 'client_admin' | 'manager' | 'kitchen' | 'customer'

async function seedStore(t: ReturnType<typeof convexTest>, name = 'Chez Suivi') {
  return t.run((ctx) =>
    ctx.db.insert('stores', {
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      address: {
        street: '1 rue de la Paix',
        city: 'Paris',
        postalCode: '75002',
        country: 'France',
        latitude: 48.8686,
        longitude: 2.3316,
      },
      phone: '+33142000000',
      hours: [],
      status: 'open' as const,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  subject: string,
  role: Role,
  storeIds: Id<'stores'>[],
) {
  await t.run((ctx) =>
    ctx.db.insert('userProfiles', {
      userId: subject,
      role,
      storeIds,
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  return t.withIdentity({ subject })
}

async function seedDeliveryOrder(
  t: ReturnType<typeof convexTest>,
  storeId: Id<'stores'>,
  extra: Record<string, unknown> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert('orders', {
      storeId,
      orderNumber: 'ORD-2026-00042',
      customerInfo: { name: 'Camille', email: 'camille@example.test', phone: '+33600000000' },
      type: 'delivery' as const,
      status: 'confirmed' as const,
      items: [
        {
          productName: 'Margherita',
          quantity: 1,
          unitPrice: 1000,
          selectedOptions: [],
          subtotal: 1000,
        },
      ],
      subtotal: 1000,
      taxAmount: 100,
      total: 1100,
      paymentStatus: 'paid' as const,
      source: 'website' as const,
      viewToken: 'vt-track',
      deliveryAddress: {
        street: '10 rue de Rivoli',
        city: 'Paris',
        postalCode: '75004',
        country: 'France',
        latitude: 48.8559,
        longitude: 2.3601,
      },
      uberDirectDeliveryId: DELIVERY,
      uberDirectStatus: 'SCHEDULED' as const,
      uberDirectStatusAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    }),
  )
}

// ============================================================================
// Who may read it — exactly who may read the order
// ============================================================================

describe('getDeliveryTracking answers exactly whom getById answers', () => {
  type Reader = {
    query: ReturnType<typeof convexTest>['query']
  }

  async function both(reader: Reader, id: Id<'orders'>, viewToken?: string) {
    const order = await reader.query(api.orders.getById, { id, viewToken })
    const tracking = await reader.query(api.orders.getDeliveryTracking, {
      orderId: id,
      viewToken,
    })
    return { order: order !== null, tracking: tracking !== null }
  }

  test.each([
    ['the view token issued at checkout', 'vt-track', true],
    ['a guessed view token', 'vt-guessed', false],
    ['no token and no session', undefined, false],
  ] as const)('anonymously, with %s', async (_label, viewToken, allowed) => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    expect(await both(t, orderId, viewToken)).toEqual({ order: allowed, tracking: allowed })
  })

  test('the account that placed the order, with no token', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t), { customerId: 'user:diner' })
    const diner = t.withIdentity({ subject: 'user:diner' })

    expect(await both(diner, orderId)).toEqual({ order: true, tracking: true })
  })

  test('another customer, even one attached to the store', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedDeliveryOrder(t, storeId, { customerId: 'user:diner' })
    const other = await seedUser(t, 'user:other', 'customer', [storeId])

    expect(await both(other, orderId)).toEqual({ order: false, tracking: false })
  })

  test.each(['client_admin', 'manager', 'kitchen'] as const)(
    '%s staff of this restaurant',
    async (role) => {
      const t = newHarness()
      const storeId = await seedStore(t)
      const orderId = await seedDeliveryOrder(t, storeId)
      const staff = await seedUser(t, `user:${role}`, role, [storeId])

      expect(await both(staff, orderId)).toEqual({ order: true, tracking: true })
    },
  )

  test('staff of ANOTHER restaurant', async () => {
    const t = newHarness()
    const ours = await seedStore(t, 'Chez Nous')
    const theirs = await seedStore(t, 'Chez Eux')
    const orderId = await seedDeliveryOrder(t, ours)
    const stranger = await seedUser(t, 'user:theirs', 'client_admin', [theirs])

    expect(await both(stranger, orderId)).toEqual({ order: false, tracking: false })
  })

  test('a signed-in account with no profile', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    expect(await both(t.withIdentity({ subject: 'user:ghost' }), orderId)).toEqual({
      order: false,
      tracking: false,
    })
  })
})

// ============================================================================
// What it answers
// ============================================================================

describe('the projection', () => {
  test('carries the delivery, the two map points and nothing about the diner', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t), {
      uberDirectStatus: 'EN_ROUTE_TO_DROPOFF' as const,
      uberDirectStatusAt: NOW + 1_000,
      uberDirectTrackingUrl: 'https://www.ubereats.com/orders/abc',
      uberDirectCourier: { name: 'Karim', vehicleType: 'bicycle', rating: 4.8 },
      uberDirectCourierLocation: { lat: 48.86, lng: 2.34, at: NOW + 2_000 },
      uberDirectPickupEta: NOW + 60_000,
      uberDirectDropoffEta: NOW + 900_000,
    })

    const tracking = await t.query(api.orders.getDeliveryTracking, {
      orderId,
      viewToken: 'vt-track',
    })

    expect(tracking).toEqual({
      orderType: 'delivery',
      orderStatus: 'confirmed',
      orderNumber: 'ORD-2026-00042',
      deliveryStatus: 'EN_ROUTE_TO_DROPOFF',
      deliveryStatusAt: NOW + 1_000,
      trackingUrl: 'https://www.ubereats.com/orders/abc',
      courier: { name: 'Karim', vehicleType: 'bicycle', rating: 4.8 },
      courierLocation: { lat: 48.86, lng: 2.34, at: NOW + 2_000 },
      pickupEta: NOW + 60_000,
      dropoffEta: NOW + 900_000,
      dropoff: { lat: 48.8559, lng: 2.3601, label: '10 rue de Rivoli, 75004 Paris' },
      store: { name: 'Chez Suivi', lat: 48.8686, lng: 2.3316, phone: '+33142000000' },
      createdAt: NOW,
      updatedAt: NOW,
    })
    // Deliberately absent: the lines, the amounts and the diner's contact.
    const serialised = JSON.stringify(tracking)
    expect(serialised).not.toContain('camille@example.test')
    expect(serialised).not.toContain('+33600000000')
    expect(serialised).not.toContain('Margherita')
  })

  test('answers nulls, not absent keys, before any courier exists', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const orderId = await seedDeliveryOrder(t, storeId, {
      uberDirectDeliveryId: undefined,
      uberDirectStatus: undefined,
      uberDirectStatusAt: undefined,
      deliveryAddress: {
        street: '10 rue de Rivoli',
        city: 'Paris',
        postalCode: '75004',
        country: 'France',
      },
    })

    const tracking = await t.query(api.orders.getDeliveryTracking, {
      orderId,
      viewToken: 'vt-track',
    })

    expect(tracking).toMatchObject({
      deliveryStatus: null,
      courier: null,
      courierLocation: null,
      pickupEta: null,
      dropoffEta: null,
      trackingUrl: null,
      // An address with no coordinates cannot be drawn.
      dropoff: null,
    })
  })

  test('answers null for an order that does not exist', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))
    await t.run((ctx) => ctx.db.delete(orderId))

    expect(
      await t.query(api.orders.getDeliveryTracking, { orderId, viewToken: 'vt-track' }),
    ).toBeNull()
  })
})

// ============================================================================
// The webhook that writes it
// ============================================================================

async function sign(body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function deliver(t: ReturnType<typeof convexTest>, payload: unknown) {
  const body = JSON.stringify(payload)
  return t.fetch('/webhooks/uber-direct', {
    method: 'POST',
    headers: { 'x-uber-signature': await sign(body) },
    body,
  })
}

function statusChanged(status: string, data: Record<string, unknown> = {}) {
  return {
    event_id: `evt_${status}`,
    event_time: 1_800_000_000,
    event_type: 'dapi.status_changed',
    meta: { order_id: DELIVERY, status },
    data,
  }
}

async function orderOf(t: ReturnType<typeof convexTest>, orderId: Id<'orders'>) {
  return t.run((ctx) => ctx.db.get(orderId))
}

describe('the Uber Direct webhook records the courier', () => {
  test('a status change carries the courier, the ETAs and the tracking page', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    const response = await deliver(
      t,
      statusChanged('EN_ROUTE_TO_PICKUP', {
        tracking_url: 'https://www.ubereats.com/orders/xyz',
        pickup_eta: '2026-09-27T12:05:00Z',
        dropoff_eta: '2026-09-27T12:30:00Z',
        courier: {
          name: 'Karim B.',
          phone_number: '+33612345678',
          img_href: 'https://cdn.example.test/karim.png',
          vehicle_type: 'bicycle',
          rating: 4.9,
          location: { lat: 48.87, lng: 2.33 },
        },
      }),
    )

    expect(response.status).toBe(200)
    const order = await orderOf(t, orderId)
    expect(order?.uberDirectStatus).toBe('EN_ROUTE_TO_PICKUP')
    expect(order?.uberDirectCourier).toEqual({
      name: 'Karim B.',
      phone: '+33612345678',
      imageUrl: 'https://cdn.example.test/karim.png',
      vehicleType: 'bicycle',
      rating: 4.9,
    })
    expect(order?.uberDirectCourierLocation).toMatchObject({ lat: 48.87, lng: 2.33 })
    expect(order?.uberDirectCourierLocation?.at).toBeGreaterThan(0)
    expect(order?.uberDirectPickupEta).toBe(Date.UTC(2026, 8, 27, 12, 5))
    expect(order?.uberDirectDropoffEta).toBe(Date.UTC(2026, 8, 27, 12, 30))
    expect(order?.uberDirectTrackingUrl).toBe('https://www.ubereats.com/orders/xyz')
  })

  test('a courier update moves the dot and keeps what it does not repeat', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t), {
      uberDirectStatus: 'EN_ROUTE_TO_DROPOFF' as const,
      uberDirectCourier: { name: 'Karim', phone: '+33612345678' },
    })

    const response = await deliver(t, {
      event_type: 'dapi.courier_update',
      meta: { order_id: DELIVERY },
      data: { courier: { vehicle_type: 'scooter', location: { lat: 48.86, lng: 2.35 } } },
    })

    expect(response.status).toBe(200)
    const order = await orderOf(t, orderId)
    // No status on a courier update, so none is written.
    expect(order?.uberDirectStatus).toBe('EN_ROUTE_TO_DROPOFF')
    expect(order?.uberDirectCourier).toEqual({
      name: 'Karim',
      phone: '+33612345678',
      vehicleType: 'scooter',
    })
    expect(order?.uberDirectCourierLocation).toMatchObject({ lat: 48.86, lng: 2.35 })
    // A position is not an edit to the order.
    expect(order?.updatedAt).toBe(NOW)
  })

  test("the newer API's event names are read the same way", async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    await deliver(t, {
      kind: 'event.courier_update',
      delivery_id: DELIVERY,
      location: { lat: 48.85, lng: 2.34 },
    })

    expect((await orderOf(t, orderId))?.uberDirectCourierLocation).toMatchObject({
      lat: 48.85,
      lng: 2.34,
    })
  })

  test('no position is kept once the delivery is COMPLETED', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t), {
      status: 'out_for_delivery' as const,
      uberDirectStatus: 'EN_ROUTE_TO_DROPOFF' as const,
      uberDirectCourierLocation: { lat: 48.86, lng: 2.35, at: NOW },
    })

    // The completion itself carries a last position: the status lands first,
    // so that position is already refused.
    await deliver(
      t,
      statusChanged('COMPLETED', { courier: { location: { lat: 48.8559, lng: 2.3601 } } }),
    )
    await deliver(t, {
      event_type: 'dapi.courier_update',
      meta: { order_id: DELIVERY },
      location: { lat: 40.0, lng: 3.0 },
    })

    const order = await orderOf(t, orderId)
    expect(order?.uberDirectStatus).toBe('COMPLETED')
    expect(order?.uberDirectCourierLocation).toEqual({ lat: 48.86, lng: 2.35, at: NOW })
  })

  test('caps what it stores and drops what is not safe to render', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    await deliver(
      t,
      statusChanged('EN_ROUTE_TO_PICKUP', {
        tracking_url: 'javascript:alert(1)',
        courier: {
          name: 'K'.repeat(10_000),
          img_href: 'http://insecure.example/k.png',
          rating: 42,
          location: { lat: 123, lng: 2 },
        },
      }),
    )

    const order = await orderOf(t, orderId)
    expect(order?.uberDirectCourier?.name?.length).toBeLessThanOrEqual(80)
    expect(order?.uberDirectCourier?.imageUrl).toBeUndefined()
    expect(order?.uberDirectCourier?.rating).toBeUndefined()
    expect(order?.uberDirectCourierLocation).toBeUndefined()
    expect(order?.uberDirectTrackingUrl).toBeUndefined()
  })

  test('a delivery we never booked is acknowledged, and nothing is written', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    const response = await deliver(t, {
      event_type: 'dapi.courier_update',
      meta: { order_id: 'del_unknown' },
      location: { lat: 48.86, lng: 2.35 },
    })

    expect(response.status).toBe(200)
    expect((await orderOf(t, orderId))?.uberDirectCourierLocation).toBeUndefined()
  })

  test('an unsigned body is refused before it is read', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    const response = await t.fetch('/webhooks/uber-direct', {
      method: 'POST',
      headers: { 'x-uber-signature': '00' },
      body: JSON.stringify({
        event_type: 'dapi.courier_update',
        meta: { order_id: DELIVERY },
        location: { lat: 48.86, lng: 2.35 },
      }),
    })

    expect(response.status).toBe(401)
    expect((await orderOf(t, orderId))?.uberDirectCourierLocation).toBeUndefined()
  })

  test('what the webhook wrote is what the diner reads', async () => {
    const t = newHarness()
    const orderId = await seedDeliveryOrder(t, await seedStore(t))

    await deliver(
      t,
      statusChanged('EN_ROUTE_TO_DROPOFF', {
        courier: { name: 'Léa', location: { lat: 48.858, lng: 2.35 } },
        dropoff_eta: '2026-09-27T12:30:00Z',
      }),
    )

    const tracking = await t.query(api.orders.getDeliveryTracking, {
      orderId,
      viewToken: 'vt-track',
    })
    expect(tracking).toMatchObject({
      deliveryStatus: 'EN_ROUTE_TO_DROPOFF',
      courier: { name: 'Léa' },
      courierLocation: { lat: 48.858, lng: 2.35 },
      dropoffEta: Date.UTC(2026, 8, 27, 12, 30),
    })
  })
})
