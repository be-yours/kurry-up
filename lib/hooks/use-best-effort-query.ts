'use client'

import { useMemo } from 'react'
import { useQueries, type RequestForQueries } from 'convex/react'
import { getFunctionName } from 'convex/server'
import type { FunctionReference, FunctionReturnType } from 'convex/server'
import { convexToJson } from 'convex/values'

/**
 * `useQuery` for a read that decorates a page, and must not take the page down.
 *
 * `useQuery` THROWS when the query does. That is right for the data a page is
 * built from, and wrong for an extra line that rides on an id the BROWSER
 * supplied: a basket kept in `localStorage`, an order id in a URL. Convex checks
 * `v.id("products")` before the handler runs, so an id this deployment never
 * issued — a basket saved before the site moved to a new backend, a link edited
 * by hand, a test fixture — is refused outright, and the throw lands in the
 * error boundary. The checkout read its dishes' preparation times that way and
 * answered « Cette page n'a pas pu s'afficher » over the payment form; the
 * cancel page did the same over its way back.
 *
 * This answers `undefined` for all three of loading, `"skip"` and failure, so a
 * caller renders the same thing in each: the line is simply absent. A page that
 * cannot do without the answer should keep `useQuery` and let the boundary
 * speak.
 */
export function useBestEffortQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  args: Query['_args'] | 'skip',
): FunctionReturnType<Query> | undefined {
  const name = getFunctionName(query)
  // Keyed on the serialised arguments, as `useQuery` does it: a request object
  // rebuilt every render would resubscribe every render.
  const key = args === 'skip' ? null : JSON.stringify(convexToJson(args))
  const queries = useMemo(
    (): RequestForQueries =>
      key === null ? {} : { result: { query, args: args as Query['_args'] } },
    // `query` and `args` are read through `name` and `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, key],
  )

  // `useQueries` hands a failed query back as an `Error` value; only the
  // single-query `useQuery` turns it into a throw.
  const result = useQueries(queries).result
  return result instanceof Error ? undefined : result
}
