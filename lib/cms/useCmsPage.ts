"use client"

import { useQuery } from "convex/react"
import { useSearchParams } from "next/navigation"
import { api } from "@/convex/_generated/api"
import {
  useStorefrontStoreSelection,
  useLanguageStore,
} from "@be-yours/restaurant"
import { resolveCmsStoreId, type IdentifiedStore } from "./cms-store-id"
import {
  initialDataFor,
  localeFor,
  resolveCmsBlock,
  type CmsBlockAccessor,
  type CmsInitialData,
  type CmsPageData,
} from "./page-data"
import type { Id } from "@/convex/_generated/dataModel"

// The accessor types live with the resolver, which the server reader shares.
// Re-exported so that `@/lib/cms` and every existing import keep resolving.
export type { CmsBlockAccessor, CmsFieldAccessor } from "./page-data"

export interface UseCmsPageResult {
  /**
   * `true` while neither the live query nor a server copy has anything to show.
   * With `initialData` that is never the case for the establishment the server
   * rendered, which is the point of passing it.
   */
  isLoading: boolean
  block: (blockKey: string) => CmsBlockAccessor
  /**
   * What the public query says about the page, which is deliberately little.
   *
   * `hasUnpublishedChanges`, `draftUpdatedAt` and `updatedBy` left in #97: they
   * are editorial state and a staff user id, and this query is anonymous. The
   * admin editor reads them from `getAdminPageBlocks`, which is guarded. Nothing
   * on the storefront ever read one.
   */
  pageMeta: {
    hasPublished: boolean
    publishedAt?: number
  } | null
}

interface UseCmsPageOptions {
  mode?: "public" | "preview"
  /**
   * Whose content to read. Defaults to the store the visitor is browsing.
   *
   * The admin layout passes its own selection instead: an owner editing Lyon
   * while a customer tab sits on Paris must see Lyon's branding, and the two
   * zones no longer share a selection.
   *
   * Either way the id is checked against this deployment before it is sent -
   * see `resolveCmsStoreId`. Both selections are persisted in the browser, so
   * both can name an establishment that is not here any more.
   */
  storeId?: string | null
  /**
   * The page as the server read it (`getCmsInitialData`), to render from until
   * the live query answers.
   *
   * It is what puts the owner's words in the first HTML instead of the code's
   * sample copy, and what hydration renders from: the live query has no answer
   * on the server or on the first client render, so the two would otherwise
   * both print the sample copy and then both change. The live query takes over
   * the moment it has data, and an owner's later edit reaches the page exactly
   * as before.
   *
   * Ignored in `"preview"` mode (the server only holds the published page) and
   * for any establishment other than the one it was read for - see
   * `initialDataFor`.
   */
  initialData?: CmsInitialData | null
}

export function useCmsPage(
  pageSlug: string,
  options?: UseCmsPageOptions,
): UseCmsPageResult {
  const searchParams = useSearchParams()
  const isPreviewParam = searchParams.get("preview") === "true"
  const mode = options?.mode ?? (isPreviewParam ? "preview" : "public")
  const storefrontStoreId = useStorefrontStoreSelection((s) => s.storeId)
  // Every establishment of this deployment, so a persisted id can be vouched
  // for before it reaches a query that would refuse it and take the page down
  // with it. Convex de-duplicates this subscription with the one `useStoreId`
  // already holds in the storefront shell, so it costs one query, not two.
  const stores = useQuery(api.stores.list) as IdentifiedStore[] | undefined
  const storeId = (resolveCmsStoreId({
    requestedStoreId: options?.storeId,
    persistedStoreId: storefrontStoreId,
    stores,
  }) ?? undefined) as Id<"stores"> | undefined
  const storeLocale = useLanguageStore((s) => s.locale)
  const languageReady = useLanguageStore((s) => s.isReady)

  // Choose query based on mode
  const publicData = useQuery(
    api.cms.getPageBlocks,
    mode === "public" && storeId ? { storeId, pageSlug } : "skip",
  )

  const previewData = useQuery(
    api.cms.getPreviewPageBlocks,
    mode === "preview" && storeId ? { storeId, pageSlug } : "skip",
  )

  // The live answer wins as soon as there is one. `undefined` is Convex's "not
  // here yet"; anything else, `null` included, is an answer. Until then the
  // server's copy stands in, so the first client render matches the HTML it
  // hydrates.
  const initial = mode === "public" ? initialDataFor(options?.initialData, storeId) : null
  const live = (mode === "public" ? publicData : previewData) as CmsPageData | null | undefined
  const data = live === undefined ? initial?.data : live
  const locale = localeFor(initial, storeLocale, languageReady)
  const isLoading = data === undefined && !!storeId

  return {
    isLoading,
    block: (blockKey: string) => resolveCmsBlock(data, blockKey, locale),
    pageMeta: data?.pageMeta ?? null,
  }
}
