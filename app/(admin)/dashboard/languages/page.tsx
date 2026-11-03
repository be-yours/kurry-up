"use client"

import { LanguagesPage } from "@be-yours/admin"
import { UIOverridesContent } from "@/components/admin/languages"

/**
 * The Langues screen comes from the engine.
 *
 * Only the second tab stays local: it lists this storefront's own translation
 * keys (`lib/i18n`), which differ per template, so the engine cannot own it.
 * Adding a language, the default, RTL and auto-translation are all packaged.
 */
export default function Page() {
  return <LanguagesPage uiOverrides={<UIOverridesContent />} />
}
