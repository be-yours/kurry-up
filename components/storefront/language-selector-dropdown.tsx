"use client"

import { Globe } from "lucide-react"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@be-yours/ui"
import { COMMON_LANGUAGES, type LanguageConfig } from "@be-yours/core"
import { useLanguageStore, useTranslation } from "@be-yours/restaurant"

/**
 * The storefront language picker.
 *
 * Two things were wrong here and they compounded. It listed
 * `api.languages.listAll` — every language of every establishment on the
 * deployment, not the ones this restaurant has switched on — and it kept the
 * chosen code in its own `useState`, writing the cookie directly and never
 * telling the language store. So the store's `locale` stayed at its initial
 * `'fr'` whatever the customer picked, and `t()` had nothing to resolve
 * against.
 *
 * Now it reads and writes the store, which is the one place that knows both
 * the establishment's languages and the loaded catalogues. The store persists
 * to cookie and localStorage on its own.
 */
export function LanguageSelectorDropdown({
  variant = "solid",
}: {
  variant?: "transparent" | "solid"
}) {
  const availableLanguages = useLanguageStore((s) => s.availableLanguages)
  const setLocale = useLanguageStore((s) => s.setLocale)
  const { t, locale } = useTranslation()

  // One language is not a choice. Neither is none, which is also what an
  // establishment looks like before the initialiser has answered.
  if (availableLanguages.length <= 1) return null

  function handleChange(code: string) {
    if (code === locale) return
    setLocale(code)
    // The server half of the page — `<html lang>`, the CMS text, the SEO tags
    // — is rendered from the cookie the line above just wrote. A reload is
    // what makes it agree with the client.
    window.location.reload()
  }

  const currentLang =
    availableLanguages.find((l) => l.code === locale) ??
    availableLanguages.find((l) => l.isDefault) ??
    availableLanguages[0]

  const fallbackConfig = (code: string): LanguageConfig | undefined =>
    COMMON_LANGUAGES.find((l) => l.code === code)

  const isTransparent = variant === "transparent"
  const label = t("accessibility.changeLanguage")
  const tooltipLabel = currentLang?.nativeName ?? label

  return (
    <Popover>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`relative flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-300 ${
                  isTransparent
                    ? "bg-white/10 border-white/20 text-white hover:bg-white/20"
                    : "bg-card border-border shadow-sm text-accent-foreground hover:bg-muted"
                }`}
                aria-label={label}
              >
                <Globe className="h-4 w-4" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltipLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-56 p-2 rounded-2xl border border-border bg-card shadow-xl"
      >
        <h3 className="text-xs font-black uppercase tracking-widest text-muted-foreground px-3 pt-2 pb-3">
          {label}
        </h3>

        <div className="flex flex-col gap-1" data-testid="language-switcher">
          {availableLanguages.map((lang) => {
            const isSelected = lang.code === locale
            const flag = lang.flagEmoji ?? fallbackConfig(lang.code)?.flagEmoji

            return (
              <button
                key={lang.code}
                type="button"
                onClick={() => handleChange(lang.code)}
                data-testid={`lang-option-${lang.code}`}
                aria-current={isSelected ? "true" : undefined}
                className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors flex items-center gap-3 ${
                  isSelected
                    ? "bg-accent border border-primary/20"
                    : "hover:bg-muted border border-transparent"
                }`}
              >
                {flag && <span className="text-base">{flag}</span>}
                <span className="text-sm font-bold text-foreground">
                  {lang.nativeName}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
