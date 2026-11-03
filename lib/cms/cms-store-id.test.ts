/**
 * A persisted store id the backend refuses used to take the whole storefront
 * down - a blank "This page couldn't load", not a page missing its CMS text.
 *
 * `useCmsPage` read the selection straight out of localStorage and sent it to
 * `cms.getPageBlocks`, whose `storeId: v.id("stores")` validator rejects an id
 * this deployment never issued. Convex raises that out of `useQuery` during
 * render, and `StorefrontShell` is in the `(storefront)` layout, so the whole
 * tree unmounted. `useStoreId` was written to recover from exactly this and
 * never got the chance: the CMS query fired first.
 *
 * These cases run the decision through a stand-in for that validator. What they
 * hold is that nothing `resolveCmsStoreId` returns can reach it and throw.
 */

import { describe, it, expect } from "vitest"
import { resolveCmsStoreId } from "./cms-store-id"

const PARIS = { _id: "k57d9x2m4n8p1q3r5s7t9v2w4x" }
const LYON = { _id: "k57d9x2m4n8p1q3r5s7t9v2w4y" }
const THIS_DEPLOYMENT = [PARIS, LYON]

/**
 * An id issued by another Convex deployment - the reported case, a browser
 * carrying a selection from a backend that no longer serves it.
 *
 * Note the shape: it is a well-formed Convex id, indistinguishable from the two
 * above by looking at it. Only the table it names makes it wrong, which is why
 * the deployment's own list is the only thing that can tell.
 */
const FOREIGN_ID = "j91b7c3d5e7f9g1h3j5k7m9n1p"

/**
 * `cms.getPageBlocks` declares `storeId: v.id("stores")`. Convex checks the
 * argument against its own tables and raises before the handler runs.
 */
function getPageBlocks(args: { storeId: string; pageSlug: string }) {
  if (!THIS_DEPLOYMENT.some((store) => store._id === args.storeId)) {
    throw new Error(
      'Value does not match validator `v.id("stores")`. Path: .storeId',
    )
  }
  return { blocks: [] }
}

/** What `useCmsPage` does with the decision: query, or skip. */
function askTheBackend(storeId: string | null) {
  if (storeId === null) return "skip"
  return getPageBlocks({ storeId, pageSlug: "homepage" })
}

describe("CMS store id", () => {
  it("queries with a persisted id this deployment issued", () => {
    expect(
      resolveCmsStoreId({
        persistedStoreId: LYON._id,
        stores: THIS_DEPLOYMENT,
      }),
    ).toBe(LYON._id)
  })

  it("skips rather than send an id from another deployment", () => {
    const storeId = resolveCmsStoreId({
      persistedStoreId: FOREIGN_ID,
      stores: THIS_DEPLOYMENT,
    })

    expect(storeId).toBeNull()
    // The page renders its code defaults. It used to render nothing at all.
    expect(() => askTheBackend(storeId)).not.toThrow()
    expect(askTheBackend(storeId)).toBe("skip")
  })

  it("skips a store that has been deleted, the same way", () => {
    const storeId = resolveCmsStoreId({
      persistedStoreId: "k57d9x2m4n8p1q3r5s7t9v2w4z",
      stores: THIS_DEPLOYMENT,
    })

    expect(storeId).toBeNull()
    expect(() => askTheBackend(storeId)).not.toThrow()
  })

  it("waits for the list instead of trusting the persisted id", () => {
    // Sending it now is the bug: at this point nothing has confirmed the id
    // belongs to this deployment, and a wrong guess is not recoverable.
    expect(
      resolveCmsStoreId({ persistedStoreId: FOREIGN_ID, stores: undefined }),
    ).toBeNull()
    expect(
      resolveCmsStoreId({ persistedStoreId: PARIS._id, stores: undefined }),
    ).toBeNull()
  })

  it("skips when nothing is selected", () => {
    expect(
      resolveCmsStoreId({ persistedStoreId: null, stores: THIS_DEPLOYMENT }),
    ).toBeNull()
    expect(
      resolveCmsStoreId({ persistedStoreId: "", stores: THIS_DEPLOYMENT }),
    ).toBeNull()
  })

  it("reads the caller's store rather than the visitor's when given one", () => {
    // The admin layout, showing the branding of the establishment being
    // administered while a customer tab sits on another one.
    expect(
      resolveCmsStoreId({
        requestedStoreId: LYON._id,
        persistedStoreId: PARIS._id,
        stores: THIS_DEPLOYMENT,
      }),
    ).toBe(LYON._id)
  })

  it("checks the caller's store too", () => {
    // The admin selection is persisted in the browser as well, so it goes
    // stale the same way and would crash the admin shell the same way.
    const storeId = resolveCmsStoreId({
      requestedStoreId: FOREIGN_ID,
      persistedStoreId: PARIS._id,
      stores: THIS_DEPLOYMENT,
    })

    expect(storeId).toBeNull()
    expect(() => askTheBackend(storeId)).not.toThrow()
  })

  it("falls back to the visitor's store while the caller has none yet", () => {
    expect(
      resolveCmsStoreId({
        requestedStoreId: null,
        persistedStoreId: PARIS._id,
        stores: THIS_DEPLOYMENT,
      }),
    ).toBe(PARIS._id)
  })
})
