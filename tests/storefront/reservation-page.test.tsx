/**
 * The booking page is a 404 while the switch is anything but `native`.
 *
 * « Désactivé : plus aucun bouton » is the owner's promise, and a hand-typed
 * `/reservation` is the other way in. The page asks the same
 * `resolveReservationMode` as the header, so the two cannot disagree.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ store: null as Record<string, unknown> | null }))

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('@/lib/cms/seo', () => ({ generateCmsMetadata: async () => ({}) }))
vi.mock('@/lib/convex-server', () => ({ resolveStorefrontStore: async () => state.store }))
vi.mock('@/app/(storefront)/reservation/_components/ReservationContent', () => ({
  default: () => null,
}))

const { default: ReservationPage } = await import('@/app/(storefront)/reservation/page')

beforeEach(() => {
  state.store = null
})

describe('/reservation', () => {
  it('is a 404 when the switch is off, even with a stored external address', async () => {
    state.store = { reservationMode: 'off', reservationUrl: 'https://www.thefork.fr/restaurant/x' }
    await expect(ReservationPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is a 404 for an external tool: the guest books there, not here', async () => {
    state.store = {
      reservationMode: 'external',
      reservationUrl: 'https://www.thefork.fr/restaurant/x',
    }
    await expect(ReservationPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is a 404 for a row that predates the switch and has no address', async () => {
    state.store = {}
    await expect(ReservationPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('is a 404 when no establishment is published', async () => {
    await expect(ReservationPage()).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('renders for a native establishment', async () => {
    state.store = { reservationMode: 'native' }
    await expect(ReservationPage()).resolves.toBeTruthy()
  })
})
