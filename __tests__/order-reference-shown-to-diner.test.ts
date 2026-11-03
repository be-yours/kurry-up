/**
 * The order reference a diner is shown is the one the restaurant sees.
 *
 * WHAT WENT WRONG. The cash confirmation printed `lastOrderId.slice(-6)` — the
 * tail of the internal Convex id, « #8FWXRV » — while the admin orders list, the
 * kitchen ticket, the invoice and « Mes commandes » all say « ORD-2026-00001 ».
 * A diner who telephoned the restaurant to ask about their order was quoting a
 * reference that exists nowhere the owner looks. The cancel page did the same,
 * and the card success page fell back to it whenever the number was missing.
 * Found by taking one order from the storefront to the invoice.
 *
 * WHY SOURCE-LEVEL. These are client components behind the cart store, Convex
 * hooks and a payment redirect; what broke is WHICH value they print, and that
 * is exactly what a rendering harness would have to mock away. The real round
 * trip — place a cash order, read the confirmation, find the same number in the
 * admin — is the e2e rehearsal's, not a unit test's.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CHECKOUT = join(__dirname, '..', 'app', '(storefront)', 'checkout')

/** Comments removed: each fix here is explained in one that quotes the defect. */
const code = (file: string): string =>
  readFileSync(join(CHECKOUT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

const PAGES = ['page.tsx', 'cancel/page.tsx', 'success/page.tsx'] as const

describe('the order reference on the checkout pages', () => {
  for (const page of PAGES) {
    it(`${page} never prints the tail of the internal id`, () => {
      expect(code(page)).not.toMatch(/\.slice\(\s*-6\s*\)/)
    })
  }

  it('the cash confirmation reads the number back from the order', () => {
    const source = code('page.tsx')
    expect(source).toMatch(/api\.orders\.getPaymentState/)
    expect(source).toMatch(/Commande #\{confirmedOrder\.orderNumber\}/)
  })

  it('the cancel page reads it back too', () => {
    const source = code('cancel/page.tsx')
    expect(source).toMatch(/api\.orders\.getPaymentState/)
    expect(source).toMatch(/#\{order\.orderNumber\}/)
  })

  it('the card success page prints the number it was given, or nothing', () => {
    expect(code('success/page.tsx')).toMatch(/Commande #\{outcome\.orderNumber\}/)
  })
})
