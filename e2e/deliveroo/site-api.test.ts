// @vitest-environment edge-runtime
/**
 * ┌───────────────────────────────────────────────────────────┐
 * │   Deliveroo Integration - Site API controls           │
 * └───────────────────────────────────────────────────────────┘
 *
 * @description
 * Opening hours, days off, busy mode and prep times, set from the product and
 * written to Deliveroo. Before `convex/deliverooSite.ts` the only Site API call
 * was open / closed: an owner closing for a week had to do it on Deliveroo's
 * own portal, and nothing here could tell them the site was in busy mode.
 *
 * What has to hold:
 *  - the caller needs the settings permission on THIS store (read to look,
 *    write to change), and a kitchen account has neither;
 *  - the platform ids come from the store's own integration, never the caller;
 *  - bad input is refused before anything is sent;
 *  - one section that Deliveroo refuses (a site without Site API access) does
 *    not blank the others.
 *
 * @reference https://api-docs.deliveroo.com/docs/site
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  NOW,
  apiCallsExcludingAuth,
  cancelPendingScheduledJobs,
  configureDeliverooEnv,
  newHarness,
  seedDeliverooIntegration,
  seedStore,
  withDeliverooApi,
} from './convex-harness'

beforeAll(() => configureDeliverooEnv({ withApiCredentials: true }))
afterEach(cancelPendingScheduledJobs)

type Harness = ReturnType<typeof newHarness>

const BRAND = 'brand-under-test'

async function profile(
  t: Harness,
  storeId: Id<'stores'>,
  userId: string,
  role: 'client_admin' | 'kitchen',
) {
  await t.run((ctx) =>
    ctx.db.insert('userProfiles', {
      userId,
      role,
      storeIds: [storeId],
      permissions: [],
      language: 'fr',
      twoFactorEnabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  return t.withIdentity({ subject: userId })
}

async function siteStore(t: Harness, options: { enabled?: boolean; brandId?: string } = {}) {
  const storeId = await seedStore(t)
  await seedDeliverooIntegration(t, storeId, {
    brandId: 'brandId' in options ? options.brandId : BRAND,
    enabled: options.enabled,
    platformStoreId: 'site-under-test',
  })
  const owner = await profile(t, storeId, 'user:owner', 'client_admin')
  return { storeId, owner }
}

/** Answer each Site API read with a body Deliveroo documents. */
function siteAnswers(call: { url: string; method: string }): Response {
  const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
  if (call.url.endsWith('/status')) return json({ status: 'OPEN' })
  if (call.url.endsWith('/time_zone')) return json({ time_zone: 'Europe/Paris' })
  if (call.url.endsWith('/opening_hours')) {
    return json({
      opening_hours: { monday: [{ local_start_time: '12:00', local_end_time: '15:00' }] },
    })
  }
  if (call.url.endsWith('/workload/mode')) return json({ mode: 'QUIET' })
  if (call.url.includes('/workload/times')) return json({ busy: 35, quiet: 15 })
  if (call.url.includes('/days_off'))
    return json({ days_off: [], page: { number: 1, size: 50, total_items: 0 } })
  return json({})
}

describe('Site API controls', () => {
  describe('who may use them', () => {
    it('refuses a signed-out caller', async () => {
      const t = newHarness()
      const { storeId } = await siteStore(t)
      await expect(
        t.action(api.deliverooSite.setBusyMode, { storeId, mode: 'BUSY' }),
      ).rejects.toThrow(/not_authenticated/)
    })

    it('refuses a kitchen account, which holds neither settings permission', async () => {
      const t = newHarness()
      const { storeId } = await siteStore(t)
      const cook = await profile(t, storeId, 'user:cook', 'kitchen')

      await withDeliverooApi(async (recorded) => {
        await expect(cook.action(api.deliverooSite.getSiteSettings, { storeId })).rejects.toThrow(
          /lacks permission settings:read/,
        )
        await expect(
          cook.action(api.deliverooSite.setBusyMode, { storeId, mode: 'BUSY' }),
        ).rejects.toThrow(/lacks permission settings:write/)
        expect(apiCallsExcludingAuth(recorded)).toHaveLength(0)
      })
    })

    it('refuses an owner of another establishment', async () => {
      const t = newHarness()
      const { storeId } = await siteStore(t)
      const elsewhere = await seedStore(t, 'Chez Amina')
      const stranger = await profile(t, elsewhere, 'user:stranger', 'client_admin')

      await expect(
        stranger.action(api.deliverooSite.setBusyMode, { storeId, mode: 'BUSY' }),
      ).rejects.toThrow(/permission_denied|Access denied/)
    })
  })

  describe('where the call goes', () => {
    it('says so plainly when the establishment has no Deliveroo integration', async () => {
      const t = newHarness()
      const storeId = await seedStore(t)
      const owner = await profile(t, storeId, 'user:owner', 'client_admin')
      await expect(
        owner.action(api.deliverooSite.setBusyMode, { storeId, mode: 'BUSY' }),
      ).rejects.toThrow(/not configured/)
    })

    it('refuses when the integration is switched off, or has no brand id', async () => {
      const off = newHarness()
      const a = await siteStore(off, { enabled: false })
      await expect(
        a.owner.action(api.deliverooSite.setBusyMode, { storeId: a.storeId, mode: 'BUSY' }),
      ).rejects.toThrow(/switched off/)

      const noBrand = newHarness()
      const b = await siteStore(noBrand, { brandId: undefined })
      await expect(
        b.owner.action(api.deliverooSite.setBusyMode, { storeId: b.storeId, mode: 'BUSY' }),
      ).rejects.toThrow(/brand id/)
    })

    it('targets the brand and site stored for the establishment', async () => {
      const t = newHarness()
      const { storeId, owner } = await siteStore(t)

      const calls = await withDeliverooApi(async (recorded) => {
        await owner.action(api.deliverooSite.setBusyMode, { storeId, mode: 'BUSY' })
        return apiCallsExcludingAuth(recorded)
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]!.method).toBe('PUT')
      expect(calls[0]!.url).toContain(
        `/site/v1/brands/${BRAND}/sites/site-under-test/workload/mode`,
      )
      expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({ mode: 'BUSY' })
    })
  })

  describe('what they send', () => {
    it('sets the prep times', async () => {
      const t = newHarness()
      const { storeId, owner } = await siteStore(t)
      const calls = await withDeliverooApi(async (recorded) => {
        await owner.action(api.deliverooSite.setPrepTimes, { storeId, busy: 35, quiet: 15 })
        return apiCallsExcludingAuth(recorded)
      })
      expect(calls[0]!.url).toContain('/workload/times')
      expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({ busy: 35, quiet: 15 })
    })

    it('sets the opening hours, split shifts included', async () => {
      const t = newHarness()
      const { storeId, owner } = await siteStore(t)
      const hours = {
        friday: [
          { local_start_time: '11:30', local_end_time: '16:00' },
          { local_start_time: '18:00', local_end_time: '23:00' },
        ],
      }
      const calls = await withDeliverooApi(async (recorded) => {
        await owner.action(api.deliverooSite.setOpeningHours, { storeId, hours })
        return apiCallsExcludingAuth(recorded)
      })
      expect(calls[0]!.method).toBe('POST')
      expect(calls[0]!.url).toContain('/opening_hours')
      expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({ opening_hours: hours })
    })

    it('adds and removes a day off', async () => {
      const t = newHarness()
      const { storeId, owner } = await siteStore(t)

      const calls = await withDeliverooApi(
        async (recorded) => {
          const added = await owner.action(api.deliverooSite.addDayOff, {
            storeId,
            startsAt: '2026-12-24 00:00',
            endsAt: '2026-12-26 23:59',
          })
          expect(added).toEqual({ success: true, daysOffId: 'fr:abc' })
          await owner.action(api.deliverooSite.removeDayOff, { storeId, daysOffId: 'fr:abc' })
          return apiCallsExcludingAuth(recorded)
        },
        (call) =>
          new Response(JSON.stringify(call.method === 'POST' ? { days_off_id: 'fr:abc' } : {}), {
            status: 200,
          }),
      )

      expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE'])
      expect(calls[0]!.url).toContain('/days_off')
      expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
        local_start_time: '2026-12-24 00:00',
        local_end_time: '2026-12-26 23:59',
      })
      expect(calls[1]!.url).toContain('/days_off/fr%3Aabc')
    })
  })

  describe('bad input never leaves', () => {
    it('refuses inverted opening hours, a malformed day off and a zero prep time', async () => {
      const t = newHarness()
      const { storeId, owner } = await siteStore(t)

      await withDeliverooApi(async (recorded) => {
        await expect(
          owner.action(api.deliverooSite.setOpeningHours, {
            storeId,
            hours: { monday: [{ local_start_time: '15:00', local_end_time: '12:00' }] },
          }),
        ).rejects.toThrow()
        await expect(
          owner.action(api.deliverooSite.addDayOff, {
            storeId,
            startsAt: 'tomorrow',
            endsAt: 'next week',
          }),
        ).rejects.toThrow()
        await expect(
          owner.action(api.deliverooSite.setPrepTimes, { storeId, busy: 0, quiet: 15 }),
        ).rejects.toThrow()
        expect(apiCallsExcludingAuth(recorded)).toHaveLength(0)
      })
    })
  })

  describe('getSiteSettings', () => {
    it('returns every section Deliveroo answers', async () => {
      const t = newHarness()
      const { storeId, owner } = await siteStore(t)

      const settings = await withDeliverooApi(
        () => owner.action(api.deliverooSite.getSiteSettings, { storeId }),
        siteAnswers,
      )

      expect(settings.status).toEqual({ ok: true, value: { status: 'OPEN' } })
      expect(settings.timeZone).toEqual({ ok: true, value: 'Europe/Paris' })
      expect(settings.workloadMode).toEqual({ ok: true, value: 'QUIET' })
      expect(settings.openingHours.ok && settings.openingHours.value.monday).toHaveLength(1)
      expect(settings.workloadTimes.ok && settings.workloadTimes.value.busy).toBe(35)
      expect(settings.daysOff.ok).toBe(true)
    })

    it('reports a refused section on its own and keeps the rest', async () => {
      // A site without the Site API switched on answers 403 to some of these.
      const t = newHarness()
      const { storeId, owner } = await siteStore(t)

      const settings = await withDeliverooApi(
        () => owner.action(api.deliverooSite.getSiteSettings, { storeId }),
        (call) =>
          call.url.includes('/workload/')
            ? new Response('forbidden', { status: 403 })
            : siteAnswers(call),
      )

      expect(settings.workloadMode.ok).toBe(false)
      expect(settings.workloadTimes.ok).toBe(false)
      expect(settings.status.ok).toBe(true)
      expect(settings.openingHours.ok).toBe(true)
    })
  })
})
