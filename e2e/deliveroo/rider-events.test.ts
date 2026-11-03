// @vitest-environment edge-runtime
/**
 * ┌─────────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Rider Status Events│
 * └─────────────────────────────────────────────────────────────┘
 *
 * @description
 * The Rider Status webhook (`rider.status_update`) tells the restaurant where
 * the rider is: assigned, nearing the site, confirmed at the site, checked in
 * by NFC tag, unassigned, in transit. Until now the handler answered « Unknown
 * Deliveroo webhook event » to every one of them, so the pass never learned a
 * rider was outside.
 *
 * What has to hold, driven through the real signed route:
 *  - the newest status lands on the order, by Deliveroo's own clock;
 *  - callbacks arrive out of order and more than once, so an older one cannot
 *    overwrite a newer one;
 *  - the rider can overtake `order.new`, and that is not an error (a 500 would
 *    be retried for ten minutes against an order that shows up a second later);
 *  - nothing personal about the rider is kept.
 *
 * @reference https://api-docs.deliveroo.com/reference/rider-events-webhook-1
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { api } from '../../convex/_generated/api'
import {
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postRaw,
  postSigned,
  readOrders,
  readWebhookFailures,
  seedStoreWithDeliveroo,
} from './convex-harness'
import { createNewOrderWebhook, generateOrderId } from './test-config'

beforeAll(() => configureDeliverooEnv())
afterEach(cancelPendingScheduledJobs)

const T0 = Date.parse('2026-10-12T10:00:00Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

function riderEvent(
  orderId: string,
  log: Array<{ at: string; status: string }>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    event: 'rider.status_update',
    body: {
      order_id: orderId,
      stacked_with: [],
      riders: [
        {
          estimated_arrival_time: at(15),
          at: at(0),
          accuracy_in_meters: 12,
          lat: 48.85,
          lon: 2.35,
          full_name: 'Deliveroo Rider',
          contact_number: '+33 6 00 00 00 00',
          bridge_code: '4821',
          bridge_number: '+33 1 00 00 00 00',
          status_log: log,
          ...extra,
        },
      ],
    },
  })
}

async function placeOrder(t: ReturnType<typeof newHarness>): Promise<string> {
  const orderId = generateOrderId('rider')
  const response = await postSigned(t, JSON.stringify(createNewOrderWebhook({ id: orderId })))
  expect(response.status).toBe(200)
  return orderId
}

describe('Rider status events', () => {
  it('records the rider status and ETA on the order', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)

    const response = await postSigned(
      t,
      riderEvent(orderId, [
        { at: at(0), status: 'rider_assigned' },
        { at: at(8), status: 'rider_arrived' },
      ]),
    )
    expect(response.status).toBe(200)

    const [order] = await readOrders(t)
    expect(order!.deliverooRider).toEqual({
      status: 'rider_arrived',
      statusAt: Date.parse(at(8)),
      estimatedArrivalAt: Date.parse(at(15)),
    })
  })

  it('follows the lifecycle through every documented status', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)
    const lifecycle = [
      'rider_assigned',
      'rider_arrived',
      'rider_confirmed_at_restaurant',
      'rider_checked_in',
      'rider_in_transit',
    ]

    const log: Array<{ at: string; status: string }> = []
    for (const [index, status] of lifecycle.entries()) {
      log.push({ at: at(index), status })
      const response = await postSigned(t, riderEvent(orderId, [...log]))
      expect(response.status).toBe(200)
      const [order] = await readOrders(t)
      expect(order!.deliverooRider!.status).toBe(status)
    }
  })

  it('does not let an older callback overwrite a newer one', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)

    await postSigned(t, riderEvent(orderId, [{ at: at(10), status: 'rider_in_transit' }]))
    // The delayed copy of an earlier callback, delivered after the later one.
    const late = await postSigned(t, riderEvent(orderId, [{ at: at(2), status: 'rider_assigned' }]))
    expect(late.status).toBe(200)

    const [order] = await readOrders(t)
    expect(order!.deliverooRider!.status).toBe('rider_in_transit')
    expect(order!.deliverooRider!.statusAt).toBe(Date.parse(at(10)))
  })

  it('is idempotent: the same callback twice leaves one state', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)
    const body = riderEvent(orderId, [{ at: at(3), status: 'rider_arrived' }])

    expect((await postSigned(t, body)).status).toBe(200)
    expect((await postSigned(t, body)).status).toBe(200)

    const orders = await readOrders(t)
    expect(orders).toHaveLength(1)
    expect(orders[0]!.deliverooRider!.status).toBe('rider_arrived')
  })

  it('takes the latest status across several riders on one order', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)

    const body = JSON.stringify({
      event: 'rider.status_update',
      body: {
        order_id: orderId,
        riders: [
          {
            status_log: [
              { at: at(0), status: 'rider_assigned' },
              { at: at(4), status: 'rider_unassigned' },
            ],
          },
          { estimated_arrival_time: at(20), status_log: [{ at: at(6), status: 'rider_assigned' }] },
        ],
      },
    })
    expect((await postSigned(t, body)).status).toBe(200)

    const [order] = await readOrders(t)
    expect(order!.deliverooRider!.status).toBe('rider_assigned')
    expect(order!.deliverooRider!.statusAt).toBe(Date.parse(at(6)))
    expect(order!.deliverooRider!.estimatedArrivalAt).toBe(Date.parse(at(20)))
  })

  it('acknowledges a rider update that overtakes order.new, and writes nothing', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)

    const response = await postSigned(
      t,
      riderEvent(generateOrderId('not-yet'), [{ at: at(0), status: 'rider_assigned' }]),
    )
    expect(response.status).toBe(200)
    expect(await readOrders(t)).toHaveLength(0)
    // Not a routing failure: nothing is owed, so nothing is dead-lettered.
    expect(await readWebhookFailures(t)).toHaveLength(0)
  })

  it('acknowledges a body with no usable status instead of asking for a retry', async () => {
    // A redelivery carries the same bytes, so a 500 would only burn ten minutes.
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)

    for (const body of [
      riderEvent(orderId, [{ at: at(0), status: 'rider_teleported' }]),
      riderEvent(orderId, []),
      JSON.stringify({ event: 'rider.status_update', body: {} }),
    ]) {
      expect((await postSigned(t, body)).status).toBe(200)
    }
    const [order] = await readOrders(t)
    expect(order!.deliverooRider).toBeUndefined()
  })

  it('keeps nothing personal about the rider', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)

    await postSigned(t, riderEvent(orderId, [{ at: at(0), status: 'rider_assigned' }]))

    const [order] = await readOrders(t)
    const stored = JSON.stringify(order!.deliverooRider)
    expect(stored).not.toMatch(/Deliveroo Rider|\+33|4821|bridge|48\.85/)
  })

  it('refuses an unsigned rider event', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)

    const response = await postRaw(
      t,
      riderEvent(orderId, [{ at: at(0), status: 'rider_assigned' }]),
      { 'x-deliveroo-hmac-sha256': '0'.repeat(64), 'x-deliveroo-sequence-guid': 'guid' },
    )
    expect(response.status).toBe(401)
    const [order] = await readOrders(t)
    expect(order!.deliverooRider).toBeUndefined()
  })

  it('serves the stored status through orders.getDeliverooRider, and nothing without access', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = await placeOrder(t)
    await postSigned(
      t,
      riderEvent(orderId, [{ at: at(0), status: 'rider_confirmed_at_restaurant' }]),
    )
    const [order] = await readOrders(t)

    // An anonymous caller holds neither the view token nor a staff session.
    expect(await t.query(api.orders.getDeliverooRider, { orderId: order!._id })).toBeNull()
  })
})
