/**
 * The footer's social links, as the owner configured them.
 *
 * The three icons used to be hard-coded `href="#"`: every delivered site
 * showed Facebook, X and Instagram buttons that went nowhere, whether or not
 * the establishment had an account at all. An icon now appears only when its
 * address is entered in the CMS (« Layout du storefront » → « Réseaux
 * sociaux »), and only as an `https:` URL — the value is rendered as an
 * `href`, so `javascript:` and its cousins never reach the page.
 *
 * The list of networks is closed and written down ONCE, here. The CMS block
 * declares one field per entry, the footer reads one field and draws one glyph
 * per entry, and `tests/storefront/social-links-coverage.test.ts` fails when
 * the three stop agreeing — which is how a client on Instagram, TikTok and
 * Snapchat was left with an engine that could show only Facebook, Instagram and
 * X. Adding a network is one line in this list, one field in the CMS block and
 * one glyph in `components/storefront/social-icons.tsx`.
 */

/**
 * Every network the footer can show, in the order it shows them.
 *
 * Facebook and Instagram keep the lead they always had; X, which used to be
 * third, moves behind the newer entries so that a site on the short list sees
 * its icons in the order it is used to.
 */
export const SOCIAL_PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'snapchat',
  'youtube',
  'twitter',
  'linkedin',
] as const

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

export interface SocialLink {
  platform: SocialPlatform
  href: string
  label: string
}

/** What a screen reader calls each icon. Brand names, so not translated. */
const LABELS: Record<SocialPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  youtube: 'YouTube',
  twitter: 'X (Twitter)',
  linkedin: 'LinkedIn',
}

/** An `https:` URL, trimmed, or null. */
export function safeSocialUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

/** The links to render, in a fixed order, skipping every one not configured. */
export function socialLinks(
  values: Partial<Record<SocialPlatform, string | null | undefined>>,
): SocialLink[] {
  return SOCIAL_PLATFORMS.flatMap((platform) => {
    const href = safeSocialUrl(values[platform])
    return href ? [{ platform, href, label: LABELS[platform] }] : []
  })
}
