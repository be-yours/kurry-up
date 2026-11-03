"use client"

import { Globe } from "lucide-react"
import { useLanguageStore } from "@be-yours/restaurant"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Button,
} from "@be-yours/ui"

/**
 * Language Switcher — globe icon + dropdown with available languages.
 * Hidden when only one language is active.
 */
export function LanguageSwitcher() {
  const locale = useLanguageStore((state) => state.locale)
  const availableLanguages = useLanguageStore((state) => state.availableLanguages)
  const setLocale = useLanguageStore((state) => state.setLocale)
  const isReady = useLanguageStore((state) => state.isReady)

  // Don't render if not ready or only one language
  if (!isReady || availableLanguages.length <= 1) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          data-testid="language-switcher"
        >
          <Globe className="h-4 w-4" />
          <span className="text-sm uppercase">{locale}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {availableLanguages.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => setLocale(lang.code)}
            className={locale === lang.code ? "bg-accent" : ""}
            data-testid={`lang-option-${lang.code}`}
          >
            {lang.flagEmoji && (
              <span className="mr-2">{lang.flagEmoji}</span>
            )}
            <span>{lang.nativeName}</span>
            {locale === lang.code && (
              <span className="ml-auto text-xs text-muted-foreground">✓</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
