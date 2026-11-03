// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Second review, finding 5: what an anonymisation leaves behind.
 *
 * A booking kept for the accounts loses its guest, and so must everything on its payment rows
 * and on the booking itself that quotes the guest in words: the reason a refund was made, a
 * provider's failure message, the address inside a notice failure. The limiter's rows are
 * keyed on the address as the guest typed it, so a stray space must not hide them from the
 * erasure. A group request's free text goes on the schedule of the other notes, not only on
 * erasure.
 */

import { describe, expect, test } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import {
  bookSlot,
  createHarnessFactory,
  dateIn,
  openSlots,
  seedBooking,
  seedWorld,
  type Harness,
} from './reservation-fixtures'
import { eraseFully, saveGroupPolicy, setupGlobalSettings } from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
const EMAIL = 'client@example.com'

/** A booking that money moved for, with the words a person or a provider wrote around it. */
async function paidBookingWithWords(t: Harness) {
  const world = await seedWorld(t, { looseTables: 2 })
  const id = await seedBooking(t, world, {
    date: dateIn(-3),
    time: '19:30',
    status: 'completed',
    email: EMAIL,
  })
  await t.run(async (ctx) => {
    await ctx.db.patch(id, {
      paymentCollectedAt: Date.now(),
      noticeFailure: { at: Date.now(), reason: 'transport', detail: `rejected for ${EMAIL}` },
    })
    await ctx.db.insert('reservationPayments', {
      storeId: world.storeId,
      reservationId: id,
      kind: 'refund',
      provider: 'stripe',
      status: 'succeeded',
      amount: 1000,
      currency: 'eur',
      refundReason: 'Mme Dupont s’est plainte du délai',
      attempt: 1,
      idempotencyKey: 'k1',
      checkoutUrl: `https://pay.example/checkout?prefilled_email=${EMAIL}`,
      customerRef: 'cus_1',
      methodRef: 'pm_1',
      failure: { code: 'card_declined', message: `Card of ${EMAIL} declined`, at: Date.now() },
      actor: 'staff',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
  return { world, id }
}

const payment = (t: Harness) => t.run((ctx) => ctx.db.query('reservationPayments').first())

describe('a booking kept for the accounts', () => {
  test('an erasure clears the refund reason, the provider’s words and the notice failure', async () => {
    const t = newHarness()
    const { world, id } = await paidBookingWithWords(t)
    await eraseFully(t, world.manager, EMAIL)
    const row = (await payment(t))!
    expect(row.refundReason).toBeUndefined()
    expect(row.customerRef).toBeUndefined()
    expect(row.methodRef).toBeUndefined()
    expect(row.checkoutUrl).toBeUndefined()
    expect(row.failure).toMatchObject({ code: 'card_declined', message: '' })
    expect((await t.run((ctx) => ctx.db.get(id)))!.noticeFailure).toBeUndefined()
  })

  test('the retention sweep clears the same words', async () => {
    const t = newHarness()
    const { id } = await paidBookingWithWords(t)
    for (let i = 0; i < 30; i++) {
      const report = await t.mutation(internal.privacy.sweepExpiredCustomerData, {
        now: Date.now() + 5 * 365 * 24 * 60 * 60_000,
      })
      if (!report.hasMore) break
    }
    const row = (await payment(t))!
    expect(row.refundReason).toBeUndefined()
    expect(row.failure).toMatchObject({ message: '' })
    expect((await t.run((ctx) => ctx.db.get(id)))!.noticeFailure).toBeUndefined()
  })
})

describe('a failure recorded for the host', () => {
  test('never carries an address, whatever the provider quoted', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, autoConfirm: true })
    const [slot] = await openSlots(t, world.storeId)
    const booked = await bookSlot(t, world, slot!, { email: EMAIL })
    const row = (await t.run((ctx) => ctx.db.query('reservations').collect())).find(
      (r) => r.manageToken === booked.manageToken,
    )!
    await t.mutation(internal.reservations.releaseNoticeClaim, {
      reservationId: row._id,
      kind: 'confirmed',
      failure: { reason: 'transport', detail: `554 rejected: <${EMAIL}> unknown` },
    })
    const failure = (await t.run((ctx) => ctx.db.get(row._id)))!.noticeFailure!
    expect(failure.detail).not.toContain(EMAIL)
    expect(failure.detail).toContain('554 rejected')
  })
})

describe('the limiter’s rows', () => {
  test('are keyed on the trimmed address, so the erasure finds them', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { looseTables: 2, autoConfirm: true })
    const [slot] = await openSlots(t, world.storeId)
    await bookSlot(t, world, slot!, { email: '  Rate@Example.com  ' })
    const keys = async () =>
      (await t.run((ctx) => ctx.db.query('rateLimits').collect())).map((row) => row.key)
    expect((await keys()).some((key) => key.startsWith('reservationPerEmail:'))).toBe(true)
    await eraseFully(t, world.manager, 'rate@example.com')
    expect((await keys()).filter((key) => key.includes('rate@example.com'))).toEqual([])
  })
})

describe('a group request’s free text', () => {
  test('goes with the notes, three days after the sitting, not only on erasure', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { autoConfirm: true, looseTables: 6, storeEmail: 'c@l.fr' })
    await saveGroupPolicy(world, {})
    const slot = (await openSlots(t, world.storeId, 12))[0]!
    // No allergy note at all: the free text alone must schedule its own erasure.
    await t.mutation(api.reservationGroups.requestGroup, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId,
      startsAt: slot.startsAt,
      partySize: 12,
      guest: { name: 'Léa', email: EMAIL, phone: '0612345678' },
      occasion: 'Anniversaire de Léa',
      budget: '40 € par personne',
      message: 'Ma grand-mère est en fauteuil',
      consentNoticeVersion: 'v1',
    } as never)
    const [row] = await t.run((ctx) => ctx.db.query('reservations').collect())
    expect(row!.noteExpiresAt).toBeGreaterThan(row!.endsAt)
    await world.waiter.mutation(api.reservationGroups.approveGroup, {
      id: row!._id,
      message: 'Table près de la porte pour le fauteuil',
    })

    await t.mutation(internal.reservationGuests.purgeGuestNotes, {
      now: row!.endsAt + 4 * 24 * 60 * 60_000,
    } as never)
    const after = (await t.run((ctx) => ctx.db.get(row!._id)))!
    expect(after.group).toEqual({
      requestedStartsAt: row!.group!.requestedStartsAt,
      decidedAt: expect.any(Number),
    })
    expect(after.noteExpiresAt).toBeUndefined()
  })
})
