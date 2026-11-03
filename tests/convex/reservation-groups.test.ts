// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Groups, answered by the host.
 *
 * What is proved here is everything the SERVER decides: which way a party of a given size
 * goes, that a request is always answered by a person and holds capacity for exactly its
 * review window, what each answer (accept, refuse, propose another time) does to the
 * booking, the tables and the guest's money, and that nothing about a request survives an
 * erasure that should not. No provider is reached: a payment is settled with the fact an
 * action would read back.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { api, internal } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  bookSlot,
  createHarnessFactory,
  dateIn,
  eventRows,
  guest,
  openSlots,
  refusalCode,
  refusalMessage,
  seedWorld,
  type Harness,
  type World,
} from './reservation-fixtures'
import {
  bookingByToken,
  dispatches,
  eraseFully,
  noticeKinds,
  openAttempt,
  paymentRows,
  payBooking,
  saveGroupPolicy,
  scheduled,
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
const HOUR = 60 * 60_000

beforeEach(stubPaymentWorld)
afterEach(unstubPaymentWorld)

/** An establishment of six tables of four, taking cards, with groups from nine to twenty. */
async function groupWorld(
  t: Harness,
  options: { autoConfirm?: boolean; policy?: Parameters<typeof saveGroupPolicy>[1] | false } = {},
): Promise<World> {
  await setupGlobalSettings(t)
  const world = await seedWorld(t, {
    autoConfirm: options.autoConfirm ?? true,
    looseTables: 6,
    storeEmail: 'contact@luigi.fr',
  })
  if (options.policy !== false) await saveGroupPolicy(world, options.policy ?? {})
  return world
}

interface RequestOptions {
  partySize?: number
  date?: string
  email?: string
  occasion?: string
  budget?: string
  message?: string
  note?: string
  slotIndex?: number
  idempotencyKey?: string
}

async function requestGroup(t: Harness, world: World, options: RequestOptions = {}) {
  const partySize = options.partySize ?? 12
  const slot = (await openSlots(t, world.storeId, partySize, { date: options.date }))[
    options.slotIndex ?? 0
  ]!
  const result = await t.mutation(api.reservationGroups.requestGroup, {
    storeId: world.storeId,
    date: options.date ?? dateIn(10),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize,
    guest: { ...guest, email: options.email ?? guest.email },
    note: options.note,
    occasion: options.occasion,
    budget: options.budget,
    message: options.message,
    consentNoticeVersion: 'v1',
    idempotencyKey: options.idempotencyKey,
  })
  const row = (await bookingByToken(t, result.manageToken))!
  return { result, row, token: result.manageToken, id: row._id, slot }
}

const rowOf = (t: Harness, id: Id<'reservations'>) => t.run((ctx) => ctx.db.get(id))

/** A time the guest could not have asked for: the second slot, away from the first. */
async function otherSlot(t: Harness, world: World, partySize: number, from: number) {
  const slots = await openSlots(t, world.storeId, partySize)
  // Far enough from the first that the two windows do not overlap, so one is free while the
  // other is held.
  return slots.find((slot) => Math.abs(slot.startsAt - from) >= 90 * 60_000)!
}

/* ------------------------------------------------------------------ */
/* Which way a party goes                                              */
/* ------------------------------------------------------------------ */

describe('which way a party goes', () => {
  test('is told to the booking page: the sizes the form takes, the requests, and who to call', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const config = (await t.query(api.reservations.getPublicConfig, { storeId: world.storeId }))!
    expect(config.directMax).toBe(8)
    expect(config.groups).toEqual({ minSize: 9, maxSize: 20, reviewHours: 48 })
    // The way to reach the establishment is the one the site already shows everybody.
    expect(config.contact.email).toBe('contact@luigi.fr')
  })

  test('leaves the form as it was while groups are off: no requests, a call above the ceiling', async () => {
    const t = newHarness()
    const world = await groupWorld(t, { policy: false })
    const config = (await t.query(api.reservations.getPublicConfig, { storeId: world.storeId }))!
    expect(config.groups).toBeNull()
    expect(config.directMax).toBe(8)
    // A party of nine is not a request here; it is told to get in touch.
    const slots = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 9,
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every((slot) => !slot.available && slot.reason === 'party_size')).toBe(true)
    const first = (await openSlots(t, world.storeId, 2))[0]!
    expect(
      await refusalCode(
        t.mutation(api.reservations.create, {
          storeId: world.storeId,
          date: dateIn(10),
          serviceId: first.serviceId as Id<'reservationServices'>,
          startsAt: first.startsAt,
          partySize: 9,
          guest,
          consentNoticeVersion: 'v1',
        }),
      ),
    ).toBe('party_contact_only')
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.requestGroup, {
          storeId: world.storeId,
          date: dateIn(10),
          serviceId: first.serviceId as Id<'reservationServices'>,
          startsAt: first.startsAt,
          partySize: 12,
          guest,
          consentNoticeVersion: 'v1',
        }),
      ),
    ).toBe('group_not_offered')
  })

  test('shows a group slots a request can be made for, and a party too large none at all', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    // Twelve do not fit any one table or combinable group, and the form takes eight: only a
    // request can be made, and the engine finds the tables for the whole party.
    const group = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 12,
    })
    expect(group.filter((slot) => slot.available).length).toBeGreaterThan(0)
    const tooLarge = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 21,
    })
    expect(tooLarge.every((slot) => !slot.available)).toBe(true)
  })

  test('refuses an ordinary booking for a group size, and a request for an ordinary size', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const slot = (await openSlots(t, world.storeId, 12))[0]!
    const ordinary = (partySize: number) =>
      t.mutation(api.reservations.create, {
        storeId: world.storeId,
        date: dateIn(10),
        serviceId: slot.serviceId as Id<'reservationServices'>,
        startsAt: slot.startsAt,
        partySize,
        guest,
        consentNoticeVersion: 'v1',
      })
    // A form that sends a group of twelve as an ordinary booking is NOT confirmed.
    expect(await refusalCode(ordinary(12))).toBe('group_not_offered')
    expect(await refusalCode(ordinary(21))).toBe('party_contact_only')
    const asGroup = (partySize: number) =>
      t.mutation(api.reservationGroups.requestGroup, {
        storeId: world.storeId,
        date: dateIn(10),
        serviceId: slot.serviceId as Id<'reservationServices'>,
        startsAt: slot.startsAt,
        partySize,
        guest,
        consentNoticeVersion: 'v1',
      })
    expect(await refusalCode(asGroup(8))).toBe('group_not_offered')
    expect(await refusalCode(asGroup(21))).toBe('party_contact_only')
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(0)
  })

  test('lowers what the ordinary form takes to just under the threshold', async () => {
    const t = newHarness()
    const world = await groupWorld(t, { policy: { threshold: 4, maxSize: 20 } })
    const config = (await t.query(api.reservations.getPublicConfig, { storeId: world.storeId }))!
    expect(config.directMax).toBe(3)
    const slot = (await openSlots(t, world.storeId, 3))[0]!
    await expect(bookSlot(t, world, slot, { partySize: 3 })).resolves.toBeDefined()
    expect(await refusalCode(bookSlot(t, world, slot, { partySize: 4 }))).toBe('group_not_offered')
  })
})

/* ------------------------------------------------------------------ */
/* Sending a request                                                   */
/* ------------------------------------------------------------------ */

describe('a guest sends a request', () => {
  test('is pending whatever the confirmation mode, owes nothing yet and says nothing is confirmed', async () => {
    const t = newHarness()
    // The house confirms on its own: a group request is still answered by a person.
    const world = await groupWorld(t, { autoConfirm: true })
    const before = Date.now()
    const { result, row } = await requestGroup(t, world, {
      occasion: 'Anniversaire',
      budget: 'Menu à 40 €',
      message: 'Nous serons douze.',
      note: 'Un convive sans gluten',
    })
    expect(result.status).toBe('pending')
    expect(row).toMatchObject({
      status: 'pending',
      kind: 'group',
      channel: 'online',
      partySize: 12,
      guestNote: 'Un convive sans gluten',
    })
    expect(row.paymentTerms).toBeUndefined()
    expect(row.group).toMatchObject({
      occasion: 'Anniversaire',
      budget: 'Menu à 40 €',
      message: 'Nous serons douze.',
      requestedStartsAt: row.startsAt,
    })
    // The capacity is held for the review window, forty-eight hours here.
    expect(row.reviewExpiresAt!).toBeGreaterThanOrEqual(before + 48 * HOUR)
    expect(row.reviewExpiresAt!).toBeLessThan(before + 48 * HOUR + 60_000)
    expect(result.reviewExpiresAt).toBe(row.reviewExpiresAt)
    // Twelve covers across three tables of four, whether or not they are combinable.
    expect(row.tableIds.length).toBe(3)
    expect(await noticeKinds(t)).toEqual(['group_received'])
    expect((await eventRows(t)).map((e) => e.note)).toContain('group_requested')
  })

  test('holds its tables: nobody else can be sold what the request holds', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { slot, row } = await requestGroup(t, world, { partySize: 12 })
    // Three of six tables are held at that time; a party of four can still sit at the others…
    const remaining = await openSlots(t, world.storeId, 4)
    const sameTime = remaining.find((s) => s.startsAt === slot.startsAt)
    expect(sameTime).toBeDefined()
    // …but a second group of twelve cannot be given what the first holds plus what is left.
    const second = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 16,
    })
    expect(second.find((s) => s.startsAt === slot.startsAt)!.available).toBe(false)
    const taken = new Set(row.tableIds.map(String))
    const booked = await bookSlot(t, world, slot, { partySize: 4, email: 'autre@example.com' })
    const bookedRow = (await bookingByToken(t, booked.manageToken))!
    expect(bookedRow.tableIds.some((id) => taken.has(String(id)))).toBe(false)
  })

  test('refuses what cannot be requested, with a reason, and writes nothing', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const slot = (await openSlots(t, world.storeId, 12))[0]!
    const base = {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 12,
      guest,
      consentNoticeVersion: 'v1',
    }
    // The wrong wording version.
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.requestGroup, { ...base, consentNoticeVersion: 'v0' }),
      ),
    ).toBe('consent_required')
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.requestGroup, {
          ...base,
          privacyNoticeVersion: 'invented',
        }),
      ),
    ).toBe('consent_required')
    // A time no service offers.
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.requestGroup, {
          ...base,
          startsAt: slot.startsAt + 7 * 60_000,
        }),
      ),
    ).toBe('slot_unavailable')
    // A guest with no usable address.
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.requestGroup, {
          ...base,
          guest: { ...guest, email: 'not-an-address' },
        }),
      ),
    ).toBe('invalid_input')
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(0)
  })

  test('caps what a guest types into the three free fields', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const slot = (await openSlots(t, world.storeId, 12))[0]!
    const base = {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 12,
      guest,
      consentNoticeVersion: 'v1',
    }
    for (const over of [
      { occasion: 'x'.repeat(121) },
      { budget: 'x'.repeat(301) },
      { message: 'x'.repeat(1001) },
      { note: 'x'.repeat(501) },
    ]) {
      await expect(
        t.mutation(api.reservationGroups.requestGroup, { ...base, ...over }),
      ).rejects.toThrow()
    }
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(0)
  })

  test('is limited per address and the same key makes the same request', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const first = await requestGroup(t, world, { idempotencyKey: 'once' })
    const again = await requestGroup(t, world, { idempotencyKey: 'once', slotIndex: 1 })
    expect(again.result.manageToken).toBe(first.result.manageToken)
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(1)

    // Three an hour for one address, a replayed key included: the next day's request is the
    // third, and the one after it is stopped.
    await requestGroup(t, world, { date: dateIn(11) })
    await expect(requestGroup(t, world, { date: dateIn(12) })).rejects.toThrow()
  })

  test('is the first of the three bookings that a guest’s e-mail address can trigger: a party outside the policy asks for nothing', async () => {
    const t = newHarness()
    const world = await groupWorld(t, { policy: { enabled: false } })
    const slot = (await openSlots(t, world.storeId, 2))[0]!
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.requestGroup, {
          storeId: world.storeId,
          date: dateIn(10),
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: slot.startsAt,
          partySize: 12,
          guest,
          consentNoticeVersion: 'v1',
        }),
      ),
    ).toBe('group_not_offered')
  })
})

/* ------------------------------------------------------------------ */
/* The host accepts                                                    */
/* ------------------------------------------------------------------ */

describe('the host accepts a request', () => {
  test('without a payment: confirmed, the guest told, the tables kept', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, row } = await requestGroup(t, world)
    const result = await world.waiter.mutation(api.reservationGroups.approveGroup, {
      id,
      message: 'Avec plaisir.',
    })
    expect(result.status).toBe('confirmed')
    const after = (await rowOf(t, id))!
    expect(after.status).toBe('confirmed')
    expect(after.tableIds).toEqual(row.tableIds)
    expect(after.reviewExpiresAt).toBeUndefined()
    expect(after.group).toMatchObject({ hostMessage: 'Avec plaisir.' })
    expect(after.group!.decidedAt).toBeGreaterThan(0)
    expect(after.paymentTerms).toBeUndefined()
    expect(await noticeKinds(t)).toEqual(['group_received', 'group_approved'])
    expect((await eventRows(t)).map((e) => e.note)).toContain('group_approved')
    // The capacity it held is still its own: the guest is confirmed on those tables.
    expect(after.partySize).toBe(12)
  })

  test('with a deposit: held awaiting payment, the terms kept without an agreement, the link sent', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, token } = await requestGroup(t, world)
    const result = await world.manager.mutation(api.reservationGroups.approveGroup, {
      id,
      payment: { kind: 'deposit', amountCents: 24_000, freeCancellationHours: 72 },
    })
    expect(result.status).toBe('pending_payment')
    const after = (await rowOf(t, id))!
    expect(after.status).toBe('pending_payment')
    expect(after.paymentTerms).toMatchObject({
      kind: 'deposit',
      depositCents: 24_000,
      freeCancellationHours: 72,
      currency: 'EUR',
      purpose: 'group',
    })
    // The guest has not agreed to anything yet.
    expect(after.paymentTerms!.consentedAt).toBeUndefined()
    // Held for a day, no more, whatever the offer's own lifetime.
    const hold = after.paymentHoldExpiresAt!
    expect(hold).toBeGreaterThan(Date.now() + 23 * HOUR)
    expect(hold).toBeLessThanOrEqual(Date.now() + 24 * HOUR)
    expect(after.reviewExpiresAt).toBeUndefined()
    expect(await noticeKinds(t)).toEqual(['group_received', 'group_approved'])

    // The payment page asks for the agreement before any provider is reached.
    const page = (await t.query(api.reservationPayments.getPaymentPage, { token }))!
    expect(page.consentLabel).toMatch(/acompte de 240,00\s€.*mon groupe/)
    expect(page.purpose).toBe('group')
    expect(page.kind).toBe('group')
    expect(page.canPay).toBe(true)
  })

  test('is paid by an agreement and a provider’s word, and confirmed whatever the confirmation mode', async () => {
    const t = newHarness()
    // The house validates by hand: it already did, by accepting.
    const world = await groupWorld(t, { autoConfirm: false })
    const { id, token } = await requestGroup(t, world)
    await world.manager.mutation(api.reservationGroups.approveGroup, {
      id,
      payment: { kind: 'deposit', amountCents: 24_000 },
    })
    // Without the box ticked, no attempt is opened and no provider is reached.
    expect(await refusalCode(openAttempt(t, token))).toBe('payment_consent_required')
    expect(await refusalCode(openAttempt(t, token, { consent: false }))).toBe(
      'payment_consent_required',
    )
    expect(await paymentRows(t)).toHaveLength(0)

    const row = await payBooking(t, token, { consent: true })
    expect(row).toMatchObject({ kind: 'deposit', amount: 24_000, status: 'succeeded' })
    const paid = (await rowOf(t, id))!
    expect(paid.status).toBe('confirmed')
    expect(paid.paymentTerms!.consentedAt).toBeGreaterThan(0)
    expect(paid.paymentCollectedAt).toBeGreaterThan(0)
    expect(await noticeKinds(t)).toEqual(
      expect.arrayContaining(['group_received', 'group_approved', 'confirmed']),
    )
  })

  test('refunds the deposit in full when the host later cancels, and when the guest cancels in time', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, token } = await requestGroup(t, world)
    await world.manager.mutation(api.reservationGroups.approveGroup, {
      id,
      payment: { kind: 'deposit', amountCents: 24_000, freeCancellationHours: 72 },
    })
    await payBooking(t, token, { consent: true })
    await world.waiter.mutation(api.reservations.setStatus, { id, to: 'cancelled_by_restaurant' })
    expect((await dispatches(t)).filter((d) => d.type === 'refund')).toEqual([
      expect.objectContaining({ amount: 24_000 }),
    ])
  })

  test('needs the manager’s permission to attach money, never to answer', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    // A waiter may answer; attaching a deposit is the owner's.
    await expect(
      world.waiter.mutation(api.reservationGroups.approveGroup, {
        id,
        payment: { kind: 'deposit', amountCents: 24_000 },
      }),
    ).rejects.toThrow()
    expect((await rowOf(t, id))!.status).toBe('pending')
    await expect(
      world.waiter.mutation(api.reservationGroups.approveGroup, { id }),
    ).resolves.toMatchObject({ status: 'confirmed' })
  })

  test('refuses a payment no connected provider can honour, with the reason, and answers nothing', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    // A guarantee through Stripe is honoured; an amount out of bounds is not.
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationGroups.approveGroup, {
          id,
          payment: { kind: 'deposit', amountCents: 50 },
        }),
      ),
    ).toMatch(/Acompte/)
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationGroups.approveGroup, {
          id,
          payment: { kind: 'deposit', amountCents: 24_000, freeCancellationHours: 9999 },
        }),
      ),
    ).toMatch(/annulation/)
    expect((await rowOf(t, id))!.status).toBe('pending')
    await expect(
      world.manager.mutation(api.reservationGroups.approveGroup, {
        id,
        payment: { kind: 'guarantee', amountCents: 8000 },
      }),
    ).resolves.toMatchObject({ status: 'pending_payment' })
    const guarantee = (await rowOf(t, id))!
    expect(guarantee.paymentTerms).toMatchObject({ kind: 'guarantee', noShowFeeCents: 8000 })
    expect(guarantee.paymentTerms!.depositCents).toBe(0)
  })

  test('refuses a payment while the establishment takes no cards', async () => {
    const t = newHarness()
    await setupGlobalSettings(t, { cardProvider: 'none', paypal: false })
    const world = await seedWorld(t, { looseTables: 6 })
    await saveGroupPolicy(world)
    const { id } = await requestGroup(t, world)
    expect(
      await refusalMessage(
        world.manager.mutation(api.reservationGroups.approveGroup, {
          id,
          payment: { kind: 'deposit', amountCents: 24_000 },
        }),
      ),
    ).toMatch(/ne pas accepter les cartes/)
    // Accepting without money still works.
    await expect(
      world.manager.mutation(api.reservationGroups.approveGroup, { id }),
    ).resolves.toMatchObject({ status: 'confirmed' })
  })

  test('may seat the group on tables the host picks, but never on ones another booking holds', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, row, slot } = await requestGroup(t, world)
    const mine = new Set(row.tableIds.map(String))
    const others = Object.entries(world.tables).filter(([, tableId]) => !mine.has(String(tableId)))
    // Another party sits at one of the free tables at the same time.
    const booked = await bookSlot(t, world, slot, { partySize: 2, email: 'voisin@example.com' })
    const neighbour = (await bookingByToken(t, booked.manageToken))!
    const taken = neighbour.tableIds[0]!
    const free = others.map(([, tableId]) => tableId).filter((tableId) => tableId !== taken)
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationGroups.approveGroup, {
          id,
          tableIds: [taken, ...free.slice(0, 2)],
        }),
      ),
    ).toBe('table_conflict')
    expect((await rowOf(t, id))!.status).toBe('pending')

    await world.waiter.mutation(api.reservationGroups.approveGroup, {
      id,
      tableIds: free.slice(0, 3),
    })
    expect(new Set((await rowOf(t, id))!.tableIds.map(String))).toEqual(
      new Set(free.slice(0, 3).map(String)),
    )
  })

  test('refuses a request that is not open: already answered, or not a group at all', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    await world.waiter.mutation(api.reservationGroups.approveGroup, { id })
    expect(
      await refusalCode(world.waiter.mutation(api.reservationGroups.approveGroup, { id })),
    ).toBe('group_request_closed')
    expect(
      await refusalCode(world.waiter.mutation(api.reservationGroups.declineGroup, { id })),
    ).toBe('group_request_closed')
    const slot = (await openSlots(t, world.storeId, 2))[0]!
    const booked = await bookSlot(t, world, slot, { partySize: 2, email: 'deux@example.com' })
    const ordinary = (await bookingByToken(t, booked.manageToken))!
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationGroups.approveGroup, { id: ordinary._id }),
      ),
    ).toBe('invalid_input')
  })

  test('is checked against the right establishment: a team member of another cannot answer', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const other = await seedWorld(t, { looseTables: 2, profiles: false })
    await t.run((ctx) =>
      ctx.db.insert('userProfiles', {
        userId: 'stranger',
        role: 'client_admin',
        storeIds: [other.storeId],
        permissions: [],
        language: 'fr',
        twoFactorEnabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    const { id } = await requestGroup(t, world)
    await expect(
      t.withIdentity({ subject: 'stranger' }).mutation(api.reservationGroups.approveGroup, { id }),
    ).rejects.toThrow()
    expect((await rowOf(t, id))!.status).toBe('pending')
  })
})

/* ------------------------------------------------------------------ */
/* The host refuses                                                    */
/* ------------------------------------------------------------------ */

describe('the host refuses a request', () => {
  test('declined with a reason, the guest told, the capacity released', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, slot, row } = await requestGroup(t, world)
    const result = await world.waiter.mutation(api.reservationGroups.declineGroup, {
      id,
      reason: 'Salle privatisée ce soir-là.',
    })
    expect(result.status).toBe('declined')
    const after = (await rowOf(t, id))!
    expect(after).toMatchObject({ status: 'declined' })
    expect(after.group).toMatchObject({ hostMessage: 'Salle privatisée ce soir-là.' })
    expect(after.reviewExpiresAt).toBeUndefined()
    expect(await noticeKinds(t)).toEqual(['group_received', 'group_declined'])
    // The tables go back to the public.
    const sixteen = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 16,
    })
    expect(sixteen.find((s) => s.startsAt === slot.startsAt)!.available).toBe(true)
    expect(row.tableIds.length).toBe(3)
  })

  test('says nothing about money, and needs no reason', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    await world.waiter.mutation(api.reservationGroups.declineGroup, { id })
    expect((await rowOf(t, id))!.group!.hostMessage).toBeUndefined()
    expect(await dispatches(t)).toEqual([])
  })

  test('caps the reason', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    await expect(
      world.waiter.mutation(api.reservationGroups.declineGroup, { id, reason: 'x'.repeat(501) }),
    ).rejects.toThrow()
    expect((await rowOf(t, id))!.status).toBe('pending')
  })
})

/* ------------------------------------------------------------------ */
/* Another time                                                        */
/* ------------------------------------------------------------------ */

describe('the host proposes another time', () => {
  async function proposal(t: Harness, world: World, extra: Record<string, unknown> = {}) {
    const requested = await requestGroup(t, world)
    const later = await otherSlot(t, world, 12, requested.slot.startsAt)
    const result = await world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
      id: requested.id,
      date: dateIn(10),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
      note: 'Nous pouvons vous accueillir plus tard.',
      ...extra,
    })
    return { ...requested, later, result }
  }

  test('moves the booking, and so the held capacity, to the slot the engine just checked', async () => {
    const t = newHarness()
    const world = await groupWorld(t, { policy: { proposalHours: 6 } })
    const { id, slot, later, row } = await proposal(t, world)
    const after = (await rowOf(t, id))!
    expect(after.status).toBe('pending')
    expect(after.startsAt).toBe(later.startsAt)
    expect(after.startsAt).not.toBe(slot.startsAt)
    expect(after.endsAt).toBeGreaterThan(after.startsAt)
    // What the guest asked for is kept; the offer carries its own lifetime.
    expect(after.group!.requestedStartsAt).toBe(row.startsAt)
    expect(after.group!.proposal).toMatchObject({ note: 'Nous pouvons vous accueillir plus tard.' })
    const lifetime = after.group!.proposal!.expiresAt - after.group!.proposal!.at
    expect(lifetime).toBe(6 * HOUR)
    // The hold follows the offer.
    expect(after.reviewExpiresAt).toBe(after.group!.proposal!.expiresAt)
    expect(await noticeKinds(t)).toEqual(['group_received', 'group_counter'])
    expect((await eventRows(t)).map((e) => e.note)).toContain('group_counter')

    // The old slot is free again, the new one is held.
    const sixteen = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 16,
    })
    expect(sixteen.find((s) => s.startsAt === slot.startsAt)!.available).toBe(true)
    expect(sixteen.find((s) => s.startsAt === later.startsAt)!.available).toBe(false)
  })

  test('lists the slots the engine would accept, the request’s own tables offered again', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, slot } = await requestGroup(t, world)
    const slots = await world.waiter.query(api.reservationGroups.groupSlots, {
      id,
      date: dateIn(10),
    })
    // The slot it holds is open to it, and so is every other time the room can seat twelve.
    expect(slots.find((s) => s.startsAt === slot.startsAt)!.available).toBe(true)
    expect(slots.every((s) => s.available)).toBe(true)
    // A request elsewhere holds most of the room at the late time: it is refused, with the reason.
    await requestGroup(t, world, { email: 'autre@example.com', partySize: 16 })
    const after = await world.waiter.query(api.reservationGroups.groupSlots, {
      id,
      date: dateIn(10),
    })
    expect(after.filter((s) => !s.available).every((s) => s.reason === 'no_table')).toBe(true)
    expect(after.some((s) => !s.available)).toBe(true)
    // Not for a booking that is not an open group request.
    const ordinary = (await openSlots(t, world.storeId, 2))[0]!
    const booked = await bookSlot(t, world, ordinary, { partySize: 2, email: 'deux@example.com' })
    const row = (await bookingByToken(t, booked.manageToken))!
    expect(
      await refusalCode(
        world.waiter.query(api.reservationGroups.groupSlots, { id: row._id, date: dateIn(10) }),
      ),
    ).toBe('invalid_input')
  })

  test('refuses the time already asked for, a time the engine cannot give, and an open request that is not a group', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, slot } = await requestGroup(t, world)
    expect(
      await refusalMessage(
        world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
          id,
          date: dateIn(10),
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: slot.startsAt,
        }),
      ),
    ).toMatch(/déjà demandé/)
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
          id,
          date: dateIn(10),
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: slot.startsAt + 7 * 60_000,
        }),
      ),
    ).toBe('slot_unavailable')
    // Another request holds most of the room at the later time: no proposal can be made there.
    const late = (await openSlots(t, world.storeId, 12)).find(
      (s) => Math.abs(s.startsAt - slot.startsAt) >= 90 * 60_000,
    )!
    await requestGroup(t, world, { email: 'autre@example.com', partySize: 16 })
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
          id,
          date: dateIn(10),
          serviceId: late.serviceId as Id<'reservationServices'>,
          startsAt: late.startsAt,
        }),
      ),
    ).toBe('slot_unavailable')
    expect((await rowOf(t, id))!.group!.proposal).toBeUndefined()
  })

  test('replaces an offer still open, and says so with a new e-mail', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, later } = await proposal(t, world)
    // The first offer holds the room at the later time; offering the first slot again is
    // another time than the one now proposed, and replaces it.
    const slots = await openSlots(t, world.storeId, 12)
    const again = slots.find((s) => s.startsAt !== later.startsAt)!
    await world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
      id,
      date: dateIn(10),
      serviceId: again.serviceId as Id<'reservationServices'>,
      startsAt: again.startsAt,
    })
    expect((await rowOf(t, id))!.startsAt).toBe(again.startsAt)
    expect((await noticeKinds(t)).filter((kind) => kind === 'group_counter')).toHaveLength(2)
  })

  test('cannot be accepted by the host in the guest’s place while the offer is open', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await proposal(t, world)
    expect(
      await refusalMessage(world.waiter.mutation(api.reservationGroups.approveGroup, { id })),
    ).toMatch(/contre-proposition/)
  })

  test('may carry the payment the guest will owe, but only from the manager', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const requested = await requestGroup(t, world)
    const later = await otherSlot(t, world, 12, requested.slot.startsAt)
    const args = {
      id: requested.id,
      date: dateIn(10),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
      payment: { kind: 'deposit' as const, amountCents: 18_000, freeCancellationHours: 48 },
    }
    await expect(
      world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, args),
    ).rejects.toThrow()
    await world.manager.mutation(api.reservationGroups.proposeGroupAlternative, args)
    expect((await rowOf(t, requested.id))!.group!.proposal!.terms).toEqual({
      kind: 'deposit',
      depositCents: 18_000,
      noShowFeeCents: 0,
      freeCancellationHours: 48,
    })
  })

  test('is accepted from the guest’s link: confirmed, or held for the payment it carries', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, token } = await proposal(t, world)
    const view = (await t.query(api.reservations.getByToken, { token }))!
    expect(view.kind).toBe('group')
    expect(view.group!.state).toBe('proposal')
    expect(view.group!.proposal).toMatchObject({
      note: 'Nous pouvons vous accueillir plus tard.',
      lapsed: false,
    })
    expect(view.canModify).toBe(false)
    const result = await t.mutation(api.reservationGroups.respondToProposal, {
      token,
      accept: true,
    })
    expect(result.status).toBe('confirmed')
    const after = (await rowOf(t, id))!
    expect(after.status).toBe('confirmed')
    expect(after.group!.proposal).toBeUndefined()
    expect(after.reviewExpiresAt).toBeUndefined()
    expect(await noticeKinds(t)).toEqual(['group_received', 'group_counter', 'group_approved'])
  })

  test('is accepted with a payment due: awaiting it, the terms without an agreement yet', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const requested = await requestGroup(t, world)
    const later = await otherSlot(t, world, 12, requested.slot.startsAt)
    await world.manager.mutation(api.reservationGroups.proposeGroupAlternative, {
      id: requested.id,
      date: dateIn(10),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
      payment: { kind: 'deposit', amountCents: 18_000, freeCancellationHours: 48 },
    })
    const view = (await t.query(api.reservations.getByToken, { token: requested.token }))!
    expect(view.group!.proposal!.terms).toMatchObject({ kind: 'deposit', depositCents: 18_000 })
    expect(view.group!.proposal!.terms!.lines[0]).toMatch(/votre groupe/)
    await t.mutation(api.reservationGroups.respondToProposal, {
      token: requested.token,
      accept: true,
    })
    const after = (await rowOf(t, requested.id))!
    expect(after.status).toBe('pending_payment')
    expect(after.paymentTerms).toMatchObject({ depositCents: 18_000, purpose: 'group' })
    expect(after.paymentTerms!.consentedAt).toBeUndefined()
    expect(after.paymentHoldExpiresAt!).toBeGreaterThan(Date.now())
  })

  test('is refused from the guest’s link: their own cancellation, the tables released', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, token, later } = await proposal(t, world)
    const result = await t.mutation(api.reservationGroups.respondToProposal, {
      token,
      accept: false,
    })
    expect(result.status).toBe('cancelled_by_guest')
    expect((await rowOf(t, id))!.status).toBe('cancelled_by_guest')
    const sixteen = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 16,
    })
    expect(sixteen.find((s) => s.startsAt === later.startsAt)!.available).toBe(true)
  })

  test('cannot be answered once it lapsed, twice, or without an offer', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const requested = await requestGroup(t, world)
    // No offer was made.
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.respondToProposal, {
          token: requested.token,
          accept: true,
        }),
      ),
    ).toBe('proposal_unavailable')
    const later = await otherSlot(t, world, 12, requested.slot.startsAt)
    await world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
      id: requested.id,
      date: dateIn(10),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
    })
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(requested.id))!
      await ctx.db.patch(requested.id, {
        group: { ...row.group!, proposal: { ...row.group!.proposal!, expiresAt: Date.now() - 1 } },
      })
    })
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.respondToProposal, {
          token: requested.token,
          accept: true,
        }),
      ),
    ).toBe('proposal_unavailable')
    const view = (await t.query(api.reservations.getByToken, { token: requested.token }))!
    expect(view.group!.state).toBe('proposal_lapsed')
    expect(
      await refusalCode(
        t.mutation(api.reservationGroups.respondToProposal, {
          token: 'unknown-token-123',
          accept: true,
        }),
      ),
    ).toBe('invalid_input')
  })
})

/* ------------------------------------------------------------------ */
/* Letting a request go                                                */
/* ------------------------------------------------------------------ */

describe('a request nobody answered', () => {
  test('releases its capacity when the review window runs out, and tells the guest', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, slot } = await requestGroup(t, world)
    // Inside the window nothing moves.
    const early = await t.mutation(internal.reservationGroups.expireReviews, {})
    expect(early).toMatchObject({ expired: 0 })
    expect((await rowOf(t, id))!.status).toBe('pending')

    await t.run((ctx) => ctx.db.patch(id, { reviewExpiresAt: Date.now() - 1 }))
    const late = await t.mutation(internal.reservationGroups.expireReviews, {})
    expect(late).toMatchObject({ expired: 1 })
    const after = (await rowOf(t, id))!
    expect(after.status).toBe('expired')
    expect(after.reviewExpiresAt).toBeUndefined()
    expect(await noticeKinds(t)).toEqual(['group_received', 'group_expired'])
    const sixteen = await t.query(api.reservations.getAvailability, {
      storeId: world.storeId,
      date: dateIn(10),
      partySize: 16,
    })
    expect(sixteen.find((s) => s.startsAt === slot.startsAt)!.available).toBe(true)
  })

  test('leaves an answered request, an ordinary booking and an unpaid hold alone', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const approved = await requestGroup(t, world)
    await world.waiter.mutation(api.reservationGroups.approveGroup, { id: approved.id })
    const ordinarySlot = (await openSlots(t, world.storeId, 2))[0]!
    await bookSlot(t, world, ordinarySlot, { partySize: 2, email: 'deux@example.com' })
    const result = await t.mutation(internal.reservationGroups.expireReviews, {})
    expect(result.expired).toBe(0)
    expect((await rowOf(t, approved.id))!.status).toBe('confirmed')
  })

  test('closes a counter-proposal the guest let lapse, by the offer’s own lifetime', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const requested = await requestGroup(t, world)
    const later = await otherSlot(t, world, 12, requested.slot.startsAt)
    await world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
      id: requested.id,
      date: dateIn(10),
      serviceId: later.serviceId as Id<'reservationServices'>,
      startsAt: later.startsAt,
    })
    await t.run((ctx) => ctx.db.patch(requested.id, { reviewExpiresAt: Date.now() - 1 }))
    await t.mutation(internal.reservationGroups.expireReviews, {})
    expect((await rowOf(t, requested.id))!.status).toBe('expired')
  })

  test('says it has more to do when a backlog exceeds one run', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    // 205 requests past their window: one run takes 200 and says so.
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!
      const { _id, _creationTime, ...rest } = row
      void _id
      void _creationTime
      for (let i = 0; i < 204; i++) {
        await ctx.db.insert('reservations', {
          ...rest,
          reference: `RES-BULK-${i}`,
          manageToken: `bulk-token-${String(i).padStart(6, '0')}`,
          reviewExpiresAt: Date.now() - 1,
          tableIds: [],
        })
      }
      await ctx.db.patch(id, { reviewExpiresAt: Date.now() - 1 })
    })
    const first = await t.mutation(internal.reservationGroups.expireReviews, {})
    expect(first).toMatchObject({ expired: 200 })
    // It schedules itself to take the rest, a minute on.
    expect(
      (await scheduled(t)).filter((job) => job.name.endsWith('reservationGroups:expireReviews')),
    ).toHaveLength(1)
    const second = await t.mutation(internal.reservationGroups.expireReviews, {})
    expect(second).toMatchObject({ expired: 5 })
    expect(
      (await scheduled(t)).filter((job) => job.name.endsWith('reservationGroups:expireReviews')),
    ).toHaveLength(1)
  })

  test('is also closed, with its own words, when the party’s own time has passed', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    await t.run((ctx) =>
      ctx.db.patch(id, { startsAt: Date.now() - 2 * HOUR, endsAt: Date.now() - HOUR }),
    )
    await t.mutation(internal.reservations.expireUnanswered, {})
    expect((await rowOf(t, id))!.status).toBe('expired')
    expect(await noticeKinds(t)).toContain('group_expired')
  })

  test('is closed by the payment hold when an accepted deposit is never paid', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    await world.manager.mutation(api.reservationGroups.approveGroup, {
      id,
      payment: { kind: 'deposit', amountCents: 24_000 },
    })
    await t.run((ctx) => ctx.db.patch(id, { paymentHoldExpiresAt: Date.now() - 1 }))
    const lapsed = await t.query(internal.reservationPayments.lapsedHolds, {})
    expect(lapsed).toHaveLength(1)
    await t.mutation(internal.reservationPayments.expireLapsed, {
      reservationIds: lapsed.map((l) => l.reservationId as Id<'reservations'>),
    })
    expect((await rowOf(t, id))!.status).toBe('expired')
    expect(await noticeKinds(t)).toContain('group_expired')
  })
})

/* ------------------------------------------------------------------ */
/* The guest's page, the host's list                                   */
/* ------------------------------------------------------------------ */

describe('what is read about a request', () => {
  test('the guest sees what they asked, where it stands and until when, and cannot edit it', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { token, row } = await requestGroup(t, world, { occasion: 'Mariage', message: 'Bonjour' })
    const view = (await t.query(api.reservations.getByToken, { token }))!
    expect(view.kind).toBe('group')
    expect(view.group).toMatchObject({
      state: 'review',
      occasion: 'Mariage',
      message: 'Bonjour',
      requestedStartsAt: row.startsAt,
      reviewExpiresAt: row.reviewExpiresAt,
      proposal: null,
    })
    expect(view.canModify).toBe(false)
    expect(view.canCancel).toBe(true)
    // Nothing the team keeps to itself.
    expect(JSON.stringify(view)).not.toMatch(/internalNote|tableIds|manageToken/)
  })

  test('the guest cannot change a request from their link, and cancels it like any booking', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { token, slot } = await requestGroup(t, world)
    expect(
      await refusalCode(
        t.mutation(api.reservations.modifyByToken, {
          token,
          date: dateIn(10),
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: slot.startsAt,
          partySize: 10,
        }),
      ),
    ).toBe('change_closed')
    const cancelled = await t.mutation(api.reservations.cancelByToken, { token })
    expect(cancelled.status).toBe('cancelled_by_guest')
  })

  test('an ordinary booking cannot become a group by being edited', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const slot = (await openSlots(t, world.storeId, 2))[0]!
    const booked = await bookSlot(t, world, slot, { partySize: 4 })
    expect(
      await refusalCode(
        t.mutation(api.reservations.modifyByToken, {
          token: booked.manageToken,
          date: dateIn(10),
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: slot.startsAt,
          partySize: 12,
        }),
      ),
    ).toBe('group_not_offered')
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailabilityByToken, {
          token: booked.manageToken,
          date: dateIn(10),
          partySize: 12,
        }),
      ),
    ).toBe('group_not_offered')
  })

  test('the host’s list puts what waits first, with the guest’s words and contact, and nothing for a stranger', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const waiting = await requestGroup(t, world, { occasion: 'Séminaire', email: 'a@example.com' })
    const answered = await requestGroup(t, world, { slotIndex: 2, email: 'b@example.com' })
    await world.waiter.mutation(api.reservationGroups.approveGroup, { id: answered.id })
    const list = await world.waiter.query(api.reservationGroups.listGroupRequests, {
      storeId: world.storeId,
    })
    expect(list.truncated).toBe(false)
    expect(list.waiting).toBe(1)
    expect(list.requests.map((r) => r.id)).toEqual([String(waiting.id), String(answered.id)])
    expect(list.requests[0]).toMatchObject({
      state: 'review',
      stateLabel: 'À traiter',
      guestEmail: 'a@example.com',
      guestPhone: guest.phone,
      occasion: 'Séminaire',
      partySize: 12,
      payment: null,
    })
    expect(list.requests[1]).toMatchObject({ state: 'approved', stateLabel: 'Acceptée' })
    expect(list.requests[0]!.tableNames.length).toBe(3)

    const other = await seedWorld(t, { looseTables: 1, profiles: false })
    await t.run((ctx) =>
      ctx.db.insert('userProfiles', {
        userId: 'stranger',
        role: 'client_admin',
        storeIds: [other.storeId],
        permissions: [],
        language: 'fr',
        twoFactorEnabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    await expect(
      t.withIdentity({ subject: 'stranger' }).query(api.reservationGroups.listGroupRequests, {
        storeId: world.storeId,
      }),
    ).rejects.toThrow()
  })

  test('the host’s list shows the payment of an accepted request and where it stands', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, token } = await requestGroup(t, world)
    await world.manager.mutation(api.reservationGroups.approveGroup, {
      id,
      payment: { kind: 'deposit', amountCents: 24_000 },
    })
    let list = await world.waiter.query(api.reservationGroups.listGroupRequests, {
      storeId: world.storeId,
    })
    expect(list.requests[0]).toMatchObject({
      state: 'awaiting_payment',
      payment: {
        kind: 'deposit',
        depositCents: 24_000,
        consented: false,
        label: 'Paiement en attente',
      },
    })
    await payBooking(t, token, { consent: true })
    list = await world.waiter.query(api.reservationGroups.listGroupRequests, {
      storeId: world.storeId,
    })
    expect(list.requests[0]).toMatchObject({
      state: 'approved',
      payment: { consented: true, state: 'paid', label: 'Acompte payé' },
    })
  })

  test('the approval dialog is told which tables are free, the rooms, and what the policy would have asked', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    await world.manager.mutation(api.reservationPayments.savePaymentPolicy, {
      storeId: world.storeId,
      enabled: true,
      rules: [
        { id: 'r1', kind: 'deposit', deposit: { mode: 'per_cover', cents: 1500 }, minPartySize: 8 },
      ],
      freeCancellationHours: 36,
      holdMinutes: 15,
    })
    const { id, slot } = await requestGroup(t, world)
    const booked = await bookSlot(t, world, slot, { partySize: 2, email: 'voisin@example.com' })
    const neighbour = (await bookingByToken(t, booked.manageToken))!
    const options = await world.waiter.query(api.reservationGroups.getApprovalOptions, { id })
    expect(options.partySize).toBe(12)
    expect(options.capacityMode).toBe('tables')
    expect(options.tables).toHaveLength(6)
    expect(options.tables.filter((table) => table.assigned)).toHaveLength(3)
    // The neighbour's table is not free for this window.
    const taken = options.tables.find((table) => table.id === String(neighbour.tableIds[0]))!
    expect(taken.free).toBe(false)
    expect(options.payment).toMatchObject({
      currency: 'EUR',
      cardsRefused: false,
      defaultFreeCancellationHours: 36,
      holdHours: 24,
      suggestion: { kind: 'deposit', cents: 18_000 },
    })
    expect(options.payment.providers.map((p) => p.provider)).toEqual(['stripe'])
  })
})

/* ------------------------------------------------------------------ */
/* The policy                                                          */
/* ------------------------------------------------------------------ */

describe('the policy', () => {
  test('is read by the team and saved by the manager only', async () => {
    const t = newHarness()
    const world = await groupWorld(t, { policy: false })
    const empty = await world.waiter.query(api.reservationGroups.getGroupPolicy, {
      storeId: world.storeId,
    })
    expect(empty.policy.enabled).toBe(false)
    await expect(
      saveGroupPolicy({ manager: world.waiter, storeId: world.storeId }),
    ).rejects.toThrow()
    await saveGroupPolicy(world, { threshold: 10, maxSize: 25 })
    const saved = await world.waiter.query(api.reservationGroups.getGroupPolicy, {
      storeId: world.storeId,
    })
    expect(saved.policy).toMatchObject({ enabled: true, threshold: 10, maxSize: 25 })
    expect(saved.bands).toEqual({ directMax: 8, groupMin: 9, groupMax: 25 })
  })

  test('is refused with the sentence that says why, and replaced rather than stacked', async () => {
    const t = newHarness()
    const world = await groupWorld(t, { policy: false })
    expect(await refusalMessage(saveGroupPolicy(world, { threshold: 1 }))).toMatch(
      /taille à partir de laquelle/,
    )
    expect(await refusalMessage(saveGroupPolicy(world, { maxSize: 4, threshold: 9 }))).toMatch(
      /au moins égale/,
    )
    expect(await refusalMessage(saveGroupPolicy(world, { reviewHours: 0 }))).toMatch(
      /délai de réponse/,
    )
    expect(await t.run((ctx) => ctx.db.query('reservationGroupPolicy').collect())).toHaveLength(0)
    // Switching off is never blocked by the figures behind it.
    await expect(
      saveGroupPolicy(world, { enabled: false, threshold: 0, maxSize: 0, reviewHours: 0 }),
    ).resolves.toBeDefined()
    await saveGroupPolicy(world, { threshold: 12 })
    await saveGroupPolicy(world, { threshold: 11 })
    expect(await t.run((ctx) => ctx.db.query('reservationGroupPolicy').collect())).toHaveLength(1)
  })

  test('says, without refusing, that a threshold above the online ceiling starts after it', async () => {
    const t = newHarness()
    const world = await groupWorld(t, { policy: false })
    const saved = await saveGroupPolicy(world, { threshold: 15 })
    expect(saved.notes[0]).toMatch(/commencera donc à 9 personnes/)
    const config = (await t.query(api.reservations.getPublicConfig, { storeId: world.storeId }))!
    expect(config.groups!.minSize).toBe(9)
    expect(config.directMax).toBe(8)
  })

  test('does not wipe when the rules form is saved, and is not wiped by it', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const settings = await t.run((ctx) => ctx.db.query('reservationSettings').first())
    const { _id, _creationTime, updatedAt, ...rest } = settings!
    void _id
    void _creationTime
    void updatedAt
    await world.manager.mutation(api.reservations.saveSettings, { ...rest, maxPartySize: 6 })
    const policy = await world.waiter.query(api.reservationGroups.getGroupPolicy, {
      storeId: world.storeId,
    })
    expect(policy.policy).toMatchObject({ enabled: true, threshold: 9 })
    // The ceiling moved below the threshold: the bands closed up behind it, with no gap.
    expect(policy.bands).toEqual({ directMax: 6, groupMin: 7, groupMax: 20 })
  })
})

/* ------------------------------------------------------------------ */
/* Personal data                                                       */
/* ------------------------------------------------------------------ */

describe('what an erasure does to a request', () => {
  test('deletes outright a request on which no money moved, history and note included', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world, {
      occasion: 'Mariage',
      message: 'Secret',
      note: 'noix',
    })
    await world.waiter.mutation(api.reservationGroups.approveGroup, { id })
    await eraseFully(t, world.manager, guest.email)
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('reservationEvents').collect())).toHaveLength(0)
  })

  test('keeps a paid request for the accounts, without a word the guest wrote', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id, token } = await requestGroup(t, world, {
      occasion: 'Mariage de Léa',
      budget: '50 € par personne',
      message: 'Pour Mme Durand',
      note: 'allergie noix',
    })
    await world.manager.mutation(api.reservationGroups.approveGroup, {
      id,
      message: 'Table au nom de Durand',
      payment: { kind: 'deposit', amountCents: 24_000 },
    })
    await payBooking(t, token, { consent: true })
    await eraseFully(t, world.manager, guest.email)
    const kept = (await rowOf(t, id))!
    expect(kept).toMatchObject({
      guestName: expect.not.stringContaining('Dupont'),
      guestEmail: '',
      guestPhone: '',
    })
    expect(kept.guestNote).toBeUndefined()
    // What the guest wrote, and what the host wrote back about them, is gone; when it was
    // asked for and answered stays, with the money.
    expect(kept.group).toEqual({
      requestedStartsAt: expect.any(Number),
      decidedAt: expect.any(Number),
    })
    expect(kept.paymentTerms!.depositCents).toBe(24_000)
    expect(kept.manageToken).not.toBe(token)
    expect(JSON.stringify(kept)).not.toMatch(/Mariage|Durand|noix|50 €/)
  })

  test('exports what a guest wrote, with the booking', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    await requestGroup(t, world, { occasion: 'Mariage', budget: 'Menu à 45 €', message: 'Bonjour' })
    const exported = await world.manager.query(api.privacy.exportDataSubject, {
      email: guest.email,
    })
    const text = JSON.stringify(exported)
    expect(text).toMatch(/Mariage/)
    expect(text).toMatch(/Menu à 45 €/)
    expect(text).toMatch(/group_requested/)
  })
})

/* ------------------------------------------------------------------ */
/* The rest of the module sees a group like any booking                */
/* ------------------------------------------------------------------ */

describe('a group in the rest of the module', () => {
  test('is a booking made in the statistics, like any other, once it stands', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    await world.waiter.mutation(api.reservationGroups.approveGroup, { id })
    const day = dateIn(10)
    await world.manager.mutation(api.reservationStats.rebuild, {
      storeId: world.storeId,
      from: day,
      to: day,
    })
    for (let i = 0; i < 10; i++) {
      const { hasMore } = await t.mutation(internal.reservationStats.sweepDirty, {})
      if (!hasMore) break
    }
    const rows = await t.run((ctx) => ctx.db.query('reservationStatsDaily').collect())
    const row = rows.find((r) => r.date === day)!
    expect(row.channels.online).toEqual({ bookings: 1, covers: 12 })
    expect(row.statusCounts.confirmed).toBe(1)
  })

  test('shows in the day book with its kind, so the host can filter on it', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    const { id } = await requestGroup(t, world)
    const day = await world.waiter.query(api.reservations.listDay, {
      storeId: world.storeId,
      date: dateIn(10),
    })
    const found = day.find((row) => row._id === id)!
    expect(found.kind).toBe('group')
    expect(found.group!.requestedStartsAt).toBe(found.startsAt)
    expect(found.status).toBe('pending')
  })

  test('no notice is scheduled for a booking that never needed one: nothing leaks to the scheduler', async () => {
    const t = newHarness()
    const world = await groupWorld(t)
    await requestGroup(t, world)
    const names = (await scheduled(t)).map((job) => job.name)
    expect(names.every((name) => /customerEmail|reservation|emailAutomation/.test(name))).toBe(true)
  })
})
