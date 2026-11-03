// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Second review, findings 2, 3 and 8: the team's edit paths and the group answers.
 *
 *  2. a ticket for a limited-seat event is edited, and moved, only from the event: the
 *     party-size edit oversold the seats unpaid, and a time edit handed the ticket a table
 *     that regular parties then double-booked;
 *  3. a group request is answered through the group functions only: a lapsed counter-proposal
 *     is never approved at a time the guest did not accept, and `setStatus` cannot confirm
 *     over an open proposal;
 *  8. a manager's override that names no tables must not keep the old tables at a new time
 *     they do not hold.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { wallClockToInstant } from '@be-yours/convex-schema'
import {
  bookSlot,
  createHarnessFactory,
  dateIn,
  guest,
  openSlots,
  refusalCode,
  seedWorld,
  type Harness,
} from './reservation-fixtures'
import {
  bookingByToken,
  noticeKinds,
  saveGroupPolicy,
  setupGlobalSettings,
  stubPaymentWorld,
  unstubPaymentWorld,
} from './reservation-phase5-fixtures'

const newHarness = createHarnessFactory()
beforeEach(stubPaymentWorld)
afterEach(unstubPaymentWorld)

const at = (days: number, time: string) =>
  wallClockToInstant(dateIn(days), time, 'Europe/Paris')!.at

/* ------------------------------------------------------------------ */
/* 2 — tickets are not edited like tables                              */
/* ------------------------------------------------------------------ */

async function ticketWorld(mode: 'covers' | 'tables') {
  const t = newHarness()
  await setupGlobalSettings(t)
  const world = await seedWorld(t, {
    capacityMode: mode,
    autoConfirm: true,
    rooms: [{ name: 'Salle', tables: 6 }],
  })
  const { id } = await world.manager.mutation(api.reservationExperiences.saveExperience, {
    storeId: world.storeId,
    title: 'Soirée',
    description: 'x',
    startsAt: at(14, '19:00'),
    endsAt: at(14, '21:00'),
    seats: 4,
    priceCents: 0,
    cancellationCutoffHours: 48,
    maxSeatsPerBooking: 4,
  } as never)
  await world.manager.mutation(api.reservationExperiences.publishExperience, { id })
  await t.mutation(api.reservationExperiences.buy, {
    experienceId: id,
    seats: 4,
    guest,
    consentNoticeVersion: 'v1',
  } as never)
  const ticket = (await t.run((ctx) => ctx.db.query('reservations').collect())).find(
    (r) => r.kind === 'experience',
  )!
  return { t, world, id, ticket }
}

describe('a ticket is edited from its event, not from the day book', () => {
  test('a waiter cannot raise a ticket past the seats on sale', async () => {
    const { t, world, id, ticket } = await ticketWorld('covers')
    const code = await refusalCode(
      world.waiter.mutation(api.reservations.updateByStaff, {
        id: ticket._id,
        date: dateIn(14),
        serviceId: world.serviceId,
        startsAt: at(14, '19:00'),
        partySize: 8,
      }),
    )
    expect(code).toBe('ticket_not_editable')
    expect((await t.run((ctx) => ctx.db.get(ticket._id)))!.partySize).toBe(4)
    const list = await world.manager.query(api.reservationExperiences.listAttendees, { id })
    expect(JSON.stringify(list.seatsByStatus)).not.toMatch(/8/)
  })

  test('a ticket cannot be moved to a time where it would receive a table', async () => {
    const { t, world, ticket } = await ticketWorld('tables')
    const before = async () => {
      let booked = 0
      for (let i = 0; i < 6; i++) {
        const code = await refusalCode(
          bookSlot(
            t,
            world,
            { serviceId: world.serviceId, startsAt: at(14, '19:30') },
            { partySize: 4, date: dateIn(14), email: `p${i}@example.com` },
          ),
        )
        if (code === undefined) booked++
      }
      return booked
    }
    const code = await refusalCode(
      world.waiter.mutation(api.reservations.updateByStaff, {
        id: ticket._id,
        date: dateIn(14),
        serviceId: world.serviceId,
        startsAt: at(14, '19:30'),
        partySize: 4,
      }),
    )
    expect(code).toBe('ticket_not_editable')
    const row = (await t.run((ctx) => ctx.db.get(ticket._id)))!
    expect(row).toMatchObject({ startsAt: at(14, '19:00'), kind: 'experience' })
    expect(row.tableIds).toHaveLength(0)
    // The regular room is exactly what the event left: the event holds tables, parties take the others,
    // and no table is sold twice.
    const booked = await before()
    const rows = (await t.run((ctx) => ctx.db.query('reservations').collect())).filter(
      (r) => r.status === 'confirmed' && r.kind !== 'experience' && r.startsAt === at(14, '19:30'),
    )
    const used = rows.flatMap((r) => r.tableIds.map(String))
    expect(new Set(used).size).toBe(used.length)
    expect(booked).toBeLessThan(6)
  })

  test('the plan cannot put a ticket on a table either', async () => {
    const { t, world, ticket } = await ticketWorld('tables')
    const table = (await t.run((ctx) => ctx.db.query('reservationTables').collect()))[0]!
    const code = await refusalCode(
      world.waiter.mutation(api.reservations.moveTables, {
        id: ticket._id,
        tableIds: [table._id],
      }),
    )
    expect(code).toBe('ticket_not_editable')
  })
})

/* ------------------------------------------------------------------ */
/* 3 — a group request is answered through the group functions         */
/* ------------------------------------------------------------------ */

async function counterProposed(t: Harness) {
  await setupGlobalSettings(t)
  const world = await seedWorld(t, { autoConfirm: true, looseTables: 6, storeEmail: 'c@l.fr' })
  await saveGroupPolicy(world, {})
  const slots = await openSlots(t, world.storeId, 12)
  const slot = slots[0]!
  const requested = await t.mutation(api.reservationGroups.requestGroup, {
    storeId: world.storeId,
    date: dateIn(10),
    serviceId: slot.serviceId as Id<'reservationServices'>,
    startsAt: slot.startsAt,
    partySize: 12,
    guest,
    consentNoticeVersion: 'v1',
  })
  const row = (await bookingByToken(t, requested.manageToken))!
  const other = slots.find((s) => Math.abs(s.startsAt - slot.startsAt) >= 90 * 60_000)!
  await world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
    id: row._id,
    date: dateIn(10),
    serviceId: other.serviceId as Id<'reservationServices'>,
    startsAt: other.startsAt,
  })
  return { world, row, slot, other }
}

describe('answering a group request', () => {
  test('approving after a lapsed counter-proposal is refused, nothing moves', async () => {
    const t = newHarness()
    const { world, row, other } = await counterProposed(t)
    await t.run(async (ctx) => {
      const r = (await ctx.db.get(row._id))!
      await ctx.db.patch(row._id, {
        group: { ...r.group!, proposal: { ...r.group!.proposal!, expiresAt: Date.now() - 1000 } },
      })
    })
    const code = await refusalCode(
      world.waiter.mutation(api.reservationGroups.approveGroup, { id: row._id }),
    )
    expect(code).toBe('group_request_closed')
    const after = (await t.run((ctx) => ctx.db.get(row._id)))!
    expect(after.status).toBe('pending')
    expect(after.startsAt).toBe(other.startsAt)
    expect(await noticeKinds(t)).not.toContain('group_approved')
  })

  test('setStatus cannot confirm a request over an open counter-proposal', async () => {
    const t = newHarness()
    const { world, row } = await counterProposed(t)
    const code = await refusalCode(
      world.waiter.mutation(api.reservations.setStatus, { id: row._id, to: 'confirmed' }),
    )
    expect(code).toBe('group_request_closed')
    const after = (await t.run((ctx) => ctx.db.get(row._id)))!
    expect(after.status).toBe('pending')
    expect(after.group?.proposal).toBeDefined()
    expect(await noticeKinds(t)).not.toContain('group_approved')
  })

  test('setStatus refuses every answer to a waiting request, the group functions still work', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { autoConfirm: true, looseTables: 6, storeEmail: 'c@l.fr' })
    await saveGroupPolicy(world, {})
    const slot = (await openSlots(t, world.storeId, 12))[0]!
    const requested = await t.mutation(api.reservationGroups.requestGroup, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 12,
      guest,
      consentNoticeVersion: 'v1',
    })
    const row = (await bookingByToken(t, requested.manageToken))!
    for (const to of ['confirmed', 'declined', 'cancelled_by_restaurant'] as const) {
      expect(
        await refusalCode(world.waiter.mutation(api.reservations.setStatus, { id: row._id, to })),
      ).toBe('group_request_closed')
    }
    const res = await world.waiter.mutation(api.reservationGroups.approveGroup, { id: row._id })
    expect(res.status).toBe('confirmed')
  })
})

/* ------------------------------------------------------------------ */
/* 10 — cheap ones in the group answers                                 */
/* ------------------------------------------------------------------ */

describe('a counter-proposal', () => {
  test('cannot be for a time that has already begun', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { autoConfirm: true, looseTables: 6, storeEmail: 'c@l.fr' })
    await saveGroupPolicy(world, {})
    const slots = await openSlots(t, world.storeId, 12)
    const asked = slots[slots.length - 1]!
    const requested = await t.mutation(api.reservationGroups.requestGroup, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: asked.serviceId as Id<'reservationServices'>,
      startsAt: asked.startsAt,
      partySize: 12,
      guest,
      consentNoticeVersion: 'v1',
    })
    const row = (await bookingByToken(t, requested.manageToken))!
    const earlier = slots.find((s) => s.startsAt < asked.startsAt)!
    // The host reads the request after the earlier slot began.
    vi.useFakeTimers({ now: earlier.startsAt + 5 * 60_000, toFake: ['Date'] })
    try {
      expect(
        await refusalCode(
          world.waiter.mutation(api.reservationGroups.proposeGroupAlternative, {
            id: row._id,
            date: dateIn(10),
            serviceId: earlier.serviceId as Id<'reservationServices'>,
            startsAt: earlier.startsAt,
          }),
        ),
      ).toBe('slot_unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('approving a request onto tables', () => {
  test('never takes a table a waitlist offer is holding', async () => {
    const t = newHarness()
    await setupGlobalSettings(t)
    const world = await seedWorld(t, { autoConfirm: true, looseTables: 6, storeEmail: 'c@l.fr' })
    await saveGroupPolicy(world, {})
    const slot = (await openSlots(t, world.storeId, 12))[0]!
    const requested = await t.mutation(api.reservationGroups.requestGroup, {
      storeId: world.storeId,
      date: dateIn(10),
      serviceId: slot.serviceId as Id<'reservationServices'>,
      startsAt: slot.startsAt,
      partySize: 12,
      guest,
      consentNoticeVersion: 'v1',
    })
    const row = (await bookingByToken(t, requested.manageToken))!
    const free = (await t.run((ctx) => ctx.db.query('reservationTables').collect())).find(
      (table) => !row.tableIds.includes(table._id),
    )!
    // An offer is holding that table for the window of the request.
    await t.run(async (ctx) => {
      await ctx.db.insert('waitlistEntries', {
        storeId: world.storeId,
        source: 'online',
        status: 'offered',
        guestName: 'Paul',
        guestEmail: 'paul@example.com',
        guestPhone: '',
        partySize: 2,
        date: dateIn(10),
        token: 'offer-token-0001',
        heldSlot: {
          serviceId: slot.serviceId as Id<'reservationServices'>,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          tableIds: [free._id],
        },
        offeredAt: Date.now(),
        offerExpiresAt: Date.now() + 15 * 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    })
    expect(
      await refusalCode(
        world.waiter.mutation(api.reservationGroups.approveGroup, {
          id: row._id,
          tableIds: [free._id],
        }),
      ),
    ).toBe('table_conflict')
    expect((await t.run((ctx) => ctx.db.get(row._id)))!.status).toBe('pending')
  })
})

/* ------------------------------------------------------------------ */
/* 8 — an override without named tables checks the tables it keeps     */
/* ------------------------------------------------------------------ */

describe('a manager override that names no tables', () => {
  test('is refused when the tables kept are taken at the new time, and names them', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { capacityMode: 'tables', autoConfirm: true, looseTables: 3 })
    const mk = (time: string, i: number) =>
      bookSlot(
        t,
        world,
        { serviceId: world.serviceId, startsAt: at(10, time) },
        { partySize: 4, email: `g${time.replace(':', '')}${i}@example.com` },
      )
    const x = await mk('19:00', 0)
    for (let i = 0; i < 3; i++) await mk('20:30', i)
    const rows0 = await t.run((ctx) => ctx.db.query('reservations').collect())
    const xr = rows0.find((r) => r.manageToken === x.manageToken)!
    const edit = {
      id: xr._id,
      date: dateIn(10),
      serviceId: world.serviceId,
      startsAt: at(10, '20:30'),
      partySize: 4,
    }
    expect(await refusalCode(world.manager.mutation(api.reservations.updateByStaff, edit))).toBe(
      'slot_unavailable',
    )
    const forced = world.manager.mutation(api.reservations.updateByStaff, {
      ...edit,
      override: true,
    })
    expect(await refusalCode(forced)).toBe('table_conflict')
    const rows = await t.run((ctx) => ctx.db.query('reservations').collect())
    const used = rows
      .filter((r) => r.startsAt === at(10, '20:30'))
      .flatMap((r) => r.tableIds.map(String))
    expect(new Set(used).size).toBe(used.length)
    expect((await t.run((ctx) => ctx.db.get(xr._id)))!.startsAt).toBe(at(10, '19:00'))
  })

  test('still works when the manager names tables, and records the override', async () => {
    const t = newHarness()
    const world = await seedWorld(t, { capacityMode: 'tables', autoConfirm: true, looseTables: 3 })
    const mk = (time: string, i: number) =>
      bookSlot(
        t,
        world,
        { serviceId: world.serviceId, startsAt: at(10, time) },
        { partySize: 4, email: `h${time.replace(':', '')}${i}@example.com` },
      )
    const x = await mk('19:00', 0)
    for (let i = 0; i < 3; i++) await mk('20:30', i)
    const xr = (await t.run((ctx) => ctx.db.query('reservations').collect())).find(
      (r) => r.manageToken === x.manageToken,
    )!
    const result = await world.manager.mutation(api.reservations.updateByStaff, {
      id: xr._id,
      date: dateIn(10),
      serviceId: world.serviceId,
      startsAt: at(10, '20:30'),
      partySize: 4,
      tableIds: xr.tableIds,
      override: true,
    })
    expect(result.changed).toBe(true)
  })
})
