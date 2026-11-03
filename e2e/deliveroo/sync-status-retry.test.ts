// @vitest-environment edge-runtime
/**
 * ┌───────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Sync status that did not land   │
 * └───────────────────────────────────────────────────────────┘
 *
 * @description
 * Deliveroo gives three minutes to answer an accepted order with a sync status,
 * and the success rate that keeps the API enabled counts a missing one as a
 * failed order. The handler used to log a failed send and move on: one 503, one
 * rate limit, one dropped connection inside the window and the order was lost for
 * good, with nothing on the screen to say so.
 *
 * What has to hold:
 *  - a send that failed for a reason that may pass (network, 429, 5xx) is
 *    booked again, with the SAME verdict and reason;
 *  - an answer that will not change (a 4xx) is reported once and not repeated;
 *  - the retries stop, and say so, after the last attempt.
 *
 * @reference https://api-docs.deliveroo.com/docs/order-integration
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { internal } from '../../convex/_generated/api'
import {
  apiCallsExcludingAuth,
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  postSigned,
  readScheduledJobs,
  seedStoreWithDeliveroo,
  withDeliverooApi,
} from './convex-harness'
import { createNewOrderWebhook, createStatusUpdateWebhook, generateOrderId } from './test-config'

beforeAll(() => configureDeliverooEnv({ withApiCredentials: true }))
afterEach(cancelPendingScheduledJobs)

const answer = (status: number) => () =>
  new Response(JSON.stringify({ error: { code: 'x' } }), { status })

const pendingRetries = async (t: ReturnType<typeof newHarness>) =>
  (await readScheduledJobs(t)).filter(
    (j) => j.state.kind === 'pending' && j.name === 'deliverooWebhook:retrySyncStatus',
  )

/** Place an order and have Deliveroo report it accepted; `respond` answers the sync call. */
const UNKNOWN_PLU_ITEMS = [
  {
    pos_item_id: 'NOT-IN-OUR-CATALOGUE',
    quantity: 1,
    name: 'Burger mystère',
    unit_price: { fractional: 900, currency_code: 'EUR' },
    total_price: { fractional: 900, currency_code: 'EUR' },
  },
]

async function acceptedOrder(
  respond: (call: { method: string; url: string }) => Response,
  items: unknown[] = UNKNOWN_PLU_ITEMS,
) {
  const t = newHarness()
  await seedStoreWithDeliveroo(t)
  const orderId = generateOrderId('sync-retry')
  const calls = await withDeliverooApi(async (recorded) => {
    await postSigned(t, JSON.stringify(createNewOrderWebhook({ id: orderId })))
    await postSigned(t, JSON.stringify(createStatusUpdateWebhook(orderId, 'accepted', { items })))
    return apiCallsExcludingAuth(recorded)
  }, respond)
  return { t, orderId, calls }
}

const onlySync = (call: { url: string; method: string }, response: Response) =>
  call.url.includes('sync_status') ? response : new Response('{}', { status: 200 })

describe('a sync status that did not go through', () => {
  it.each([503, 500, 429])(
    'is booked again after a %i, with the same verdict and reason',
    async (status) => {
      const { t, orderId } = await acceptedOrder((call) => onlySync(call, answer(status)()))

      const retries = await pendingRetries(t)
      expect(retries, `a ${status} was dropped`).toHaveLength(1)
      expect(retries[0]!.args[0]).toMatchObject({
        orderId,
        attempt: 2,
        // The item's PLU is not in the catalogue, so the first verdict was a failure; the
        // retry must not quietly turn it into a success.
        status: 'failed',
        reason: 'pos_item_id_mismatched',
      })
      expect(retries[0]!.scheduledTime - Date.now()).toBeLessThan(60_000)
    },
  )

  it('is booked again when the request never got an answer', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const orderId = generateOrderId('sync-network')
    const realFetch = globalThis.fetch

    await withDeliverooApi(async () => {
      await postSigned(t, JSON.stringify(createNewOrderWebhook({ id: orderId })))
      // From here the network is gone, apart from the token.
      const recorder = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('sync_status')) throw new TypeError('network down')
        return recorder(input, init)
      }) as typeof fetch
      try {
        await postSigned(
          t,
          JSON.stringify(
            createStatusUpdateWebhook(orderId, 'accepted', { items: UNKNOWN_PLU_ITEMS }),
          ),
        )
      } finally {
        globalThis.fetch = realFetch
      }
    })

    expect(await pendingRetries(t)).toHaveLength(1)
  })

  it.each([400, 401, 404])(
    'is not booked again after a %i, which will not change',
    async (status) => {
      const { t } = await acceptedOrder((call) => onlySync(call, answer(status)()))
      expect(await pendingRetries(t)).toHaveLength(0)
    },
  )

  it('treats 409 (the window is closed) as settled, not as a failure to repeat', async () => {
    const { t } = await acceptedOrder((call) => onlySync(call, answer(409)()))
    expect(await pendingRetries(t)).toHaveLength(0)
  })

  it('does not book anything when the send went through', async () => {
    const { t, calls } = await acceptedOrder(() => new Response('{}', { status: 200 }))
    expect(calls.some((c) => c.url.includes('sync_status'))).toBe(true)
    expect(await pendingRetries(t)).toHaveLength(0)
  })
})

describe('retrySyncStatus', () => {
  const run = (t: ReturnType<typeof newHarness>, args: Record<string, unknown>, status: number) =>
    withDeliverooApi(
      async (recorded) => {
        await t.action(internal.deliverooWebhook.retrySyncStatus, {
          orderId: 'fr:retry-1',
          status: 'failed',
          reason: 'pos_item_id_mismatched',
          attempt: 2,
          ...args,
        } as never)
        return apiCallsExcludingAuth(recorded)
      },
      () => (status === 200 ? new Response('{}', { status: 200 }) : answer(status)()),
    )

  it('sends the verdict and the reason it was given', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    const calls = await run(t, {}, 200)

    expect(JSON.parse(calls[0]!.body ?? '{}')).toMatchObject({
      status: 'failed',
      reason: 'pos_item_id_mismatched',
    })
    expect(calls[0]!.url).toContain('/sync_status')
    expect(await pendingRetries(t)).toHaveLength(0)
  })

  it('books the next attempt on a 503, and a longer wait on a 429', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    await run(t, { attempt: 2 }, 503)
    const [soon] = await pendingRetries(t)
    expect(soon!.args[0]).toMatchObject({ attempt: 3 })
    await cancelPendingScheduledJobs()

    const limited = newHarness()
    await seedStoreWithDeliveroo(limited)
    await run(limited, { attempt: 2 }, 429)
    const [later] = await pendingRetries(limited)
    expect(later!.scheduledTime - Date.now()).toBeGreaterThan(20_000)
  })

  it('stops after the last attempt', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    await run(t, { attempt: 5 }, 503)
    expect(await pendingRetries(t)).toHaveLength(0)
  })

  it('does not repeat an answer that will not change', async () => {
    const t = newHarness()
    await seedStoreWithDeliveroo(t)
    await run(t, { attempt: 2 }, 400)
    expect(await pendingRetries(t)).toHaveLength(0)
  })
})
