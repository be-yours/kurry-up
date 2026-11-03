// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * The home page's cards speak the visitor's language, and the categories band goes somewhere.
 *
 * Three English words were typed into a French storefront — « Price » on the
 * trending-dish cards, « Read More » on the blog teasers, « Items » on the
 * category cards — and the categories band, which advertised the carte by
 * category, answered a click with an English toast (« Exploring Pizzas… ») and
 * navigated nowhere. A client had to hide the whole band in CSS.
 *
 * The labels come from the catalogue now (so they follow the language and a
 * restaurateur can reword them in « Traductions UI »), and a category card is a
 * link to `/menu?category=<slug>`, the address the carte already filters on.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fr from '@/lib/i18n/locales/fr.json'
import en from '@/lib/i18n/locales/en.json'
import es from '@/lib/i18n/locales/es.json'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  categories: undefined as unknown,
}))

vi.mock('convex/react', () => ({
  useQuery: () => state.categories,
  useMutation: () => async () => undefined,
}))

vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({ storeId: 'store_1', store: null, storeCount: 1, isLoading: false }),
}))

// The favourite heart reads the session and a persisted store; neither is what
// these cards are about.
vi.mock('@/components/website/favorite-button', () => ({
  FavoriteButton: () => null,
}))

vi.mock('next/image', () => ({
  default: ({ alt, className }: { alt?: string; className?: string }) => (
    // A plain <img>: next/image needs a loader and a real file, and what is
    // under test is the label beside it.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt ?? ''} className={className} src="data:," />
  ),
}))

vi.mock('framer-motion', () => {
  const passthrough = ({
    children,
    ...rest
  }: Record<string, unknown> & { children?: React.ReactNode }) => {
    const {
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      variants: _v,
      whileHover: _wh,
      whileTap: _wt,
      whileInView: _wi,
      viewport: _vp,
      layout: _l,
      layoutId: _li,
      drag: _d,
      ...html
    } = rest
    return <div {...(html as Record<string, unknown>)}>{children}</div>
  }
  return { motion: new Proxy({}, { get: () => passthrough }) }
})

const mounted: Array<{ root: Root; container: HTMLElement }> = []

async function speak(locale: 'fr' | 'en' | 'es') {
  const { useLanguageStore } = await import('@be-yours/restaurant')
  act(() => {
    useLanguageStore.setState({
      locale,
      defaultLocale: 'fr',
      availableLanguages: [],
      overrides: {},
      staticStrings: new Map([
        ['fr', fr],
        ['en', en],
        ['es', es],
      ]),
      isReady: true,
    })
  })
}

beforeEach(async () => {
  state.categories = undefined
  await speak('fr')
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(node)
  })
  return container
}

describe('the trending-dish card', () => {
  async function mountMeal() {
    const { MealCard } = await import('@/components/website/meal-card')
    const { TooltipProvider } = await import('@be-yours/ui')
    return mount(
      <TooltipProvider>
        <MealCard id="p1" title="Pastels au poisson" price={0.8} image="" />
      </TooltipProvider>,
    )
  }

  test('labels its price « Prix » on a French storefront', async () => {
    const text = (await mountMeal()).textContent ?? ''

    expect(text).toContain('Prix')
    expect(text).not.toContain('Price')
  })

  test('follows the language', async () => {
    await speak('en')
    expect((await mountMeal()).textContent).toContain('Price')
  })
})

describe('the blog teaser', () => {
  async function mountTeaser() {
    const { BlogCard } = await import('@/components/website/blog-card')
    return mount(<BlogCard title="Traiteur et décoration d'événements" date="12 Oct" image="" />)
  }

  test('invites the visitor to « Lire la suite », not to « Read More »', async () => {
    const text = (await mountTeaser()).textContent ?? ''

    expect(text).toContain('Lire la suite')
    expect(text).not.toContain('Read More')
  })

  test.each([
    ['en', 'Read more'],
    ['es', 'Leer más'],
  ] as const)('says it in %s too', async (locale, expected) => {
    await speak(locale)
    expect((await mountTeaser()).textContent).toContain(expected)
  })
})

describe('the category card', () => {
  async function mountCard(props: { itemsCount?: number; title?: string; href?: string } = {}) {
    const { CategoryCard } = await import('@/components/website/category-card')
    return mount(
      <CategoryCard
        title={props.title ?? 'Pizzas'}
        icon="🍕"
        href={props.href ?? '/menu?category=pizzas'}
        {...(props.itemsCount === undefined ? {} : { itemsCount: props.itemsCount })}
        color="from-orange-500/20 to-orange-500/5"
        borderColor="border-orange-200"
      />,
    )
  }

  test('is a link to the carte, narrowed to its category', async () => {
    const container = await mountCard()

    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/menu?category=pizzas')
    expect(link?.textContent).toContain('Pizzas')
  })

  test('counts in French, where zero is singular', async () => {
    expect((await mountCard({ itemsCount: 12 })).textContent).toContain('12 produits')
  })

  test.each([
    [0, '0 produit'],
    [1, '1 produit'],
    [2, '2 produits'],
  ])('reads %i as « %s »', async (count, expected) => {
    const text = (await mountCard({ itemsCount: count })).textContent ?? ''

    expect(text).toContain(expected)
    // « 0 produit » must not be read as the start of « 0 produits ».
    if (count < 2) expect(text).not.toContain(`${expected}s`)
  })

  test.each([
    ['en', 0, '0 items'],
    ['en', 1, '1 item'],
    ['en', 3, '3 items'],
    ['es', 0, '0 productos'],
    ['es', 1, '1 producto'],
  ] as const)('counts in %s: %i → %s', async (locale, count, expected) => {
    await speak(locale)
    const text = (await mountCard({ itemsCount: count })).textContent ?? ''

    expect(text).toContain(expected)
    if (count === 1) expect(text).not.toContain(`${expected}s`)
  })

  test('never prints the English « Items », nor a zero nobody measured', async () => {
    const text = (await mountCard()).textContent ?? ''

    expect(text).not.toContain('Items')
    expect(text).not.toMatch(/\b0\b/)
  })

  test('reads a locale it cannot parse as a plural rather than failing', async () => {
    await speak('fr')
    const { useLanguageStore } = await import('@be-yours/restaurant')
    act(() => {
      useLanguageStore.setState({ locale: 'not a locale' })
    })

    expect((await mountCard({ itemsCount: 2 })).textContent).toContain('2')
  })
})

describe('the categories band', () => {
  async function mountBand() {
    const { CategoriesSection } = await import('@/components/website/categories-section')
    return mount(
      <CategoriesSection
        badge="Découvrez"
        sectionTitle="Nos catégories"
        description="Parcourez la carte."
      />,
    )
  }

  const rows = [
    { _id: 'c1', name: 'Pizzas', slug: 'pizzas', productCount: 12, isActive: true },
    {
      _id: 'c2',
      name: 'Formules du midi',
      slug: 'formules du midi',
      productCount: 1,
      isActive: true,
    },
    // An old row with no slug: the whole carte, not a filter that matches nothing.
    { _id: 'c3', name: 'Boissons', productCount: 0, isActive: true },
  ]

  test('links every category to the carte filtered on its slug', async () => {
    state.categories = rows
    const container = await mountBand()

    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/menu?category=pizzas',
      '/menu?category=formules%20du%20midi',
      '/menu',
    ])
  })

  test('prints no English and raises no toast', async () => {
    state.categories = rows
    const text = (await mountBand()).textContent ?? ''

    expect(text).toContain('12 produits')
    expect(text).toContain('1 produit')
    expect(text).not.toMatch(/Items|Exploring|available in this category/)
  })

  test("shows a category's name in the visitor's language, as the carte does", async () => {
    state.categories = [{ ...rows[0], translations: { en: { name: 'Pizzas to share' } } }]
    await speak('en')
    const container = await mountBand()

    expect(container.textContent).toContain('Pizzas to share')
  })

  test('hides itself for an establishment with no category', async () => {
    state.categories = []
    expect((await mountBand()).querySelector('section')).toBeNull()
  })
})
