'use node'

import { v } from 'convex/values'
import { action } from './_generated/server'
import type { ActionCtx } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { getPackageEnv, isSandbox } from '@be-yours/core/env'
import type { deliveroo as DeliverooApi } from '@be-yours/integrations'

/**
 * The Deliveroo Site API, for the owner: opening hours, days off, busy mode and
 * prep times, read from and written to Deliveroo itself.
 *
 * Deliveroo is the source of truth for all of it. Nothing is mirrored into
 * Convex: a copy would only be a second place for the opening hours to be wrong,
 * and the platform enforces them anyway (a site cannot be opened outside its
 * hours). Open and close is `platformStoreStatus`, driven from the integration
 * card; busy mode is NOT a way to pause the store, it only picks which prep
 * time applies.
 *
 * Every action resolves the store's own Deliveroo integration from `storeId`
 * and takes no platform ids from the caller.
 */

type SiteTarget = {
  credentials: { clientId: string; clientSecret: string; sandboxMode: boolean }
  brandId: string
  siteId: string
}

type IntegrationRow = {
  enabled: boolean
  brandId?: string
  platformStoreId: string
} | null

const TIME_RANGE = v.object({
  local_start_time: v.string(),
  local_end_time: v.string(),
})

const OPENING_HOURS = v.record(v.string(), v.array(TIME_RANGE))

/**
 * Resolve where to send the call from the store's own integration.
 *
 * Does NOT check the caller: every action below checks `settings:read` or
 * `settings:write` itself, first, before this runs. Throws a sentence the admin
 * can show; never returns half a target.
 */
async function resolveTarget(ctx: ActionCtx, storeId: Id<'stores'>): Promise<SiteTarget> {
  const integration = (await ctx.runQuery(internal.storeIntegrations.internalGetByStorePlatform, {
    storeId,
    platform: 'deliveroo',
  })) as IntegrationRow

  if (!integration) throw new Error('Deliveroo is not configured for this establishment')
  if (!integration.enabled) throw new Error('The Deliveroo integration is switched off')
  if (!integration.brandId) throw new Error('The Deliveroo integration has no brand id')

  const pkg = getPackageEnv()
  const clientId = pkg.DELIVEROO_CLIENT_ID
  const clientSecret = pkg.DELIVEROO_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('Deliveroo API credentials are not configured on this deployment')
  }

  return {
    credentials: { clientId, clientSecret, sandboxMode: isSandbox('deliveroo') },
    brandId: integration.brandId,
    siteId: integration.platformStoreId,
  }
}

/** One section of the settings screen: its value, or why it could not be read. */
type Section<T> = { ok: true; value: T } | { ok: false; error: string }

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** What `getSiteSettings` answers, spelled out so the action's type can be named. */
export type SiteSettings = {
  status: Section<{ status: string }>
  timeZone: Section<string>
  openingHours: Section<DeliverooApi.DeliverooOpeningHours>
  workloadMode: Section<DeliverooApi.DeliverooWorkloadMode>
  workloadTimes: Section<DeliverooApi.DeliverooWorkloadTimes>
  daysOff: Section<DeliverooApi.DeliverooDaysOffPage>
}

/**
 * Everything the settings screen shows, in one round trip.
 *
 * Each section is read on its own and reports its own failure. A site without
 * the Site API switched on (see `api_access.site` in the site list) answers 403
 * to several of these, and the screen is more useful showing what it could read
 * than one error in place of the lot.
 */
// @guarded-inline: checks settings:read on the store being read
export const getSiteSettings = action({
  args: { storeId: v.id('stores') },
  handler: async (ctx, args): Promise<SiteSettings> => {
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: 'settings:read',
    })
    const { credentials, brandId, siteId } = await resolveTarget(ctx, args.storeId)
    const { deliveroo } = await import('@be-yours/integrations')

    const [status, timeZone, openingHours, workloadMode, workloadTimes, daysOff] =
      await Promise.all([
        section(() => deliveroo.getSiteStatus(credentials, brandId, siteId)),
        section(() => deliveroo.getSiteTimeZone(credentials, brandId, siteId)),
        section(() => deliveroo.getOpeningHours(credentials, brandId, siteId)),
        section(() => deliveroo.getWorkloadMode(credentials, brandId, siteId)),
        section(() =>
          deliveroo.getWorkloadTimes(credentials, brandId, siteId, { allowedRanges: true }),
        ),
        section(() =>
          deliveroo.listDaysOff(credentials, brandId, siteId, { upcoming: true, pageSize: 50 }),
        ),
      ])

    return { status, timeZone, openingHours, workloadMode, workloadTimes, daysOff }
  },
})

/** Busy mode: the longer prep time applies. Orders keep coming. */
// @guarded-inline: checks settings:write on the store being changed
export const setBusyMode = action({
  args: { storeId: v.id('stores'), mode: v.union(v.literal('BUSY'), v.literal('QUIET')) },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: 'settings:write',
    })
    const { credentials, brandId, siteId } = await resolveTarget(ctx, args.storeId)
    const { deliveroo } = await import('@be-yours/integrations')
    await deliveroo.setWorkloadMode(credentials, brandId, siteId, args.mode)
    return { success: true }
  },
})

/** The prep time, in whole minutes, for busy and for quiet. */
// @guarded-inline: checks settings:write on the store being changed
export const setPrepTimes = action({
  args: { storeId: v.id('stores'), busy: v.number(), quiet: v.number() },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: 'settings:write',
    })
    const { credentials, brandId, siteId } = await resolveTarget(ctx, args.storeId)
    const { deliveroo } = await import('@be-yours/integrations')
    await deliveroo.setWorkloadTimes(credentials, brandId, siteId, {
      busy: args.busy,
      quiet: args.quiet,
    })
    return { success: true }
  },
})

/** Replace the regular opening hours. Checked before anything is sent. */
// @guarded-inline: checks settings:write on the store being changed
export const setOpeningHours = action({
  args: { storeId: v.id('stores'), hours: OPENING_HOURS },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: 'settings:write',
    })
    const { credentials, brandId, siteId } = await resolveTarget(ctx, args.storeId)
    const { deliveroo } = await import('@be-yours/integrations')
    await deliveroo.setOpeningHours(
      credentials,
      brandId,
      siteId,
      args.hours as Parameters<typeof deliveroo.setOpeningHours>[3],
    )
    return { success: true }
  },
})

/** Close the site for a period: holidays, works, a private event. */
// @guarded-inline: checks settings:write on the store being changed
export const addDayOff = action({
  args: { storeId: v.id('stores'), startsAt: v.string(), endsAt: v.string() },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: 'settings:write',
    })
    const { credentials, brandId, siteId } = await resolveTarget(ctx, args.storeId)
    const { deliveroo } = await import('@be-yours/integrations')
    const created = await deliveroo.createDayOff(credentials, brandId, siteId, {
      local_start_time: args.startsAt,
      local_end_time: args.endsAt,
    })
    return { success: true, daysOffId: created.days_off_id ?? null }
  },
})

/** Cancel a day off that has not ended. */
// @guarded-inline: checks settings:write on the store being changed
export const removeDayOff = action({
  args: { storeId: v.id('stores'), daysOffId: v.string() },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.authHelpers.checkStorePermission, {
      storeId: args.storeId,
      permission: 'settings:write',
    })
    const { credentials, brandId, siteId } = await resolveTarget(ctx, args.storeId)
    const { deliveroo } = await import('@be-yours/integrations')
    await deliveroo.deleteDayOff(credentials, brandId, siteId, args.daysOffId)
    return { success: true }
  },
})
