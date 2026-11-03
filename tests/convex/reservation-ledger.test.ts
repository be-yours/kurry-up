// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The booking money on the payments dashboard: read-only, never mixed into the orders, and
 * with totals that cannot count a refund twice.
 */

import { describe, expect, test } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import {
  DAY,
  NOW,
  createHarnessFactory,
  dateIn,
  seedBooking,
  seedWorld,
  type Harness,
  type World,
} from './reservation-fixtures'

const newHarness = createHarnessFactory()
const HOUR = 60 * 60_000

type Row = Omit<
  Doc<'reservationPayments'>,
  | '_id'
  | '_creationTime'
  | 'storeId'
  | 'reservationId'
  | 'currency'
  | 'actor'
  | 'createdAt'
  | 'updatedAt'
  | 'attempt'
  | 'idempotencyKey'
> & { currency?: string }

let n = 0
async function insertRow(t: Harness, world: World, reservationId: Id<'reservations'>, row: Row) {
  return await t.run((ctx) =>
    ctx.db.insert('reservationPayments', {
      storeId: world.storeId,
      reservationId,
      currency: 'EUR',
      actor: 'guest',
      attempt: 1,
      idempotencyKey: `k-${++n}`,
      createdAt: NOW,
      updatedAt: NOW,
      ...row,
    }),
  )
}

async function world(t: Harness) {
  return await seedWorld(t, { looseTables: 2 })
}

async function booking(t: Harness, w: World, email: string, extra: Record<string, unknown> = {}) {
  return await seedBooking(t, w, { date: dateIn(10), time: '20:00', email, ...extra } as never)
}

const ledger = (w: World, args: Record<string, unknown> = {}) =>
  w.waiter.query(api.reservationPayments.listLedger, { storeId: w.storeId, ...args })
const totals = (w: World, args: Record<string, unknown> = {}) =>
  w.waiter.query(api.reservationPayments.ledgerTotals, { storeId: w.storeId, ...args })

describe('the booking money on the payments dashboard', () => {
  test('lists each charge once, with its booking, and carries what the provider confirmed back', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com', { name: 'Marie Dupont' })
    const deposit = await insertRow(t, w, id, {
      kind: 'deposit',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6500,
    })
    await insertRow(t, w, id, {
      kind: 'refund',
      provider: 'stripe',
      status: 'succeeded',
      amount: 2000,
      refundOf: deposit,
    })
    // A refund requested and not confirmed is not « remboursé ».
    await insertRow(t, w, id, {
      kind: 'refund',
      provider: 'stripe',
      status: 'reserved',
      amount: 500,
      refundOf: deposit,
    })
    const { rows, truncated } = await ledger(w)
    expect(truncated).toBe(false)
    // The refunds are not lines of their own: one charge, one line.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'deposit',
      kindLabel: 'Acompte',
      provider: 'stripe',
      status: 'succeeded',
      statusLabel: 'Confirmé',
      amount: 6500,
      currency: 'EUR',
      takesMoney: true,
      refundedAmount: 2000,
      reservationId: String(id),
      guestName: 'Marie Dupont',
      bookingDate: dateIn(10),
    })
    expect(rows[0]!.reference).toMatch(/^RES-SEED-/)
  })

  test('flags a line a person has to look at: a dispute, a refund nobody confirmed, a refund that failed', async () => {
    const t = newHarness()
    const w = await world(t)
    const disputed = await booking(t, w, 'dispute@example.com')
    const stalled = await booking(t, w, 'stalled@example.com')
    const failed = await booking(t, w, 'failed@example.com')
    const settled = await booking(t, w, 'settled@example.com')
    const calm = await booking(t, w, 'calm@example.com')
    const charge = (reservation: Id<'reservations'>, extra: Partial<Row> = {}) =>
      insertRow(t, w, reservation, {
        kind: 'deposit',
        provider: 'stripe',
        status: 'succeeded',
        amount: 2000,
        ...extra,
      })
    await charge(disputed, { attentionCode: 'dispute', attentionAt: NOW })
    const stalledCharge = await charge(stalled)
    await insertRow(t, w, stalled, {
      kind: 'refund',
      provider: 'stripe',
      status: 'reserved',
      amount: 2000,
      refundOf: stalledCharge,
      attentionCode: 'refund_unconfirmed',
      attentionAt: NOW,
    })
    const failedCharge = await charge(failed)
    await insertRow(t, w, failed, {
      kind: 'refund',
      provider: 'stripe',
      status: 'failed',
      amount: 2000,
      refundOf: failedCharge,
      attentionCode: 'refund_failed',
      attentionAt: NOW,
    })
    // A refund that was flagged and has been confirmed since is no longer waiting for anybody.
    const settledCharge = await charge(settled, { refundedAmount: 2000 })
    await insertRow(t, w, settled, {
      kind: 'refund',
      provider: 'stripe',
      status: 'succeeded',
      amount: 2000,
      refundOf: settledCharge,
      attentionCode: 'refund_unconfirmed',
      attentionAt: NOW,
    })
    await charge(calm)

    const { rows } = await ledger(w)
    const attentionOf = (reservation: Id<'reservations'>) =>
      rows.find((row: { reservationId: string }) => row.reservationId === String(reservation))!
        .attention
    expect(attentionOf(disputed)).toBe('dispute')
    expect(attentionOf(stalled)).toBe('refund_unconfirmed')
    expect(attentionOf(failed)).toBe('refund_failed')
    expect(attentionOf(settled)).toBeNull()
    expect(attentionOf(calm)).toBeNull()
    // Flagging a line changes no figure: a disputed deposit is still the provider's confirmed
    // deposit, and a refund nobody confirmed is still in no total.
    const [sum] = (await totals(w)).totals
    expect(sum).toMatchObject({ collected: 10000, refunded: 2000, net: 8000 })
  })

  test('adds each confirmed movement once, and a refund is never added beside its charge’s own figure', async () => {
    const t = newHarness()
    const w = await world(t)
    const a = await booking(t, w, 'a@example.com')
    const b = await booking(t, w, 'b@example.com')
    const c = await booking(t, w, 'c@example.com')
    const d1 = await insertRow(t, w, a, {
      kind: 'deposit',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6000,
      refundedAmount: 6000,
    })
    await insertRow(t, w, a, {
      kind: 'refund',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6000,
      refundOf: d1,
    })
    await insertRow(t, w, b, {
      kind: 'deposit',
      provider: 'paypal',
      status: 'succeeded',
      amount: 4000,
    })
    await insertRow(t, w, b, {
      kind: 'no_show_fee',
      provider: 'stripe',
      status: 'succeeded',
      amount: 1500,
    })
    // A card secured is not money.
    await insertRow(t, w, c, {
      kind: 'guarantee',
      provider: 'stripe',
      status: 'succeeded',
      amount: 5000,
    })
    // An attempt that did not complete is in no total.
    await insertRow(t, w, c, { kind: 'deposit', provider: 'sumup', status: 'failed', amount: 9999 })
    await insertRow(t, w, c, {
      kind: 'deposit',
      provider: 'sumup',
      status: 'pending',
      amount: 9999,
    })
    const out = await totals(w)
    expect(out.truncated).toBe(false)
    expect(out.totals).toEqual([
      {
        currency: 'EUR',
        collected: 10_000,
        fees: 1500,
        refunded: 6000,
        net: 5500,
        guarantees: 1,
        incomplete: 2,
      },
    ])
  })

  test('says a guarantee takes nothing, and keeps a failed attempt in the list but not the totals', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com')
    await insertRow(t, w, id, {
      kind: 'guarantee',
      provider: 'stripe',
      status: 'succeeded',
      amount: 5000,
    })
    await insertRow(t, w, id, {
      kind: 'no_show_fee',
      provider: 'stripe',
      status: 'failed',
      amount: 1000,
      failure: { code: 'card_declined', message: 'x', at: NOW },
    })
    const { rows } = await ledger(w)
    expect(rows.map((r) => [r.kind, r.takesMoney, r.failure])).toEqual(
      expect.arrayContaining([
        ['guarantee', false, null],
        ['no_show_fee', true, 'card_declined'],
      ]),
    )
    const [sum] = (await totals(w)).totals
    expect(sum).toMatchObject({ collected: 0, fees: 0, guarantees: 1, incomplete: 1 })
  })

  test('narrows to a kind and to a period, and the totals follow the period', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com')
    await insertRow(t, w, id, {
      kind: 'deposit',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6000,
    })
    await insertRow(t, w, id, {
      kind: 'no_show_fee',
      provider: 'stripe',
      status: 'succeeded',
      amount: 1000,
    })
    expect((await ledger(w, { kind: 'deposit' })).rows.map((r) => r.kind)).toEqual(['deposit'])
    expect((await ledger(w, { kind: 'no_show_fee' })).rows.map((r) => r.kind)).toEqual([
      'no_show_fee',
    ])
    // A window that does not contain the rows' creation time.
    const past = { from: Date.now() - 40 * DAY, to: Date.now() - 20 * DAY }
    expect((await ledger(w, past)).rows).toEqual([])
    expect((await totals(w, past)).totals).toEqual([])
    const refused = w.waiter.query(api.reservationPayments.listLedger, {
      storeId: w.storeId,
      from: Date.now(),
      to: Date.now() - HOUR,
    })
    await expect(refused).rejects.toThrow()
  })

  test('adds each currency apart', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com')
    await insertRow(t, w, id, {
      kind: 'deposit',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6000,
    })
    await insertRow(t, w, id, {
      kind: 'deposit',
      provider: 'paypal',
      status: 'succeeded',
      amount: 700,
      currency: 'GBP',
    })
    const out = await totals(w)
    expect(out.totals.map((x) => [x.currency, x.net])).toEqual([
      ['EUR', 6000],
      ['GBP', 700],
    ])
  })

  test('shows the money of an erased guest without the guest, and of a group or an event with its kind', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com')
    await t.run((ctx) => ctx.db.patch(id, { guestName: '', guestEmail: '', kind: 'group' }))
    await insertRow(t, w, id, {
      kind: 'deposit',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6000,
    })
    const { rows } = await ledger(w)
    expect(rows[0]).toMatchObject({ guestName: null, bookingKind: 'group', amount: 6000 })
  })

  test('is the payments dashboard’s own permission, and an establishment sees only its own money', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com')
    await insertRow(t, w, id, {
      kind: 'deposit',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6000,
    })
    // The waiter holds payments:read (the dashboard); a kitchen account holds nothing here.
    await t.run((ctx) =>
      ctx.db.insert('userProfiles', {
        userId: 'cook',
        role: 'kitchen',
        storeIds: [w.storeId],
        permissions: [],
        language: 'fr',
        twoFactorEnabled: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    const cook = t.withIdentity({ subject: 'cook' })
    await expect(
      cook.query(api.reservationPayments.listLedger, { storeId: w.storeId }),
    ).rejects.toThrow()
    await expect(
      cook.query(api.reservationPayments.ledgerTotals, { storeId: w.storeId }),
    ).rejects.toThrow()
    const other = await seedWorld(t, { looseTables: 1, profiles: false })
    const rows = await other.manager
      .query(api.reservationPayments.listLedger, { storeId: other.storeId })
      .catch(() => null)
    // No profile for that identity at the other establishment: refused, or empty — never ours.
    expect(rows === null || rows.rows.length === 0).toBe(true)
    expect((await ledger(w)).rows).toHaveLength(1)
  })

  test('is bounded: a long ledger answers the newest rows and says it is cut', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com')
    await t.run(async (ctx) => {
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert('reservationPayments', {
          storeId: w.storeId,
          reservationId: id,
          kind: 'deposit',
          provider: 'stripe',
          status: 'succeeded',
          amount: 100,
          currency: 'EUR',
          attempt: 1,
          idempotencyKey: `bulk-${i}`,
          actor: 'guest',
          createdAt: NOW,
          updatedAt: NOW,
        })
      }
    })
    const out = await ledger(w)
    expect(out.rows).toHaveLength(200)
    expect(out.truncated).toBe(true)
    expect((await totals(w)).totals[0]!.collected).toBe(21_000)
  })

  test('does not touch the order payments or the invoices: the money stays in its own table', async () => {
    const t = newHarness()
    const w = await world(t)
    const id = await booking(t, w, 'a@example.com')
    await insertRow(t, w, id, {
      kind: 'deposit',
      provider: 'stripe',
      status: 'succeeded',
      amount: 6000,
    })
    await ledger(w)
    await totals(w)
    expect(await t.run((ctx) => ctx.db.query('payments').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('invoices').collect())).toEqual([])
    const orderPayments = await w.waiter.query(api.payments.getByStore, {
      storeId: w.storeId,
      paginationOpts: { numItems: 10, cursor: null },
    })
    expect(orderPayments.page).toEqual([])
  })
})
