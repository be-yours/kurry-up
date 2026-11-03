"use client"

/**
 * Storefront i18n initialiser.
 *
 * Everything the language store needs was already written; nothing filled it.
 * `initialize` had one call site, in a component that was never mounted;
 * `setOverrides` and `setStaticStrings` had none at all. So `isReady` stayed
 * false, `availableLanguages` stayed empty, `locale` stayed at its literal
 * `'fr'`, and switching language changed `<html lang>` and not one word a
 * customer could read.
 *
 * This mounts once, inside the storefront shell, and fills all three:
 *   1. the establishment's active languages → `initialize`
 *   2. the restaurateur's manual UI overrides → `setOverrides`
 *   3. the static JSON catalogues for those languages → `setStaticStrings`
 *
 * It renders nothing. Components read the result through `useTranslation()`.
 */

import { useEffect } from "react"
import { useQuery } from "convex/react"
import { useLanguageStore } from "@be-yours/restaurant"
import type { Language } from "@be-yours/restaurant"
import { resolveEstablishmentLanguages } from "@be-yours/core"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useStoreId } from "@/lib/hooks/use-store-id"
// `@/lib/i18n` is a different module — a re-export of the core i18n helpers.
// The static catalogues live in the directory beside it, hence the explicit
// `/index`. Both exist; the file wins the bare specifier.
import {
  loadAllStaticStrings,
  REFERENCE_LOCALE,
  REFERENCE_STRINGS,
} from "@/lib/i18n/index"

/**
 * Seed the source-language catalogue before anything renders.
 *
 * `loadAllStaticStrings` is a dynamic import and resolves a tick later, and
 * `t()` returns the key when it cannot resolve one. Without this the header
 * paints `nav.home nav.menu nav.about` for a frame on every cold load. Runs
 * once, at module evaluation, and only if nothing has been loaded yet — the
 * effect below replaces it with the full set.
 */
useLanguageStore.setState((state) =>
  state.staticStrings.size === 0
    ? { staticStrings: new Map([[REFERENCE_LOCALE, REFERENCE_STRINGS]]) }
    : {}
)

export function StorefrontI18nProvider() {
  const { storeId } = useStoreId()

  const initialize = useLanguageStore((s) => s.initialize)
  const setOverrides = useLanguageStore((s) => s.setOverrides)
  const setStaticStrings = useLanguageStore((s) => s.setStaticStrings)

  const languages = useQuery(
    api.languages.listActive,
    storeId ? { storeId: storeId as Id<"stores"> } : "skip"
  )
  const overrides = useQuery(
    api.translations.getUIOverrides,
    storeId ? { storeId: storeId as Id<"stores"> } : "skip"
  )

  // 1. Resolve the locale against what this establishment actually offers.
  //    `initialize` also writes the resolved locale back to the cookie, which
  //    is what lets the server half — `<html lang>`, the CMS reader, the SEO
  //    builder — agree with the client on the next request.
  useEffect(() => {
    if (!languages || languages.length === 0) return

    // `api.languages.listActive` is typed `any` — the shared handlers are —
    // so the element shape is named here rather than inferred.
    const rows = (languages as Language[]).map((l) => ({
      code: l.code,
      name: l.name,
      nativeName: l.nativeName,
      ...(l.flagEmoji ? { flagEmoji: l.flagEmoji } : {}),
      isDefault: l.isDefault,
      isActive: l.isActive,
    }))

    // Which language the establishment is written in is a policy question, not
    // an array index — see `resolveEstablishmentLanguages`. This used to read
    // `?? active[0]?.code`, and the first language an admin added became the
    // default for every diner (#325, NEW2-JOURNEY-2).
    const { languages: offered, defaultCode } = resolveEstablishmentLanguages(
      rows,
      REFERENCE_LOCALE
    )

    initialize(offered, defaultCode)
  }, [languages, initialize])

  // 2. Manual overrides beat the static catalogue: they are the restaurateur
  //    correcting a translation, and the machine must not win that argument.
  useEffect(() => {
    if (!overrides) return
    setOverrides(overrides)
  }, [overrides, setOverrides])

  // 3. Prefetch every active language's JSON so `t()` stays synchronous.
  useEffect(() => {
    if (!languages || languages.length === 0) return
    const codes = (languages as Language[]).map((l) => l.code)

    let cancelled = false
    void loadAllStaticStrings(codes).then((strings) => {
      // A language toggled off mid-flight would otherwise land after the
      // effect that replaced this one.
      if (cancelled) return

      // Back every language with the reference catalogue. Only fr, en and es
      // ship a JSON file, and the product sells "the admin adds ANY language"
      // — so a store offering German would otherwise get an empty map and
      // `t()` would render `nav.home` on the header. Falling through to the
      // source language is the right degradation: the chrome stays readable
      // while GPT translates the catalogue itself.
      const backed = new Map<string, Record<string, string>>()
      for (const code of codes) {
        backed.set(code, { ...REFERENCE_STRINGS, ...(strings.get(code) ?? {}) })
      }
      setStaticStrings(backed)
    })

    return () => {
      cancelled = true
    }
  }, [languages, setStaticStrings])

  return null
}
