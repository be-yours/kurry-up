import { internal } from "../_generated/api"
import type { ActionCtx } from "../_generated/server"

export interface Migration {
  id: string
  name: string
  run: (ctx: ActionCtx) => Promise<void>
}

/**
 * Migration registry.
 * Add new migrations at the end of this array.
 * Each migration must have a unique `id` (use format: "YYYY-MM-DD_description").
 * Migrations are executed in order and recorded in globalSettings.appliedMigrations.
 */
export const migrations: Migration[] = [
  {
    id: "2026-09-11_build_customer_book",
    name: "Build the customer book from the orders already there",
    run: async (ctx) => {
      /* `customers` is an aggregate maintained incrementally, so without this
         an establishment trading for two years opens the Clients screen and
         sees whoever ordered that afternoon — worse than an empty screen,
         because a short list looks complete (#364).

         One store at a time, one page at a time: orders is the largest table a
         restaurant has, and a backfill written as one pass is a backfill that
         cannot run on the deployments that need it most.

         The book is EMPTIED first. The accumulation adds each order to what is
         already there, so running this a second time over a book it already
         built would double every total — and a paged migration is one that can
         be interrupted, so running it again is the expected recovery, not an
         edge case. */
      const stores = await ctx.runQuery(internal.stores.listAllInternal, {})
      for (const store of stores) {
        for (;;) {
          const wipe: { deleted: number; isDone: boolean } = await ctx.runMutation(
            internal.customers.resetCustomerBook,
            { storeId: store._id }
          )
          if (wipe.isDone) break
        }

        let cursor: string | null = null
        for (;;) {
          const pass: {
            written: number
            keyed: number
            cursor: string
            isDone: boolean
          } = await ctx.runMutation(internal.customers.backfillCustomers, {
            storeId: store._id,
            cursor,
          })
          if (pass.isDone) break
          cursor = pass.cursor
        }
      }
    },
  },
  // Example:
  // {
  //   id: "2026-03-23_add_default_store_currency",
  //   name: "Add default currency to stores without one",
  //   run: async (ctx) => {
  //     await ctx.runMutation(internal.stores.addDefaultCurrency, {})
  //   },
  // },
]
