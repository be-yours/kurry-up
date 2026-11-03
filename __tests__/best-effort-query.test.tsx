// @vitest-environment jsdom

/**
 * A line that decorates the checkout cannot take the checkout down.
 *
 * WHAT WENT WRONG. The order summary was given a preparation time computed from
 * the basket's dishes, read with `useQuery(api.products.getManyByIds, …)`. The
 * ids come out of `localStorage`, Convex checks `v.id("products")` before the
 * handler runs, and `useQuery` throws what the query throws — so a basket
 * holding an id this deployment never issued put « Cette page n'a pas pu
 * s'afficher » where the payment form belongs. Three e2e specs seed exactly such
 * a basket (`productId: "p1"`) and failed on the heading they wait for; the
 * cancel page, which reads the order it names off the URL, had the same hole.
 *
 * Two halves, because the defect lived between them:
 *   1. the hook answers `undefined` where `useQuery` throws;
 *   2. the pages that read an id the browser supplied go through the hook.
 */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** What `useQueries` answers on the next render, and every request it was given. */
let answer: unknown
const requests: unknown[] = []

vi.mock('convex/react', () => ({
  useQueries: (queries: unknown) => {
    requests.push(queries)
    return { result: answer }
  },
}))

import { api } from '@/convex/_generated/api'
import { useBestEffortQuery } from '@/lib/hooks/use-best-effort-query'

let container: HTMLElement
let root: Root

beforeEach(() => {
  answer = undefined
  requests.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** What the hook handed back on the latest render. */
let seen: unknown

/**
 * One component for every render in a test, so a second `read` re-renders the
 * same instance — with a `Probe` rebuilt per call, React would remount it and
 * throw its memo away, which is not what a page does between two renders.
 */
function Probe({ args }: { args: { ids: string[] } | 'skip' }) {
  const value = useBestEffortQuery(api.products.getManyByIds, args as never)
  // Recorded in an effect, which `act` flushes: a render must not write to a
  // variable outside itself.
  useEffect(() => {
    seen = value
  })
  return null
}

/** Renders the hook and returns what it handed back. */
function read(args: { ids: string[] } | 'skip'): unknown {
  seen = 'never rendered'
  act(() => root.render(<Probe args={args} />))
  return seen
}

describe('useBestEffortQuery', () => {
  it('hands back the answer once there is one', () => {
    answer = [{ _id: 'p1', preparationTime: 12 }]

    expect(read({ ids: ['p1'] })).toEqual([{ _id: 'p1', preparationTime: 12 }])
  })

  it('answers undefined where `useQuery` would have thrown', () => {
    // `useQueries` returns a failed query as an `Error` value, and `useQuery`
    // is the one that re-throws it — this is the value the checkout met.
    answer = new Error('ArgumentValidationError: Value does not match validator')

    expect(() => read({ ids: ['p1'] })).not.toThrow()
    expect(read({ ids: ['p1'] })).toBeUndefined()
  })

  it('answers undefined while the query is loading', () => {
    answer = undefined

    expect(read({ ids: ['p1'] })).toBeUndefined()
  })

  it('asks for nothing when told to skip', () => {
    read('skip')

    expect(requests).toEqual([{}])
  })

  it('does not resubscribe when the arguments are rebuilt but equal', () => {
    // The page builds `{ ids }` anew on every render; a request object that
    // followed suit would unsubscribe and subscribe on every one of them.
    read({ ids: ['p1', 'p2'] })
    const first = requests[requests.length - 1]
    read({ ids: ['p1', 'p2'] })
    const second = requests[requests.length - 1]

    // `Object.is`, not `toBe`: on a failure `toBe` tries to print both, and a
    // function reference does not survive being printed.
    expect(Object.is(second, first)).toBe(true)
  })

  it('asks again when the arguments change', () => {
    read({ ids: ['p1'] })
    const first = requests[requests.length - 1]
    read({ ids: ['p1', 'p2'] })

    expect(Object.is(requests[requests.length - 1], first)).toBe(false)
  })
})

describe('the pages that read an id the browser supplied', () => {
  const CHECKOUT = join(__dirname, '..', 'app', '(storefront)', 'checkout')

  /** Comments removed: the reason each read is best-effort is written in one. */
  const code = (file: string): string =>
    readFileSync(join(CHECKOUT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')

  const READS = [
    // The basket's dishes: ids out of localStorage.
    { page: 'page.tsx', query: 'api.products.getManyByIds' },
    // The number of the order just placed.
    { page: 'page.tsx', query: 'api.orders.getPaymentState' },
    // The order a cancelled payment names: an id off the URL.
    { page: 'cancel/page.tsx', query: 'api.orders.getPaymentState' },
  ] as const

  for (const { page, query } of READS) {
    const escaped = query.replace(/\./g, '\\.')

    it(`${page} reads ${query} through the best-effort hook`, () => {
      expect(code(page)).toMatch(new RegExp(`useBestEffortQuery\\(\\s*${escaped}`))
    })

    it(`${page} does not read ${query} with a plain useQuery`, () => {
      expect(code(page)).not.toMatch(new RegExp(`\\buseQuery\\(\\s*${escaped}`))
    })
  }
})
