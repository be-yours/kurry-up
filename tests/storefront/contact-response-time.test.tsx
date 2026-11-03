// @vitest-environment jsdom
/// <reference types="vite/client" />

/**
 * The contact page promises no response time of its own.
 *
 * It printed « Réponse rapide · Nous répondons sous 24h en moyenne » on every
 * site, and described its form with « … nous vous répondrons sous 24h »: a
 * commitment no establishment had made, and nothing in the CMS could take down.
 * The engine had already dropped « Délai estimé », « 10K+ clients satisfaits »
 * and « Livraison Gratuite » for the same reason — a figure about an
 * establishment is the establishment's to state.
 *
 * So a fresh site says nothing about a delay, and an owner who keeps a promise
 * can print it from « Engagement de réponse » in the CMS.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  /** block key → field key → text, as the CMS would hand it over. */
  cms: {} as Record<string, Record<string, string>>,
}))

vi.mock('convex/react', () => ({
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}))

vi.mock('@/lib/hooks/use-store-id', () => ({
  useStoreId: () => ({ storeId: 'store_1', store: null, storeCount: 1, isLoading: false }),
}))

vi.mock('@/lib/cms/useCmsPage', () => ({
  useCmsPage: () => ({
    isLoading: false,
    pageMeta: null,
    block: (blockKey: string) => ({
      values: {},
      field: (fieldKey: string) => ({
        text: state.cms[blockKey]?.[fieldKey] ?? null,
        mediaUrl: null,
        media: null,
        embedUrl: null,
        altText: null,
        raw: undefined,
      }),
    }),
  }),
}))

// `motion.div` writes its initial state as inline style and animates from there;
// nothing advances frames here, and what is under test is the text.
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

beforeEach(() => {
  state.cms = {}
})

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

/**
 * The response-time card: the primary-coloured, `rounded-[2rem]` block of the
 * sidebar. Found by those classes because the page gives it no other hook — the
 * first test below is the positive control that proves this selector still
 * finds a card when one is drawn, which is what keeps the "absent" assertions
 * from passing on a selector that matches nothing.
 */
function responseCard(container: HTMLElement): HTMLElement | undefined {
  return [...container.querySelectorAll('div')].find(
    (d) => d.className.includes('bg-primary') && d.className.includes('rounded-[2rem]'),
  )
}

async function mountContact(): Promise<HTMLElement> {
  const ContactPage = (await import('@/app/(storefront)/contact/_components/ContactContent'))
    .default
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(<ContactPage />)
  })
  return container
}

describe("a fresh site's contact page", () => {
  test('promises no response time', async () => {
    const container = await mountContact()
    const text = container.textContent ?? ''

    expect(responseCard(container)).toBeUndefined()
    expect(text).not.toMatch(/24\s?h/i)
    expect(text).not.toContain('Réponse rapide')
    expect(text).not.toContain('en moyenne')
    expect(text).not.toContain('Nous répondons')
  })

  test('describes its form without a delay', async () => {
    const text = (await mountContact()).textContent ?? ''

    expect(text).toContain('Remplissez le formulaire ci-dessous pour nous écrire.')
  })

  test("still prints the owner's own description of the form", async () => {
    state.cms = { form: { description: 'Dites-nous tout, on lit chaque message.' } }
    const text = (await mountContact()).textContent ?? ''

    expect(text).toContain('Dites-nous tout, on lit chaque message.')
    expect(text).not.toContain('Remplissez le formulaire ci-dessous pour nous écrire.')
  })
})

describe('the response-time card', () => {
  test('appears when the owner writes one, and says what they wrote', async () => {
    state.cms = {
      responseTime: {
        title: 'Réponse sous 48 h ouvrées',
        text: 'Notre équipe lit chaque message du lundi au vendredi',
      },
    }
    const container = await mountContact()

    expect(responseCard(container)).toBeDefined()
    expect(container.textContent).toContain('Réponse sous 48 h ouvrées')
    expect(container.textContent).toContain('Notre équipe lit chaque message du lundi au vendredi')
  })

  test('appears with a text alone, without a stray empty heading', async () => {
    state.cms = { responseTime: { text: 'Nous répondons le jour même' } }
    const container = await mountContact()

    expect(container.textContent).toContain('Nous répondons le jour même')
    // Two paragraphs would mean an empty title was drawn above the text.
    expect(responseCard(container)?.querySelectorAll('p')).toHaveLength(1)
  })

  test('is not drawn for a field that holds only spaces', async () => {
    state.cms = { responseTime: { title: '   ', text: '  ' } }
    const container = await mountContact()

    expect(responseCard(container)).toBeUndefined()
  })
})
