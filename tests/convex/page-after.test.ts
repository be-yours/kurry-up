// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * `pageAfter` is the privacy walks' page reader. It exists because Convex refuses a
 * function that calls `.paginate()` twice, and `convex-test` does not — so the walks
 * passed every test and failed on a real backend. These tests hold what the walks
 * rely on: no row lost or repeated across pages, ties on the ordered field, the upper
 * bound, a walk that deletes as it goes, and no `.paginate()` left in the walk file.
 */

import { existsSync, readFileSync } from 'node:fs'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { pageAfter } from '@be-yours/convex-functions/privacy'
import schema from '../../convex/schema'

const modules = import.meta.glob('../../convex/**/*.ts')

async function seed(t: ReturnType<typeof convexTest>, createdAts: number[]) {
  return await t.run(async (ctx) => {
    const storeId = await ctx.db.insert('stores', {
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
      createdAt: 1,
      updatedAt: 1,
    })
    for (const [i, createdAt] of createdAts.entries()) {
      await ctx.db.insert('contactMessages', {
        storeId,
        name: `n${i}`,
        email: `m${i}@example.fr`,
        subject: 's',
        message: 'm',
        status: 'new' as const,
        createdAt,
      })
    }
    return storeId
  })
}

/** Walk the whole index `size` rows at a time, as a pass would. */
async function walk(
  t: ReturnType<typeof convexTest>,
  storeId: string,
  size: number,
  index = 'by_storeId_createdAt',
  lt?: number,
) {
  const seen: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const result: Awaited<ReturnType<typeof pageAfter>> = await t.run((ctx) =>
      pageAfter(
        ctx,
        { table: 'contactMessages', index, eq: [['storeId', storeId]], lt },
        cursor,
        size,
      ),
    )
    for (const row of result.page) seen.push(row.name as string)
    if (result.isDone) return seen
    cursor = result.continueCursor
  }
  throw new Error('the walk never finished')
}

describe('pageAfter', () => {
  test('visits every row once, in index order, whatever the page size', async () => {
    const t = convexTest(schema, modules)
    const storeId = await seed(t, [50, 10, 30, 20, 40])
    const expected = ['n1', 'n3', 'n2', 'n4', 'n0']
    for (const size of [1, 2, 3, 5, 9]) {
      expect(await walk(t, storeId, size)).toEqual(expected)
    }
  })

  test('does not lose or repeat rows that tie on the ordered field', async () => {
    const t = convexTest(schema, modules)
    const storeId = await seed(t, [10, 10, 10, 10, 20, 20, 30])
    for (const size of [1, 2, 3]) {
      const seen = await walk(t, storeId, size)
      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
    }
  })

  test('stops at the upper bound, exclusive', async () => {
    const t = convexTest(schema, modules)
    const storeId = await seed(t, [10, 20, 30, 40])
    expect(await walk(t, storeId, 1, 'by_storeId_createdAt', 30)).toEqual(['n0', 'n1'])
  })

  test('walks an index with no ordered field by creation time', async () => {
    const t = convexTest(schema, modules)
    const storeId = await seed(t, [1, 1, 1, 1, 1])
    expect(await walk(t, storeId, 2, 'by_storeId')).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
  })

  test('survives the rows it returned being deleted between two pages', async () => {
    const t = convexTest(schema, modules)
    const storeId = await seed(t, [10, 20, 30, 40, 50])
    const first = await t.run((ctx) =>
      pageAfter(
        ctx,
        {
          table: 'contactMessages',
          index: 'by_storeId_createdAt',
          eq: [['storeId', storeId]],
          lt: 45,
        },
        null,
        2,
      ),
    )
    await t.run(async (ctx) => {
      for (const row of first.page) await ctx.db.delete(row._id)
    })
    const second = await t.run((ctx) =>
      pageAfter(
        ctx,
        {
          table: 'contactMessages',
          index: 'by_storeId_createdAt',
          eq: [['storeId', storeId]],
          lt: 45,
        },
        first.continueCursor,
        10,
      ),
    )
    expect(second.page.map((row) => row.name)).toEqual(['n2', 'n3'])
    expect(second.isDone).toBe(true)
  })

  // The walk file is the monorepo's (`packages/`): the client tree this suite is also published
  // into has no such path, and the engine's own suite holds the rule there.
  const walkFile = new URL('../../../../packages/convex-functions/src/privacy.ts', import.meta.url)
  test.skipIf(!existsSync(walkFile))(
    'the walk file never calls paginate, which a real backend allows once per function',
    () => {
      const source = readFileSync(walkFile, 'utf8')
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/\.paginate\(/)
    },
  )
})
