// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The kitchen screen moves the order, not only the ticket.
 *
 * WHAT WENT WRONG. « Prêt » asked for `ready` and « Récupéré » for `completed` in
 * one write each, from an order that was still `confirmed`, and the status
 * machine only lets `confirmed` go to `preparing`. Both writes were refused,
 * caught, logged and reported to Sentry, and the action returned as if nothing
 * had happened: the toast said « Commande prête », the owner and the diner kept
 * reading « Confirmée », and the « votre commande est prête » e-mail, which
 * hangs off the `ready` transition, was never sent. « Démarrer » on a website
 * ticket wrote the ticket alone, so the order never reached `preparing` either.
 *
 * Found by creating a restaurant from scratch and taking one order through to
 * the invoice. The backend log carried the whole story —
 * `Invalid order status transition: confirmed -> ready` — on a screen that said
 * it had worked.
 *
 * These drive the real actions against the real schema. The pure half — which
 * moves the machine allows — is `orderStatus.test.ts` in
 * `@be-yours/convex-schema`.
 */

import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')
const NOW = 1_700_000_000_000

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/**
 * Drain the scheduler the way `deliveroo-post-accept-refusal.test.ts` does: a
 * status change books follow-up work (the « prête » e-mail, the customer
 * metadata), and a job still running when the file ends surfaces as a write
 * outside a transaction, blaming whichever suite happens to be executing.
 */
afterEach(async () => {
  for (const t of harnesses) {
    await t.finishInProgressScheduledFunctions()
    await t.run(async (ctx) => {
      const pending = await ctx.db.system.query('_scheduled_functions').collect()
      for (const job of pending) {
        if (job.state.kind === 'pending' || job.state.kind === 'inProgress') {
          await ctx.scheduler.cancel(job._id)
        }
      }
    })
  }
  harnesses.length = 0
})

type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'completed'
  | 'cancelled'

type TicketStatus = 'pending' | 'in_progress' | 'ready' | 'completed' | 'cancelled'

async function seedKitchen(
  t: ReturnType<typeof convexTest>,
  opts: {
    order: OrderStatus
    ticket: TicketStatus
    type?: 'pickup' | 'delivery'
  },
) {
  const type = opts.type ?? 'pickup'
  const storeId = await t.run((ctx) =>
    ctx.db.insert('stores', {
      name: 'Chez Mario',
      slug: 'chez-mario',
      address: { street: '14 rue Mercière', city: 'Lyon', postalCode: '69002', country: 'France' },
      hours: [],
      status: 'open' as const,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  await t.run((ctx) =>
    ctx.db.insert('userProfiles', {
      userId: 'user:cook',
      role: 'client_admin' as const,
      storeIds: [storeId as Id<'stores'>],
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  const { orderId, ticketId } = await t.run(async (ctx) => {
    const orderId = await ctx.db.insert('orders', {
      storeId,
      orderNumber: 'ORD-2026-00001',
      customerInfo: { name: 'Julie Martin', email: 'julie.martin@exemple.test' },
      type,
      status: opts.order,
      items: [],
      subtotal: 1100,
      taxAmount: 100,
      total: 1100,
      paymentStatus: 'pending' as const,
      source: 'website',
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    const ticketId = await ctx.db.insert('kitchenTickets', {
      storeId,
      orderId,
      orderNumber: 'ORD-2026-00001',
      orderType: type,
      items: [],
      priority: 'normal' as const,
      source: 'website' as const,
      status: opts.ticket,
      trackingToken: 'tok-kitchen-1',
      printStatus: 'not_required' as const,
      printAttempts: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    return { orderId, ticketId }
  })
  return { asCook: t.withIdentity({ subject: 'user:cook' }), orderId, ticketId }
}

const read = <T extends 'orders' | 'kitchenTickets'>(t: ReturnType<typeof convexTest>, id: Id<T>) =>
  t.run((ctx) => ctx.db.get(id))

describe('« Démarrer » on a website ticket', () => {
  test('starts the order as well as the ticket', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'confirmed',
      ticket: 'pending',
    })

    await asCook.action(api.kitchenTickets.acceptTicket, { id: ticketId })

    expect((await read(t, ticketId))?.status).toBe('in_progress')
    expect((await read(t, orderId))?.status).toBe('preparing')
  })

  test('does not fail when the owner already started the order from the order page', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'preparing',
      ticket: 'pending',
    })

    await asCook.action(api.kitchenTickets.acceptTicket, { id: ticketId })

    expect((await read(t, ticketId))?.status).toBe('in_progress')
    expect((await read(t, orderId))?.status).toBe('preparing')
  })
})

describe('« Prêt »', () => {
  test('takes an order that is still `confirmed` to `ready` through `preparing`', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'confirmed',
      ticket: 'in_progress',
    })

    await asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })

    expect((await read(t, ticketId))?.status).toBe('ready')
    expect((await read(t, orderId))?.status).toBe('ready')
  })

  test('sends the diner « votre commande est prête »', async () => {
    const t = newHarness()
    const { asCook, ticketId } = await seedKitchen(t, { order: 'confirmed', ticket: 'in_progress' })

    await asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })

    // The e-mail hangs off the `ready` transition, and the refused write is why
    // it never left. Scheduled, not delivered: there is no mail transport here.
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(jobs.map((job) => job.name)).toContain('customerEmail:sendOrderReady')
  })

  test('leaves an order the owner already marked ready alone', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'ready',
      ticket: 'in_progress',
    })

    await asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })

    expect((await read(t, ticketId))?.status).toBe('ready')
    expect((await read(t, orderId))?.status).toBe('ready')
  })

  test('is refused, with the ticket left where it was, when the order was cancelled', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'cancelled',
      ticket: 'in_progress',
    })

    await expect(asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })).rejects.toThrow()

    // The screen no longer says « Commande prête » over an order that is not.
    expect((await read(t, ticketId))?.status).toBe('in_progress')
    expect((await read(t, orderId))?.status).toBe('cancelled')
  })
})

describe('« Récupéré »', () => {
  test('completes a pickup order, whatever it still had to pass', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'confirmed',
      ticket: 'ready',
    })

    await asCook.action(api.kitchenTickets.completeTicket, { id: ticketId })

    expect((await read(t, ticketId))?.status).toBe('completed')
    expect((await read(t, orderId))?.status).toBe('completed')
  })

  test('completes an order the owner already completed from the order page', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'completed',
      ticket: 'ready',
    })

    await asCook.action(api.kitchenTickets.completeTicket, { id: ticketId })

    expect((await read(t, ticketId))?.status).toBe('completed')
    expect((await read(t, orderId))?.status).toBe('completed')
  })

  test('hands a delivery order to the courier rather than completing it', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'ready',
      ticket: 'ready',
      type: 'delivery',
    })

    await asCook.action(api.kitchenTickets.completeTicket, { id: ticketId })

    expect((await read(t, orderId))?.status).toBe('out_for_delivery')
  })
})

describe('the whole round, kitchen screen only', () => {
  test('Démarrer, Prêt, Récupéré leave the order Terminée and the ticket completed', async () => {
    const t = newHarness()
    const { asCook, orderId, ticketId } = await seedKitchen(t, {
      order: 'confirmed',
      ticket: 'pending',
    })

    await asCook.action(api.kitchenTickets.acceptTicket, { id: ticketId })
    expect((await read(t, orderId))?.status).toBe('preparing')

    await asCook.action(api.kitchenTickets.readyTicket, { id: ticketId })
    expect((await read(t, orderId))?.status).toBe('ready')

    await asCook.action(api.kitchenTickets.completeTicket, { id: ticketId })
    expect((await read(t, orderId))?.status).toBe('completed')
    expect((await read(t, ticketId))?.status).toBe('completed')
  })
})
