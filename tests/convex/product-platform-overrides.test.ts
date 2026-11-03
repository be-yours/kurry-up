// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The admin can save a dish that carries a platform price.
 *
 * WHAT WENT WRONG. The product form sends `platformOverrides` (#624, #654) and
 * `products.create` / `products.update` did not declare it, so Convex refused the
 * call before the handler ran: a restaurant created from scratch could not save
 * its first dish. The source-level test next to the pages passed throughout,
 * because a validator is only exercised by the real mutation — the same reason
 * `promotion-withdrawn-fields.test.ts` runs the real one.
 *
 * The unit half (`productPlatformOverrides.test.ts` in
 * `@be-yours/convex-functions`) holds the merge rules and that every key a page
 * forwards is declared. This holds the wrapper: the args reach the handler and
 * the row ends up as the form meant it.
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
 * Cancel what the test queued: every catalogue write books the platform menu
 * pushes at a 5s delay, and a job that fires after the test closed arrives as an
 * unhandled rejection that blames another file. Same guard as
 * `catalogue-scope.test.ts`, which explains why it cancels rather than runs.
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

async function seedOwner(t: ReturnType<typeof convexTest>) {
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
  const categoryId = await t.run((ctx) =>
    ctx.db.insert('categories', {
      storeId,
      name: 'Pizzas',
      slug: 'pizzas',
      sortOrder: 0,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  await t.run((ctx) =>
    ctx.db.insert('userProfiles', {
      userId: 'owner',
      role: 'client_admin',
      storeIds: [storeId],
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  return { as: t.withIdentity({ subject: 'owner' }), storeId, categoryId }
}

/** What the new-product page sends, field for field, minus the overrides. */
const dish = (storeId: Id<'stores'>, categoryId: Id<'categories'>) => ({
  storeId,
  categoryId,
  name: 'Margherita',
  slug: 'margherita',
  price: 1100,
  taxRate: 10,
  images: [],
  options: [],
  allergens: [],
  tags: [],
  isActive: true,
  isFeatured: false,
  sortOrder: 0,
  source: 'manual',
})

describe('products.create with platformOverrides', () => {
  test('saves a dish whose form sent no override, as the form always does', async () => {
    const t = newHarness()
    const { as, storeId, categoryId } = await seedOwner(t)

    // `uberEats` and `deliveroo` are `undefined` and so absent on the wire.
    const id = await as.mutation(api.products.create, {
      ...dish(storeId, categoryId),
      platformOverrides: {},
    })

    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.name).toBe('Margherita')
    // Nothing is stored for a dish with no override, rather than `{}`.
    expect(row?.platformOverrides).toBeUndefined()
  })

  test('saves the platform price the form collected', async () => {
    const t = newHarness()
    const { as, storeId, categoryId } = await seedOwner(t)

    const id = await as.mutation(api.products.create, {
      ...dish(storeId, categoryId),
      platformOverrides: { uberEats: { price: 1300 } },
    })

    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.platformOverrides).toEqual({ uberEats: { price: 1300 } })
  })

  test('still saves a dish from a caller that sends no platformOverrides at all', async () => {
    const t = newHarness()
    const { as, storeId, categoryId } = await seedOwner(t)

    const id = await as.mutation(api.products.create, dish(storeId, categoryId))

    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.platformOverrides).toBeUndefined()
  })

  test('does not accept the sync-owned fields from a browser', async () => {
    const t = newHarness()
    const { as, storeId, categoryId } = await seedOwner(t)

    await expect(
      as.mutation(api.products.create, {
        ...dish(storeId, categoryId),
        platformOverrides: { uberEats: { price: 1300, isActive: false } },
      } as never),
    ).rejects.toThrow()
  })
})

describe('products.update with platformOverrides', () => {
  async function seedDish(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown>) {
    const owner = await seedOwner(t)
    const id = await t.run((ctx) =>
      ctx.db.insert('products', {
        ...dish(owner.storeId, owner.categoryId),
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
      } as never),
    )
    return { ...owner, id }
  }

  test('saves an edit that carries an empty platformOverrides', async () => {
    const t = newHarness()
    const { as, id } = await seedDish(t, {})

    await as.mutation(api.products.update, { id, name: 'Margherita XL', platformOverrides: {} })

    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.name).toBe('Margherita XL')
  })

  test('clears a price the form switched off, and keeps what the syncs wrote', async () => {
    const t = newHarness()
    const { as, id } = await seedDish(t, {
      platformOverrides: {
        uberEats: { price: 1300, isActive: false, lastSyncedAt: 1_700_000_000_000 },
        deliveroo: { price: 1250 },
      },
    })

    await as.mutation(api.products.update, {
      id,
      platformOverrides: { deliveroo: { price: 1250 } },
    })

    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.platformOverrides).toEqual({
      // The suspension survives the price being cleared.
      uberEats: { isActive: false, lastSyncedAt: 1_700_000_000_000 },
      deliveroo: { price: 1250 },
    })
  })

  test('leaves the overrides alone when the call does not mention them', async () => {
    const t = newHarness()
    const { as, id } = await seedDish(t, {
      platformOverrides: { uberEats: { price: 1300 } },
    })

    await as.mutation(api.products.update, { id, name: 'Margherita XL' })

    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.platformOverrides).toEqual({ uberEats: { price: 1300 } })
  })

  test('removes the field once nothing is left to say', async () => {
    const t = newHarness()
    const { as, id } = await seedDish(t, {
      platformOverrides: { uberEats: { price: 1300 } },
    })

    await as.mutation(api.products.update, { id, platformOverrides: {} })

    const row = await t.run((ctx) => ctx.db.get(id))
    expect(row?.platformOverrides).toBeUndefined()
  })
})
