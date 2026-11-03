// @vitest-environment jsdom

/**
 * The account trigger on the storefront's full-screen mobile menu.
 *
 * THE DEFECT. That menu paints `bg-primary`, and `--primary` is dark in the
 * light scheme and light in the dark one (a mint, in the default palette). The
 * trigger was rendered with `variant="transparent"` — white ink on `white/10`,
 * written for the hero photograph — so in the dark scheme the « Connexion »
 * pill measured 1.93:1 against the 4.5:1 WCAG 1.4.3 asks, and 3.21:1 on hover.
 * The signed-in avatar's initial was no better: 1.80:1. A visitor whose device
 * is dark meets it with no toggle involved.
 *
 * WHAT THIS HOLDS, AND WHAT IT CANNOT. `tests/a11y/contrast.test.ts` measures
 * the pairs written in `user-menu.tsx`'s own class names, so it already fails on
 * `text-white` over `bg-primary-hover`. It cannot see the other half. The shared
 * `Button` brings classes of its own, written in `@be-yours/ui`: a `ghost` hover
 * to `bg-accent` / `text-accent-foreground` (and a `dark:` twin), which over
 * `--primary` were the 1.98:1 and 3.21:1 above, and a focus ring and border in
 * `--ring`, which IS `--primary` — the menu's own background — so a keyboard
 * user saw no indicator at all. They go away only when the call site names the
 * same property for the same state, which is a fact about the class list the
 * DOM ends up with. So that is what is read here.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* Radix positions the menu with a ResizeObserver, which jsdom does not have. */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** What `authClient.useSession` answers. Set per test. */
let session: { user: { name: string; email: string; image: string | null } } | null = null

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: session, isPending: false }),
    signOut: async () => {},
  },
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('sonner', () => ({ toast: { success: () => {} } }))

const { UserMenu } = await import('@/components/storefront/user-menu')

const mounted: Array<{ root: Root; container: HTMLElement }> = []

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  session = null
})

async function mount(variant: 'transparent' | 'solid' | 'overlay'): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<UserMenu variant={variant} />)
  })
  return container
}

/** Every class on an element with its variants attached: `dark:hover:bg-x` is one entry. */
const classesOf = (element: Element): string[] => [...element.classList]

/** Any utility that puts white ink or a white wash on a surface, whatever its variant. */
const WHITE_INK_OR_WASH = /(^|:)(text-white|bg-white)(\/|$)/

/** What the `ghost` variant hovers a fill to: `bg-accent`, and its `dark:…/50` twin. */
const GHOST_HOVER_FILL = /(^|:)bg-accent/

/** …and a hovered ink to: `text-accent-foreground`. */
const GHOST_HOVER_INK = /(^|:)text-accent/

/** The shared `Button`'s own focus colours: `focus-visible:border-ring`, `focus-visible:ring-ring`. */
const FOCUS_IN_RING_TOKEN = /(^|:)(border|ring)-ring$/

/** What the overlay draws instead: `--primary-foreground`, which reads on `--primary` by design. */
const FOCUS_IN_INK = [
  'focus-visible:border-primary-foreground',
  'focus-visible:ring-primary-foreground',
]

function offenders(element: Element, pattern: RegExp): string[] {
  return classesOf(element).filter((name) => pattern.test(name))
}

describe('the overlay variant, signed out', () => {
  test('is the pair the menu’s own close button uses, not white on a white wash', async () => {
    const container = await mount('overlay')
    const pill = container.querySelector('a[href="/sign-in"]')!

    expect(classesOf(pill)).toEqual(
      expect.arrayContaining(['bg-primary-hover', 'border-white/20', 'text-primary-foreground']),
    )
    expect(offenders(pill, WHITE_INK_OR_WASH)).toEqual([])
  })

  test('keeps that pair on hover, in both colour schemes', async () => {
    const container = await mount('overlay')
    const pill = container.querySelector('a[href="/sign-in"]')!

    expect(classesOf(pill)).toEqual(
      expect.arrayContaining([
        'hover:bg-primary-hover',
        'hover:text-primary-foreground',
        'dark:hover:bg-primary-hover',
      ]),
    )
    // The shared Button's `ghost` hover is what measured 1.98:1 (light) and
    // 3.21:1 (dark) over `--primary`. twMerge drops it only when the call site
    // names the same property for the same state.
    expect(offenders(pill, GHOST_HOVER_FILL)).toEqual([])
    expect(offenders(pill, GHOST_HOVER_INK)).toEqual([])
  })

  test('draws its keyboard focus in ink, not in the menu’s own colour', async () => {
    const container = await mount('overlay')
    const pill = container.querySelector('a[href="/sign-in"]')!

    expect(classesOf(pill)).toEqual(expect.arrayContaining(FOCUS_IN_INK))
    // `--ring` is `--primary` here, so the Button's own ring and border were
    // the menu's background drawn on the menu's background.
    expect(offenders(pill, FOCUS_IN_RING_TOKEN)).toEqual([])
  })

  test('leaves the two variants written for other grounds as they were', async () => {
    const transparent = (await mount('transparent')).querySelector('a[href="/sign-in"]')!
    expect(classesOf(transparent)).toEqual(
      expect.arrayContaining(['bg-white/10', 'border-white/20', 'text-white']),
    )

    const solid = (await mount('solid')).querySelector('a[href="/sign-in"]')!
    expect(classesOf(solid)).toEqual(
      expect.arrayContaining(['bg-card', 'border-border', 'text-accent-foreground']),
    )
  })
})

describe('the overlay variant, signed in', () => {
  test('reads its initial in ink on the menu’s own fill, not white on a wash', async () => {
    session = { user: { name: 'Jean Dupont', email: 'jean@example.com', image: null } }
    const container = await mount('overlay')
    const initial = container.querySelector('[data-slot="avatar-fallback"]')!

    expect(initial.textContent).toBe('J')
    expect(classesOf(initial)).toEqual(
      expect.arrayContaining(['bg-primary-hover', 'text-primary-foreground']),
    )
    expect(offenders(initial, WHITE_INK_OR_WASH)).toEqual([])
  })

  test('does not let the ghost hover wash the ring behind the avatar', async () => {
    session = { user: { name: 'Jean Dupont', email: 'jean@example.com', image: null } }
    const container = await mount('overlay')
    const trigger = container.querySelector('button[aria-haspopup="menu"]')!

    expect(classesOf(trigger)).toEqual(
      expect.arrayContaining([
        'border-white/20',
        'hover:border-white/40',
        'hover:bg-transparent',
        'dark:hover:bg-transparent',
      ]),
    )
    // The fill only. The trigger's own ink is never painted: the fallback inside
    // it names its own, so a hovered `text-accent-foreground` here reaches nothing.
    expect(offenders(trigger, GHOST_HOVER_FILL)).toEqual([])
  })

  test('draws its keyboard focus in ink, not in the menu’s own colour', async () => {
    session = { user: { name: 'Jean Dupont', email: 'jean@example.com', image: null } }
    const container = await mount('overlay')
    const trigger = container.querySelector('button[aria-haspopup="menu"]')!

    expect(classesOf(trigger)).toEqual(expect.arrayContaining(FOCUS_IN_INK))
    expect(offenders(trigger, FOCUS_IN_RING_TOKEN)).toEqual([])
  })
})

describe('the header', () => {
  test('puts the overlay variant, and no other, on the mobile menu', () => {
    const header = readFileSync(
      join(__dirname, '..', 'components/storefront/storefront-header.tsx'),
      'utf8',
    )
    // Everything from the overlay's own comment to the end of the file. The one
    // `UserMenu` above it, in the desktop bar, keeps `transparent` / `solid`,
    // which are right for the hero photograph and the opaque header.
    const start = header.indexOf('Mobile full-screen menu overlay')
    expect(start, 'the overlay marker comment moved: update this test').toBeGreaterThan(-1)
    const overlay = header.slice(start)

    expect(overlay).toMatch(/<UserMenu variant="overlay" \/>/)
    expect(overlay).not.toMatch(/<UserMenu variant="transparent"/)
  })
})
