/// <reference types="vite/client" />

/**
 * PayPal's approval screen names the establishment, not the word « Restaurant ».
 *
 * `application_context.brand_name` is what PayPal prints above the amount on its
 * own page — the one moment a diner checks who they are paying — and it was the
 * literal string "Restaurant" (#621). Every client site said the same thing, and
 * none of them said who.
 *
 * SOURCE-LEVEL, AND THAT IS A CHOICE WORTH STATING. `paypal.createOrder` is a
 * `"use node"` action whose body is one `fetch` at PayPal; nothing in this
 * repository stubs it, and standing that up would test a mock rather than the
 * request. What can go wrong here is not the expression — it is the store no
 * longer being fetched, or the literal creeping back — so that is what this
 * asserts. The two apps are held byte-identical by `check:divergence`, so one
 * file covers the template and the bench alike.
 */

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'convex', 'paypal.ts'), 'utf8')

/** Comments blanked, so prose about the old literal is not read as the literal. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

describe('the PayPal approval screen', () => {
  it('reads the establishment the order belongs to', () => {
    expect(code).toMatch(/internal\.stores\.internalGetById,\s*\{\s*\n?\s*id:\s*order\.storeId,/)
  })

  it('sends that establishment name as brand_name', () => {
    expect(code).toMatch(/brand_name:\s*store\?\.name/)
  })

  it('no longer hard-codes the word Restaurant as the brand', () => {
    expect(code).not.toMatch(/brand_name:\s*"Restaurant"/)
  })

  it('keeps a fallback rather than refusing the payment', () => {
    // A missing store name is not a reason to turn a diner away at the last
    // step, and the checkout has already proven the store exists.
    expect(code).toMatch(/brand_name:[^\n]*\|\|\s*"Restaurant"/)
  })

  it('still sends no payee, because the credentials are the merchant', () => {
    // The field the audit asked about. With one deployment per restaurant the
    // credential holder IS the payee; PayPal's `payee` is a marketplace feature
    // needing partner permissions, so its absence is correct, not an omission.
    expect(code).not.toContain('payee')
  })
})
