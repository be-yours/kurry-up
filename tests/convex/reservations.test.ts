// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The reservation book, driven through the real functions.
 *
 * `convex-test` does not execute Convex's optimistic concurrency, so these
 * tests cannot prove that two simultaneous callers are serialised; that is the
 * argument in the header of `packages/convex-functions/src/reservations.ts`.
 * What they do prove is the half that argument rests on: `create` recomputes
 * availability from the rows it can see, so a slot a visible booking holds is
 * refused, and a slot a cancellation freed is offered again.
 *
 * The clock is the real one: dates are computed ten days ahead of "now".
 */

import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

const harnesses: ReturnType<typeof convexTest>[] = []

function newHarness() {
  const t = convexTest(schema, modules)
  harnesses.push(t)
  return t
}

/** Same reason as the other suites here: leave nothing on the scheduler. */
afterEach(async () => {
  for (const t of harnesses) {
    // Let whatever is already RUNNING finish first.
    //
    // The loop below cancels `inProgress` jobs as well as pending ones, and
    // cancelling a job mid-run is what `convexTest` raises
    // "Unexpected scheduled function state after it finished running: canceled"
    // over — an unhandled rejection that turns a fully green run red, blaming
    // whichever file happened to be executing rather than the one that queued
    // the work. It stayed hidden while the only scheduled work was the 5s menu
    // sync, which is always still `pending`; the order confirmation goes on at
    // `runAfter(0)` from every payment path, so under parallel load it is
    // routinely mid-flight when this runs.
    //
    // `finishInProgressScheduledFunctions`, not `finishAllScheduledFunctions`:
    // the second one advances the clock and fires the delayed menu syncs, which
    // is the disease the comment above describes. This one only waits for what
    // was already running.
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

const NOW = Date.now()
const DAY = 24 * 60 * 60_000

/** A date ten days out, in the restaurant's calendar. */
function bookingDate(): string {
  return new Date(NOW + 10 * DAY).toISOString().slice(0, 10)
}

type Harness = ReturnType<typeof convexTest>

async function seedStore(
  t: Harness,
  reservationMode: 'off' | 'native' | 'external' | undefined = 'native',
) {
  return t.run((ctx) =>
    ctx.db.insert('stores', {
      name: 'Chez Luigi',
      slug: 'luigi',
      address: {
        street: '1 rue de la Paix',
        city: 'Paris',
        postalCode: '75002',
        country: 'France',
      },
      hours: [],
      status: 'open' as const,
      ...(reservationMode ? { reservationMode } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
}

async function seedOwner(t: Harness, storeId: Id<'stores'>) {
  await t.run((ctx) =>
    ctx.db.insert('userProfiles', {
      userId: 'owner',
      role: 'client_admin' as const,
      storeIds: [storeId],
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  return t.withIdentity({ subject: 'owner' })
}

interface BookOptions {
  capacityMode?: 'covers' | 'tables'
  autoConfirm?: boolean
  cancellationDeadlineHours?: number
  tables?: number
}

/** Settings, one dinner service every day, and a floor plan when asked. */
async function seedBook(t: Harness, storeId: Id<'stores'>, options: BookOptions = {}) {
  return t.run(async (ctx) => {
    await ctx.db.insert('reservationSettings', {
      storeId,
      capacityMode: options.capacityMode ?? 'tables',
      slotStepMinutes: 30,
      turnoverBufferMinutes: 0,
      minNoticeMinutes: 60,
      maxHorizonDays: 60,
      maxPartySize: 8,
      maxSimultaneousCovers: 10,
      autoConfirm: options.autoConfirm ?? true,
      cancellationDeadlineHours: options.cancellationDeadlineHours ?? 2,
      noticeVersion: 'v1',
      updatedAt: NOW,
    })
    const serviceId = await ctx.db.insert('reservationServices', {
      storeId,
      name: 'Dîner',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start: '19:00',
      end: '22:00',
      durations: [{ upToParty: 99, minutes: 90 }],
      bookableOnline: true,
      sortOrder: 0,
    })
    const tableIds: Id<'reservationTables'>[] = []
    for (let i = 0; i < (options.tables ?? 1); i++) {
      tableIds.push(
        await ctx.db.insert('reservationTables', {
          storeId,
          name: `T${i + 1}`,
          minCovers: 1,
          maxCovers: 4,
          bookableOnline: true,
          outOfService: false,
        }),
      )
    }
    return { serviceId, tableIds }
  })
}

const guest = { name: 'Marie Dupont', email: 'Marie@Example.com ', phone: '0612345678' }

async function firstOpenSlot(t: Harness, storeId: Id<'stores'>, partySize = 2) {
  const slots = await t.query(api.reservations.getAvailability, {
    storeId,
    date: bookingDate(),
    partySize,
  })
  const open = slots.find((s) => s.available)
  if (!open) throw new Error('no open slot')
  return open
}

async function book(
  t: Harness,
  storeId: Id<'stores'>,
  slot: { serviceId: Id<'reservationServices'>; startsAt: number },
  extra: Partial<{
    partySize: number
    idempotencyKey: string
    consentNoticeVersion: string
    email: string
  }> = {},
) {
  return t.mutation(api.reservations.create, {
    storeId,
    date: bookingDate(),
    serviceId: slot.serviceId,
    startsAt: slot.startsAt,
    partySize: extra.partySize ?? 2,
    guest: { ...guest, email: extra.email ?? guest.email },
    consentNoticeVersion: extra.consentNoticeVersion ?? 'v1',
    idempotencyKey: extra.idempotencyKey,
  })
}

/**
 * The refusal code a rejected call carried. Under \`convex-test\` the payload
 * arrives serialised; in production it is the object. Both are read.
 */
async function refusalCode(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
  } catch (error) {
    const data = (error as { data?: unknown }).data
    const parsed = typeof data === 'string' ? JSON.parse(data) : data
    return (parsed as { code?: string } | undefined)?.code
  }
  return undefined
}

describe('the switch, on the server', () => {
  test('refuses every public entry point when the mode is off', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    const { serviceId } = await seedBook(t, storeId)

    expect(await t.query(api.reservations.getPublicConfig, { storeId })).toBeNull()
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailability, { storeId, date: bookingDate(), partySize: 2 }),
      ),
    ).toBe('reservations_disabled')
    expect(await refusalCode(book(t, storeId, { serviceId, startsAt: NOW + 10 * DAY }))).toBe(
      'reservations_disabled',
    )
  })

  test('a legacy row with an external link is not a native book', async () => {
    const t = newHarness()
    const storeId = await t.run((ctx) =>
      ctx.db.insert('stores', {
        name: 'Ancien',
        slug: 'ancien',
        address: { street: '1', city: 'Paris', postalCode: '75002', country: 'France' },
        hours: [],
        status: 'open' as const,
        reservationUrl: 'https://www.thefork.fr/restaurant/x',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    expect(await t.query(api.reservations.getPublicConfig, { storeId })).toBeNull()
  })

  test('a native store with no settings is not configured, and says null', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    expect(await t.query(api.reservations.getPublicConfig, { storeId })).toBeNull()
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailability, { storeId, date: bookingDate(), partySize: 2 }),
      ),
    ).toBe('reservations_not_configured')
  })

  test('a configured native store publishes what the page needs', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    expect(await t.query(api.reservations.getPublicConfig, { storeId })).toMatchObject({
      noticeVersion: 'v1',
      maxPartySize: 8,
      autoConfirm: true,
    })
  })
})

describe('availability', () => {
  test('lists slots and never exposes a table id', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const slots = await t.query(api.reservations.getAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 2,
    })
    expect(slots.map((s) => s.time)).toEqual(['19:00', '19:30', '20:00', '20:30'])
    expect(Object.keys(slots[0]!)).not.toContain('tableIds')
  })

  test('refuses a malformed date or party', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailability, { storeId, date: 'demain', partySize: 2 }),
      ),
    ).toBe('invalid_input')
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailability, { storeId, date: bookingDate(), partySize: 0 }),
      ),
    ).toBe('invalid_input')
  })
})

describe('create', () => {
  test('books the table, numbers it, folds the address and logs the event', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const slot = await firstOpenSlot(t, storeId)

    const result = await book(t, storeId, slot)
    expect(result.status).toBe('confirmed')
    expect(result.reference).toMatch(/^RES-\d{4}-00001$/)

    const rows = await t.run((ctx) => ctx.db.query('reservations').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      guestEmail: 'marie@example.com',
      channel: 'online',
      consentNoticeVersion: 'v1',
    })
    expect(rows[0]!.consentAcceptedAt).toBeTypeOf('number')
    const events = await t.run((ctx) => ctx.db.query('reservationEvents').collect())
    expect(events).toMatchObject([{ actor: 'guest', to: 'confirmed' }])
  })

  test('a store that validates by hand leaves the booking pending', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { autoConfirm: false })
    const result = await book(t, storeId, await firstOpenSlot(t, storeId))
    expect(result.status).toBe('pending')
  })

  test('refuses without the current wording', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const slot = await firstOpenSlot(t, storeId)
    expect(await refusalCode(book(t, storeId, slot, { consentNoticeVersion: 'v0' }))).toBe(
      'consent_required',
    )
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(0)
  })

  test('refuses an address that is not one', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    expect(
      await refusalCode(
        book(t, storeId, await firstOpenSlot(t, storeId), { email: 'pas-une-adresse' }),
      ),
    ).toBe('invalid_input')
  })

  test('a slot nobody offered is refused', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const { serviceId } = await seedBook(t, storeId)
    const slot = await firstOpenSlot(t, storeId)
    expect(
      await refusalCode(book(t, storeId, { serviceId, startsAt: slot.startsAt + 7 * 60_000 })),
    ).toBe('slot_unavailable')
  })

  test('the last table goes to the first caller and the second is told so', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { tables: 1 })
    const slot = await firstOpenSlot(t, storeId)

    await book(t, storeId, slot, { email: 'a@example.com' })
    expect(await refusalCode(book(t, storeId, slot, { email: 'b@example.com' }))).toBe(
      'slot_unavailable',
    )
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(1)

    // The picker agrees with the server: that slot is no longer open.
    const slots = await t.query(api.reservations.getAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 2,
    })
    expect(slots.find((s) => s.startsAt === slot.startsAt)?.available).toBe(false)
  })

  test('a second table keeps the same time bookable', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { tables: 2 })
    const slot = await firstOpenSlot(t, storeId)
    await book(t, storeId, slot, { email: 'a@example.com' })
    await book(t, storeId, slot, { email: 'b@example.com' })
    expect(await refusalCode(book(t, storeId, slot, { email: 'c@example.com' }))).toBe(
      'slot_unavailable',
    )
  })

  test('covers mode stops at the simultaneous ceiling', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { capacityMode: 'covers' })
    const slot = await firstOpenSlot(t, storeId, 4)
    for (const who of ['a', 'b']) {
      await book(t, storeId, slot, { partySize: 4, email: `${who}@example.com` })
    }
    // 10 covers allowed, 8 seated: a party of 4 would make 12.
    expect(
      await refusalCode(book(t, storeId, slot, { partySize: 4, email: 'c@example.com' })),
    ).toBe('slot_unavailable')
  })

  test('the same key is the same booking, not a second one', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { tables: 2 })
    const slot = await firstOpenSlot(t, storeId)
    const first = await book(t, storeId, slot, { idempotencyKey: 'form-1' })
    const second = await book(t, storeId, slot, { idempotencyKey: 'form-1' })
    expect(second).toEqual(first)
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toHaveLength(1)
  })

  test('numbers run in sequence per store', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { tables: 2 })
    const slot = await firstOpenSlot(t, storeId)
    const a = await book(t, storeId, slot, { email: 'a@example.com' })
    const b = await book(t, storeId, slot, { email: 'b@example.com' })
    expect(a.reference.endsWith('00001')).toBe(true)
    expect(b.reference.endsWith('00002')).toBe(true)
  })
})

describe('the manage link', () => {
  test("shows the guest their booking and nothing of the team's", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const { manageToken } = await book(t, storeId, await firstOpenSlot(t, storeId))
    const view = await t.query(api.reservations.getByToken, { token: manageToken })
    expect(view).toMatchObject({ status: 'confirmed', partySize: 2, canCancel: true })
    expect(Object.keys(view!)).not.toContain('internalNote')
    expect(await t.query(api.reservations.getByToken, { token: 'nope-nope-nope' })).toBeNull()
  })

  test('says what a calendar entry needs, and only while the table is held', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    await t.run(async (ctx) => {
      await ctx.db.patch(storeId, {
        address: {
          street: '1 rue de la Paix',
          city: 'Paris',
          postalCode: '75002',
          country: 'France',
        },
      })
    })
    const { manageToken } = await book(t, storeId, await firstOpenSlot(t, storeId))
    const view = await t.query(api.reservations.getByToken, { token: manageToken })
    expect(view?.storeAddress).toBe('1 rue de la Paix, 75002 Paris')
    expect(view!.endsAt).toBeGreaterThan(view!.startsAt)
    expect(view?.canAddToCalendar).toBe(true)

    await t.mutation(api.reservations.cancelByToken, { token: manageToken })
    expect(
      (await t.query(api.reservations.getByToken, { token: manageToken }))?.canAddToCalendar,
    ).toBe(false)
  })

  test('cancelling frees the slot for somebody else', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { tables: 1 })
    const slot = await firstOpenSlot(t, storeId)
    const first = await book(t, storeId, slot, { email: 'a@example.com' })

    await t.mutation(api.reservations.cancelByToken, { token: first.manageToken })
    expect((await t.query(api.reservations.getByToken, { token: first.manageToken }))?.status).toBe(
      'cancelled_by_guest',
    )

    const again = await book(t, storeId, slot, { email: 'b@example.com' })
    expect(again.status).toBe('confirmed')
  })

  test('a cancelled booking cannot be cancelled twice', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const { manageToken } = await book(t, storeId, await firstOpenSlot(t, storeId))
    await t.mutation(api.reservations.cancelByToken, { token: manageToken })
    expect(
      await refusalCode(t.mutation(api.reservations.cancelByToken, { token: manageToken })),
    ).toBe('transition_refused')
  })

  test('past the deadline the link no longer cancels', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    // 30 days of notice required: a booking ten days out is inside the deadline.
    await seedBook(t, storeId, { cancellationDeadlineHours: 24 * 30 })
    const { manageToken } = await book(t, storeId, await firstOpenSlot(t, storeId))
    expect((await t.query(api.reservations.getByToken, { token: manageToken }))?.canCancel).toBe(
      false,
    )
    expect(
      await refusalCode(t.mutation(api.reservations.cancelByToken, { token: manageToken })),
    ).toBe('cancellation_closed')
  })

  test('still works after the owner switches the book off', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const { manageToken } = await book(t, storeId, await firstOpenSlot(t, storeId))
    await t.run((ctx) => ctx.db.patch(storeId, { reservationMode: 'off' }))
    expect(await t.query(api.reservations.getByToken, { token: manageToken })).not.toBeNull()
    await t.mutation(api.reservations.cancelByToken, { token: manageToken })
  })
})

describe('the team', () => {
  test('walks a booking through the service and refuses a move the machine forbids', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    const { reference } = await book(t, storeId, await firstOpenSlot(t, storeId))
    const id = (await t.run((ctx) => ctx.db.query('reservations').first()))!._id

    for (const to of ['arrived', 'seated', 'completed'] as const) {
      await owner.mutation(api.reservations.setStatus, { id, to })
    }
    expect(
      await refusalCode(owner.mutation(api.reservations.setStatus, { id, to: 'confirmed' })),
    ).toBe('transition_refused')

    const history = await owner.query(api.reservations.history, { id })
    expect(history.map((e) => e.to)).toEqual(['confirmed', 'arrived', 'seated', 'completed'])
    expect(reference).toMatch(/^RES-/)
  })

  test('stamps the hour of each stage as the party moves through the service', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    await book(t, storeId, await firstOpenSlot(t, storeId))
    const id = (await t.run((ctx) => ctx.db.query('reservations').first()))!._id
    const row = () => t.run((ctx) => ctx.db.get(id))

    expect((await row())?.arrivedAt).toBeUndefined()
    await owner.mutation(api.reservations.setStatus, { id, to: 'arrived' })
    const arrived = await row()
    expect(arrived?.arrivedAt).toEqual(expect.any(Number))
    expect(arrived?.seatedAt).toBeUndefined()

    await owner.mutation(api.reservations.setStatus, { id, to: 'seated' })
    await owner.mutation(api.reservations.setStatus, { id, to: 'completed' })
    const done = await row()
    expect(done?.arrivedAt).toBe(arrived?.arrivedAt)
    expect(done?.seatedAt).toEqual(expect.any(Number))
    expect(done?.completedAt).toBeGreaterThanOrEqual(done!.seatedAt!)
  })

  test('a party seated without passing the host stand has no arrival hour to invent', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    await book(t, storeId, await firstOpenSlot(t, storeId))
    const id = (await t.run((ctx) => ctx.db.query('reservations').first()))!._id
    await owner.mutation(api.reservations.setStatus, { id, to: 'seated' })
    const seated = await t.run((ctx) => ctx.db.get(id))
    expect(seated).toMatchObject({ status: 'seated', seatedAt: expect.any(Number) })
    expect(seated?.arrivedAt).toBeUndefined()
  })

  test('a no-show cannot be recorded before the booking was due, and can be undone once it was', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    await book(t, storeId, await firstOpenSlot(t, storeId))
    const id = (await t.run((ctx) => ctx.db.query('reservations').first()))!._id

    expect(
      await refusalCode(owner.mutation(api.reservations.setStatus, { id, to: 'no_show' })),
    ).toBe('transition_refused')
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('confirmed')

    // The table's time has come and gone.
    await t.run((ctx) => ctx.db.patch(id, { startsAt: Date.now() - 30 * 60_000 }))
    await owner.mutation(api.reservations.setStatus, { id, to: 'no_show' })
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe('no_show')

    // They turned up after all: the wait is counted from now, not from the booking.
    await owner.mutation(api.reservations.setStatus, { id, to: 'arrived' })
    const back = await t.run((ctx) => ctx.db.get(id))
    expect(back?.status).toBe('arrived')
    expect(back!.arrivedAt!).toBeGreaterThan(back!.startsAt)
  })

  test('a restaurant cancellation frees the table and keeps the reason', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { tables: 1 })
    const owner = await seedOwner(t, storeId)
    const slot = await firstOpenSlot(t, storeId)
    await book(t, storeId, slot)
    const id = (await t.run((ctx) => ctx.db.query('reservations').first()))!._id
    await owner.mutation(api.reservations.setStatus, {
      id,
      to: 'cancelled_by_restaurant',
      note: "Fuite d'eau",
    })
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      status: 'cancelled_by_restaurant',
      cancelReason: "Fuite d'eau",
    })
    expect((await firstOpenSlot(t, storeId)).startsAt).toBe(slot.startsAt)
  })

  test('books by phone a slot the diner is no longer allowed to take', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const { serviceId } = await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    // Fourteen days of notice: a table ten days out is inside it for a diner.
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query('reservationSettings').first())!
      await ctx.db.patch(settings._id, { minNoticeMinutes: 14 * 24 * 60 })
    })
    const slots = await t.query(api.reservations.getAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 3,
    })
    expect(slots.every((s) => s.reason === 'notice')).toBe(true)
    const slot = slots[0]!
    expect(await refusalCode(book(t, storeId, slot, { partySize: 3 }))).toBe('slot_unavailable')

    const made = await owner.mutation(api.reservations.createByStaff, {
      storeId,
      date: bookingDate(),
      serviceId,
      startsAt: slot.startsAt,
      partySize: 3,
      guest,
    })
    expect(made.status).toBe('confirmed')
    const row = (await t.run((ctx) => ctx.db.query('reservations').first()))!
    expect(row.channel).toBe('staff')
    // Nobody ticked a box, so no consent is recorded.
    expect(row.consentAcceptedAt).toBeUndefined()
  })

  test('a stranger without the permission is turned away', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    await expect(
      t.query(api.reservations.listDay, { storeId, date: bookingDate() }),
    ).rejects.toBeTruthy()
  })

  test("lists the day's book in time order", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId, { tables: 2 })
    const owner = await seedOwner(t, storeId)
    const slots = (
      await t.query(api.reservations.getAvailability, {
        storeId,
        date: bookingDate(),
        partySize: 2,
      })
    ).filter((s) => s.available)
    await book(t, storeId, slots[2]!, { email: 'late@example.com' })
    await book(t, storeId, slots[0]!, { email: 'early@example.com' })
    const day = await owner.query(api.reservations.listDay, { storeId, date: bookingDate() })
    expect(day.map((r) => r.guestEmail)).toEqual(['early@example.com', 'late@example.com'])
  })
})

describe('walk-ins', () => {
  /** A service that is open at every minute of every day, so the test does not depend on the hour. */
  async function openAllDay(t: Harness, serviceId: Id<'reservationServices'>) {
    // End not after start: the service runs through midnight, so it never closes.
    await t.run((ctx) => ctx.db.patch(serviceId, { start: '00:00', end: '00:00' }))
  }

  /** A booking already on the book, written straight in like the sweeps' tests do. */
  async function bookTable(
    t: Harness,
    storeId: Id<'stores'>,
    serviceId: Id<'reservationServices'>,
    tableId: Id<'reservationTables'>,
    startsAt: number,
  ) {
    await t.run((ctx) =>
      ctx.db.insert('reservations', {
        storeId,
        reference: `RES-WALKIN-${startsAt}`,
        status: 'confirmed',
        serviceId,
        startsAt,
        endsAt: startsAt + 90 * 60_000,
        partySize: 2,
        tableIds: [tableId],
        guestName: 'Marie Dupont',
        guestEmail: 'marie@example.com',
        guestPhone: '0612345678',
        channel: 'online' as const,
        manageToken: `token-${startsAt}`,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
  }

  async function setup(tables = 1) {
    const t = newHarness()
    const storeId = await seedStore(t)
    const { serviceId, tableIds } = await seedBook(t, storeId, { tables })
    await openAllDay(t, serviceId)
    const owner = await seedOwner(t, storeId)
    return { t, storeId, serviceId, tableIds, owner }
  }

  test('seats a party that has no booking, from this minute, as a booking of its own', async () => {
    const { t, storeId, owner } = await setup()
    const outlook = await owner.query(api.reservations.walkInOutlook, { storeId, partySize: 2 })
    expect(outlook).toEqual({ canSeatNow: true, reason: null, waitMinutes: 0 })

    const before = Date.now()
    const seated = await owner.mutation(api.reservations.seatWalkIn, {
      storeId,
      partySize: 2,
      label: ' Près de la fenêtre ',
    })
    expect(seated.seated).toBe(true)
    if (!seated.seated) return

    const row = (await t.run((ctx) => ctx.db.get(seated.id as Id<'reservations'>)))!
    expect(row).toMatchObject({
      status: 'seated',
      channel: 'walk_in',
      partySize: 2,
      guestName: 'Près de la fenêtre',
      guestEmail: '',
      guestPhone: '',
      reference: seated.reference,
    })
    expect(row.tableIds).toHaveLength(1)
    expect(row.seatedAt).toBeGreaterThanOrEqual(before)
    expect(row.startsAt).toBe(row.seatedAt)
    expect(row.endsAt - row.startsAt).toBe(90 * 60_000)

    const history = await owner.query(api.reservations.history, { id: row._id })
    expect(history).toMatchObject([{ to: 'seated', actor: 'staff', note: 'walk_in' }])
  })

  test('mails nobody, and the party is finished like any other', async () => {
    const { t, storeId, owner } = await setup()
    const seated = await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 })
    if (!seated.seated) throw new Error('expected a table')
    const id = seated.id as Id<'reservations'>

    await owner.mutation(api.reservations.setStatus, { id, to: 'completed' })
    const row = (await t.run((ctx) => ctx.db.get(id)))!
    expect(row.status).toBe('completed')
    expect(row.completedAt).toBeGreaterThanOrEqual(row.seatedAt!)
    expect(row.notices).toBeUndefined()
    expect(await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).toEqual([])
  })

  test('holds the table for the whole sitting and says how long the next party would wait', async () => {
    const { storeId, owner } = await setup()
    await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 })

    const outlook = await owner.query(api.reservations.walkInOutlook, { storeId, partySize: 2 })
    expect(outlook).toEqual({ canSeatNow: false, reason: 'no_table', waitMinutes: 90 })

    const second = await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 })
    expect(second).toEqual({ seated: false, reason: 'no_table', waitMinutes: 90 })
  })

  test('writes nothing when there is no room', async () => {
    const { t, storeId, owner } = await setup()
    // Six people, one table of four.
    const result = await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 6 })
    expect(result).toMatchObject({ seated: false, reason: 'no_table' })
    expect(await t.run((ctx) => ctx.db.query('reservations').collect())).toEqual([])
  })

  test('never takes a table that a booking is counting on', async () => {
    const { t, storeId, serviceId, tableIds, owner } = await setup()
    // Booked in half an hour: a 90-minute sitting now would overlap it.
    await bookTable(t, storeId, serviceId, tableIds[0]!, Date.now() + 30 * 60_000)
    expect(await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 })).toEqual({
      seated: false,
      reason: 'no_table',
      // The booking runs from +30 min to +120 min: the table is free at +120.
      waitMinutes: 120,
    })
  })

  test('takes a table whose next booking starts after the sitting would be over', async () => {
    const { t, storeId, serviceId, tableIds, owner } = await setup()
    await bookTable(t, storeId, serviceId, tableIds[0]!, Date.now() + 3 * 60 * 60_000)
    const seated = await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 })
    expect(seated.seated).toBe(true)
  })

  test('says the establishment is closed outside a service, and that waiting would not help', async () => {
    const { t, storeId, serviceId, owner } = await setup()
    await t.run((ctx) => ctx.db.patch(serviceId, { weekdays: [] }))
    expect(await owner.query(api.reservations.walkInOutlook, { storeId, partySize: 2 })).toEqual({
      canSeatNow: false,
      reason: 'closed',
      waitMinutes: null,
    })
    expect(await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 })).toEqual({
      seated: false,
      reason: 'closed',
      waitMinutes: null,
    })
  })

  test('works with the online switch off, since people still walk in', async () => {
    const { t, storeId, owner } = await setup()
    await t.run((ctx) => ctx.db.patch(storeId, { reservationMode: 'off' }))
    const seated = await owner.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 })
    expect(seated.seated).toBe(true)
  })

  test('refuses a party that is not a number of people, and a stranger', async () => {
    const { t, storeId, owner } = await setup()
    for (const partySize of [0, -1, 2.5, 101]) {
      expect(
        await refusalCode(owner.mutation(api.reservations.seatWalkIn, { storeId, partySize })),
      ).toBe('invalid_input')
    }
    await expect(
      t.mutation(api.reservations.seatWalkIn, { storeId, partySize: 2 }),
    ).rejects.toBeTruthy()
    await expect(
      t.query(api.reservations.walkInOutlook, { storeId, partySize: 2 }),
    ).rejects.toBeTruthy()
  })
})

describe('settings', () => {
  test('a manager-level owner saves settings, a service and a closure', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    await owner.mutation(api.reservations.saveSettings, {
      storeId,
      capacityMode: 'covers',
      slotStepMinutes: 15,
      turnoverBufferMinutes: 10,
      minNoticeMinutes: 120,
      maxHorizonDays: 90,
      maxPartySize: 10,
      maxSimultaneousCovers: 40,
      autoConfirm: false,
      cancellationDeadlineHours: 24,
      noticeVersion: '2026-10',
    })
    const serviceId = await owner.mutation(api.reservations.saveService, {
      storeId,
      name: 'Déjeuner',
      weekdays: [1, 2, 3],
      start: '12:00',
      end: '14:30',
      durations: [{ upToParty: 99, minutes: 75 }],
      bookableOnline: true,
      sortOrder: 0,
    })
    await owner.mutation(api.reservations.saveClosure, {
      storeId,
      startDate: '2027-08-01',
      endDate: '2027-08-15',
      serviceId,
      reason: 'Congés',
    })
    const config = await owner.query(api.reservations.getConfig, { storeId })
    expect(config.settings).toMatchObject({ capacityMode: 'covers', noticeVersion: '2026-10' })
    expect(config.services).toHaveLength(1)
    expect(config.closures).toHaveLength(1)
  })

  test('refuses nonsense', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const rules = {
      storeId,
      capacityMode: 'covers' as const,
      slotStepMinutes: 30,
      turnoverBufferMinutes: 0,
      minNoticeMinutes: 60,
      maxHorizonDays: 60,
      maxPartySize: 8,
      maxSimultaneousCovers: 30,
      autoConfirm: true,
      cancellationDeadlineHours: 2,
      noticeVersion: 'v1',
    }
    for (const lateToleranceMinutes of [-1, 241, 7.5]) {
      expect(
        await refusalCode(
          owner.mutation(api.reservations.saveSettings, { ...rules, lateToleranceMinutes }),
        ),
      ).toBe('invalid_input')
    }
    await owner.mutation(api.reservations.saveSettings, { ...rules, lateToleranceMinutes: 25 })
    expect((await owner.query(api.reservations.getConfig, { storeId })).settings).toMatchObject({
      lateToleranceMinutes: 25,
    })
    expect(
      await refusalCode(
        owner.mutation(api.reservations.saveService, {
          storeId,
          name: 'Brunch',
          weekdays: [9],
          start: '11:00',
          end: '15:00',
          durations: [{ upToParty: 99, minutes: 60 }],
          bookableOnline: true,
          sortOrder: 0,
        }),
      ),
    ).toBe('invalid_input')
    expect(
      await refusalCode(
        owner.mutation(api.reservations.saveClosure, {
          storeId,
          startDate: '2027-08-15',
          endDate: '2027-08-01',
        }),
      ),
    ).toBe('invalid_input')
  })

  test('a service that has taken bookings cannot be deleted from under them', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const { serviceId } = await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    await book(t, storeId, await firstOpenSlot(t, storeId))
    expect(
      await refusalCode(owner.mutation(api.reservations.removeService, { id: serviceId })),
    ).toBe('service_in_use')
  })

  test('an unused service goes, with its closures', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    const { serviceId } = await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    await owner.mutation(api.reservations.saveClosure, {
      storeId,
      startDate: '2027-08-01',
      endDate: '2027-08-02',
      serviceId,
    })
    await owner.mutation(api.reservations.removeService, { id: serviceId })
    expect(await t.run((ctx) => ctx.db.query('reservationClosures').collect())).toHaveLength(0)
    expect(await t.run((ctx) => ctx.db.get(serviceId))).toBeNull()
  })
  test('the team keeps a private note on a booking, and the guest never sees it', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    const { manageToken } = await book(t, storeId, await firstOpenSlot(t, storeId))
    const id = (await t.run((ctx) => ctx.db.query('reservations').first()))!._id
    await owner.mutation(api.reservations.setInternalNote, { id, note: 'Client VIP, table 12' })
    expect((await t.run((ctx) => ctx.db.get(id)))?.internalNote).toBe('Client VIP, table 12')
    const view = await t.query(api.reservations.getByToken, { token: manageToken })
    expect(JSON.stringify(view)).not.toContain('VIP')
    // An empty note clears it rather than storing a blank.
    await owner.mutation(api.reservations.setInternalNote, { id, note: '  ' })
    expect((await t.run((ctx) => ctx.db.get(id)))?.internalNote).toBeUndefined()
  })

  test('a table is edited in place and leaves service rather than being deleted', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const id = await owner.mutation(api.reservations.saveTable, {
      storeId,
      name: 'Terrasse 1',
      minCovers: 2,
      maxCovers: 4,
      bookableOnline: true,
      outOfService: false,
    })
    await owner.mutation(api.reservations.saveTable, {
      storeId,
      id,
      name: 'Terrasse 1',
      minCovers: 2,
      maxCovers: 6,
      bookableOnline: true,
      outOfService: true,
    })
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ maxCovers: 6, outOfService: true })
    expect(await t.run((ctx) => ctx.db.query('reservationTables').collect())).toHaveLength(1)
    expect(
      await refusalCode(
        owner.mutation(api.reservations.saveTable, {
          storeId,
          name: 'Bar',
          minCovers: 5,
          maxCovers: 2,
          bookableOnline: true,
          outOfService: false,
        }),
      ),
    ).toBe('invalid_input')
  })

  test('a table of another establishment cannot be edited through this one', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const other = await seedStore(t)
    const { tableIds } = await seedBook(t, other)
    const owner = await seedOwner(t, storeId)
    expect(
      await refusalCode(
        owner.mutation(api.reservations.saveTable, {
          storeId,
          id: tableIds[0],
          name: 'Intrus',
          minCovers: 1,
          maxCovers: 2,
          bookableOnline: true,
          outOfService: false,
        }),
      ),
    ).toBe('invalid_input')
  })

  test('a closure can be lifted, and the day reopens', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    const date = bookingDate()
    const closureId = await owner.mutation(api.reservations.saveClosure, {
      storeId,
      startDate: date,
      endDate: date,
      reason: 'Privatisation',
    })
    expect(
      await t.query(api.reservations.getAvailability, { storeId, date, partySize: 2 }),
    ).toEqual([])
    await owner.mutation(api.reservations.removeClosure, { id: closureId })
    expect(
      (await t.query(api.reservations.getAvailability, { storeId, date, partySize: 2 })).length,
    ).toBeGreaterThan(0)
  })
})

describe('switching the book on', () => {
  const settingsRow = (storeId: Id<'stores'>, over: Record<string, unknown> = {}) => ({
    storeId,
    capacityMode: 'tables' as const,
    slotStepMinutes: 30,
    turnoverBufferMinutes: 0,
    minNoticeMinutes: 60,
    maxHorizonDays: 60,
    maxPartySize: 8,
    autoConfirm: true,
    cancellationDeadlineHours: 2,
    noticeVersion: 'v1',
    updatedAt: NOW,
    ...over,
  })

  it('is refused on an establishment with nothing set up, and says what is missing', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    const owner = await seedOwner(t, storeId)
    const call = owner.mutation(api.stores.update, { id: storeId, reservationMode: 'native' })
    expect(await refusalCode(call)).toBe('reservations_not_configured')
    expect((await t.run((ctx) => ctx.db.get(storeId)))?.reservationMode).toBe('off')

    const message = await owner
      .mutation(api.stores.update, { id: storeId, reservationMode: 'native' })
      .catch((e) => {
        const data = (e as { data?: unknown }).data
        return (typeof data === 'string' ? JSON.parse(data) : data).message as string
      })
    expect(message).toContain('règles de réservation')
  })

  it('is refused while no service can be booked online', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    await seedBook(t, storeId)
    await t.run(async (ctx) => {
      const service = (await ctx.db.query('reservationServices').first())!
      await ctx.db.patch(service._id, { bookableOnline: false })
    })
    const owner = await seedOwner(t, storeId)
    expect(
      await refusalCode(
        owner.mutation(api.stores.update, { id: storeId, reservationMode: 'native' }),
      ),
    ).toBe('reservations_not_configured')
  })

  it('is refused in floor-plan mode when every table is out of service', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    await seedBook(t, storeId)
    await t.run(async (ctx) => {
      const table = (await ctx.db.query('reservationTables').first())!
      await ctx.db.patch(table._id, { outOfService: true })
    })
    const owner = await seedOwner(t, storeId)
    expect(
      await refusalCode(
        owner.mutation(api.stores.update, { id: storeId, reservationMode: 'native' }),
      ),
    ).toBe('reservations_not_configured')
  })

  it('is refused in covers mode with no ceiling, and accepted with one', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    await seedBook(t, storeId, { capacityMode: 'covers' })
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query('reservationSettings').first())!
      await ctx.db.replace(settings._id, settingsRow(storeId, { capacityMode: 'covers' }))
    })
    const owner = await seedOwner(t, storeId)
    expect(
      await refusalCode(
        owner.mutation(api.stores.update, { id: storeId, reservationMode: 'native' }),
      ),
    ).toBe('reservations_not_configured')

    await owner.mutation(api.reservations.saveSettings, {
      storeId,
      capacityMode: 'covers',
      slotStepMinutes: 30,
      turnoverBufferMinutes: 0,
      minNoticeMinutes: 60,
      maxHorizonDays: 60,
      maxPartySize: 8,
      maxSimultaneousCovers: 30,
      autoConfirm: true,
      cancellationDeadlineHours: 2,
      noticeVersion: 'v1',
    })
    await owner.mutation(api.stores.update, { id: storeId, reservationMode: 'native' })
    expect((await t.run((ctx) => ctx.db.get(storeId)))?.reservationMode).toBe('native')
  })

  it('works on a configured book, and the page and the server open together', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    expect(await t.query(api.reservations.getPublicConfig, { storeId })).toBeNull()

    await owner.mutation(api.stores.update, { id: storeId, reservationMode: 'native' })
    expect(await t.query(api.reservations.getPublicConfig, { storeId })).not.toBeNull()

    // And back: off wins, the configuration is kept.
    await owner.mutation(api.stores.update, { id: storeId, reservationMode: 'off' })
    expect(await t.query(api.reservations.getPublicConfig, { storeId })).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('reservationServices').collect())).toHaveLength(1)
  })

  it('does not re-ask when the owner edits an establishment that is already native', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'native')
    const owner = await seedOwner(t, storeId)
    // No book at all, yet the store was already native: a phone number edit goes through.
    await owner.mutation(api.stores.update, { id: storeId, phone: '01 23 45 67 89' })
    await owner.mutation(api.stores.update, {
      id: storeId,
      phone: '01 23 45 67 80',
      reservationMode: 'native',
    })
    expect((await t.run((ctx) => ctx.db.get(storeId)))?.phone).toBe('01 23 45 67 80')
  })

  it('cannot be chosen when an establishment is created', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    const owner = await seedOwner(t, storeId)
    const fresh = {
      name: 'Nouveau',
      slug: 'nouveau',
      address: { street: '1 rue', city: 'Paris', postalCode: '75001', country: 'France' },
    }
    // The same call with an allowed mode goes through, so the refusal below is
    // about `native` and not about the owner, the slug or the address.
    await owner.mutation(api.stores.create, { ...fresh, slug: 'ok', reservationMode: 'off' })
    await expect(
      owner.mutation(api.stores.create, { ...fresh, reservationMode: 'native' } as never),
    ).rejects.toThrow(/Validator error.*"native"/)
  })

  it('keeps the last bookable service while the book is on', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'native')
    const { serviceId } = await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    expect(
      await refusalCode(owner.mutation(api.reservations.removeService, { id: serviceId })),
    ).toBe('reservations_not_configured')
    // Off first, then it goes.
    await owner.mutation(api.stores.update, { id: storeId, reservationMode: 'off' })
    await owner.mutation(api.reservations.removeService, { id: serviceId })
    expect(await t.run((ctx) => ctx.db.get(serviceId))).toBeNull()
  })
})

describe('what the team sees', () => {
  it('books by phone while the online form is off, through the same engine', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    const { serviceId } = await seedBook(t, storeId, { tables: 1 })
    const owner = await seedOwner(t, storeId)

    // The diner's own query is closed…
    expect(
      await refusalCode(
        t.query(api.reservations.getAvailability, { storeId, date: bookingDate(), partySize: 2 }),
      ),
    ).toBe('reservations_disabled')
    // …the team's is not.
    const slots = await owner.query(api.reservations.staffAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 2,
    })
    const slot = slots.find((s) => s.available)!
    expect(slot).toBeDefined()
    await owner.mutation(api.reservations.createByStaff, {
      storeId,
      date: bookingDate(),
      serviceId,
      startsAt: slot.startsAt,
      partySize: 2,
      guest,
    })
    // One table, now taken: the team cannot sell it twice either.
    const after = await owner.query(api.reservations.staffAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 2,
    })
    expect(after.find((s) => s.startsAt === slot.startsAt)?.available).toBe(false)
  })

  it("drops the diner's notice and horizon, but not a table's capacity", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query('reservationSettings').first())!
      await ctx.db.patch(settings._id, { minNoticeMinutes: 14 * 24 * 60, maxPartySize: 2 })
    })
    const diner = await t.query(api.reservations.getAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 6,
    })
    expect(diner.every((s) => !s.available)).toBe(true)
    const team = await owner.query(api.reservations.staffAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 4,
    })
    // Four fits the one table of four, whatever the notice and the diner's maximum say.
    expect(team.some((s) => s.available)).toBe(true)
    const tooBig = await owner.query(api.reservations.staffAvailability, {
      storeId,
      date: bookingDate(),
      partySize: 6,
    })
    expect(tooBig.every((s) => !s.available)).toBe(true)
  })

  it('refuses a stranger the team query', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await seedBook(t, storeId)
    await expect(
      t.query(api.reservations.staffAvailability, { storeId, date: bookingDate(), partySize: 2 }),
    ).rejects.toBeTruthy()
  })

  it('reports where the book stands: the switch, and what is missing', async () => {
    const t = newHarness()
    const storeId = await seedStore(t, 'off')
    const owner = await seedOwner(t, storeId)

    const empty = await owner.query(api.reservations.getSetup, { storeId })
    expect(empty.mode).toBe('off')
    expect(empty.gaps).toHaveLength(1)
    expect(empty.gaps[0]).toContain('règles de réservation')

    await seedBook(t, storeId)
    expect(await owner.query(api.reservations.getSetup, { storeId })).toEqual({
      mode: 'off',
      gaps: [],
    })
    await owner.mutation(api.stores.update, { id: storeId, reservationMode: 'native' })
    expect((await owner.query(api.reservations.getSetup, { storeId })).mode).toBe('native')
  })

  it("carries the restaurant's time zone with the configuration", async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    await t.run((ctx) =>
      ctx.db.insert('globalSettings', {
        currency: 'EUR',
        timezone: 'America/Montreal',
        taxRate: 10,
        services: { dineIn: true, takeaway: true, delivery: true, clickAndCollect: true },
        hours: [],
        delivery: {},
        integrations: {},
        updatedAt: NOW,
      }),
    )
    const owner = await seedOwner(t, storeId)
    expect((await owner.query(api.reservations.getConfig, { storeId })).timezone).toBe(
      'America/Montreal',
    )
  })
})

describe('floor plan', () => {
  async function twoTables() {
    const t = newHarness()
    const storeId = await seedStore(t)
    const owner = await seedOwner(t, storeId)
    const save = (name: string) =>
      owner.mutation(api.reservations.saveTable, {
        storeId,
        name,
        minCovers: 1,
        maxCovers: 4,
        bookableOnline: true,
        outOfService: false,
      })
    return { t, storeId, owner, a: await save('T1'), b: await save('T2') }
  }

  test('positions are saved together and come back with the configuration', async () => {
    const { t, storeId, owner, a, b } = await twoTables()
    expect(
      await owner.mutation(api.reservations.saveTableLayout, {
        storeId,
        tables: [
          { id: a, x: 2, y: 3, width: 3, height: 2 },
          { id: b, x: 10, y: 3, width: 2, height: 2 },
        ],
      }),
    ).toBe(2)
    const { tables } = await owner.query(api.reservations.getConfig, { storeId })
    expect(tables.find((x) => x._id === a)).toMatchObject({ x: 2, y: 3, width: 3, height: 2 })
    expect(tables.find((x) => x._id === b)).toMatchObject({ x: 10, y: 3, width: 2, height: 2 })
    expect(await t.run((ctx) => ctx.db.get(a))).toMatchObject({ name: 'T1' })
  })

  test('editing a table in the form keeps where it was drawn', async () => {
    const { t, storeId, owner, a } = await twoTables()
    await owner.mutation(api.reservations.saveTableLayout, {
      storeId,
      tables: [{ id: a, x: 4, y: 5, width: 2, height: 2 }],
    })
    await owner.mutation(api.reservations.saveTable, {
      storeId,
      id: a,
      name: 'T1 renommée',
      minCovers: 1,
      maxCovers: 6,
      bookableOnline: true,
      outOfService: false,
    })
    expect(await t.run((ctx) => ctx.db.get(a))).toMatchObject({
      name: 'T1 renommée',
      x: 4,
      y: 5,
      width: 2,
      height: 2,
    })
  })

  test('a layout with one bad table saves nothing', async () => {
    const { t, storeId, owner, a, b } = await twoTables()
    for (const bad of [
      { x: 39, y: 0, width: 3, height: 2 }, // runs off the right wall
      { x: 0, y: 0, width: 0, height: 2 }, // no size
      { x: 0, y: 0, width: 13, height: 2 }, // longer than any table
      { x: 0.5, y: 0, width: 2, height: 2 }, // between cells
      { x: -1, y: 0, width: 2, height: 2 }, // off the left wall
    ]) {
      expect(
        await refusalCode(
          owner.mutation(api.reservations.saveTableLayout, {
            storeId,
            tables: [
              { id: a, x: 1, y: 1, width: 2, height: 2 },
              { id: b, ...bad },
            ],
          }),
        ),
      ).toBe('invalid_input')
    }
    expect((await t.run((ctx) => ctx.db.get(a)))?.x).toBeUndefined()
  })

  test('the same table twice, or a table of another establishment, is refused', async () => {
    const { storeId, owner, a } = await twoTables()
    const rect = { x: 1, y: 1, width: 2, height: 2 }
    expect(
      await refusalCode(
        owner.mutation(api.reservations.saveTableLayout, {
          storeId,
          tables: [
            { id: a, ...rect },
            { id: a, ...rect },
          ],
        }),
      ),
    ).toBe('invalid_input')

    const t = newHarness()
    const mine = await seedStore(t)
    const other = await seedStore(t)
    const { tableIds } = await seedBook(t, other)
    const me = await seedOwner(t, mine)
    expect(
      await refusalCode(
        me.mutation(api.reservations.saveTableLayout, {
          storeId: mine,
          tables: [{ id: tableIds[0], ...rect }],
        }),
      ),
    ).toBe('invalid_input')
  })

  test('where a table is drawn never changes what a diner is offered', async () => {
    const t = newHarness()
    const storeId = await seedStore(t)
    const { tableIds } = await seedBook(t, storeId)
    const owner = await seedOwner(t, storeId)
    const date = bookingDate()
    const before = await t.query(api.reservations.getAvailability, { storeId, date, partySize: 2 })
    await owner.mutation(api.reservations.saveTableLayout, {
      storeId,
      tables: tableIds.map((id, i) => ({ id, x: i * 4, y: 0, width: 3, height: 2 })),
    })
    expect(
      await t.query(api.reservations.getAvailability, { storeId, date, partySize: 2 }),
    ).toEqual(before)
  })
})
