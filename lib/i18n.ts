/**
 * i18n (Internationalization) integration
 *
 * Re-exports i18n utilities from @be-yours/core
 * for multilingual support in the themes app.
 *
 * @example
 * ```ts
 * import { detectLocale, setLocale, createTranslator } from '@/lib/i18n'
 *
 * const locale = detectLocale({ supportedLocales: ['en', 'fr', 'es'] })
 * const t = createTranslator(locale, translations)
 * ```
 */

// Types
export type {
  Locale,
  TranslationKey,
  TranslationValue,
  TranslationMap,
  Direction,
  LanguageConfig,
  I18nConfig,
  TranslationContext,
  TranslationParams,
  TranslatorFunction,
  LocaleDetectionOptions,
  TranslatedItem,
  UseTranslationReturn,
  UseLocaleReturn,
  LanguageSwitcherProps,
} from '@be-yours/core'

// Configuration
export {
  RTL_LANGUAGES,
  DEFAULT_I18N_CONFIG,
  COMMON_LANGUAGES,
  isRtlLocale,
  getLocaleDirection,
  findLanguageConfig,
} from '@be-yours/core'

// Locale Detection
export {
  detectLocaleFromCookie,
  detectLocaleFromLocalStorage,
  detectLocaleFromBrowser,
  detectLocaleFromHeader,
  detectLocale,
} from '@be-yours/core'

// Locale Storage
export {
  setLocaleCookie,
  setLocaleLocalStorage,
  setLocale,
  clearLocale,
  getLocaleFromCookie,
  getLocaleFromLocalStorage,
} from '@be-yours/core'

// Translation Utilities
export {
  createTranslator,
  createTranslators,
  validateTranslationMap,
  mergeTranslations,
  getMissingKeys,
} from '@be-yours/core'

// GPT Translation (for admin auto-translation feature)
export {
  estimateTranslationCost,
  translateText,
  batchTranslate,
  calculateTotalCost,
  groupTranslationResults,
} from '@be-yours/core'

// Hook types (implementation in app)
export type {
  UseTranslation,
  UseLocale,
  UseTranslator,
  UseDirection,
  LanguageSwitcherComponent,
  I18nProviderProps,
  I18nProviderComponent,
} from '@be-yours/core'
