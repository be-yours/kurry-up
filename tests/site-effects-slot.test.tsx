// @vitest-environment jsdom

/**
 * The one mount point for a site's own browser-side code.
 *
 * `SiteEffectsSlot` sits at the end of `<body>` in the root layout and renders
 * whatever component the site hands it (`site/components/SiteEffects.tsx` in
 * the template, nothing in the bench). Three promises are made to that code,
 * and each is pinned here the way it would fail:
 *
 *   AFTER HYDRATION. The server HTML holds none of it and hydrating that empty
 *   HTML is not a mismatch. A component whose render differs between the server
 *   and the browser is the control: without the slot it mismatches, behind the
 *   slot it does not — so the assertion cannot pass because the harness cannot
 *   see a mismatch.
 *
 *   NEVER IN THE ADMINISTRATION. Read from the route tree (the root layout's
 *   selected segment is the route group's folder name), not from URLs. The
 *   folder is checked to exist and to hold the dashboard, because a rename
 *   would leave the slot comparing against a name nothing carries.
 *
 *   NO LAYOUT SHIFT. The slot adds no markup and sits after `Providers`, at the
 *   end of `<body>`: what a site draws there cannot push the page it follows.
 *
 * This file ships to client sites with the rest of `tests/`, and is true there
 * for the same reason: it tests the engine's slot, which a site does not edit.
 * What a site puts inside `SiteEffects` is tested nowhere on its behalf.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ADMIN_ROUTE_GROUP, SiteEffectsSlot } from '@/components/site-effects-slot'
import { APP_ROOT } from './lib/repo-layout'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigation = vi.hoisted(() => ({ segment: null as string | null }))

vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: () => navigation.segment,
}))

/** What the slot can observe of a site's component: it mounts, and it cleans up. */
const lifecycle: string[] = []

function Probe() {
  useEffect(() => {
    lifecycle.push('mount')
    return () => {
      lifecycle.push('cleanup')
    }
  }, [])
  return <i data-probe="" />
}

const slot = (child: ReactNode = <Probe />) => <SiteEffectsSlot>{child}</SiteEffectsSlot>

const mounted: Array<{ root: Root; container: HTMLElement }> = []

function container(html = ''): HTMLElement {
  const element = document.createElement('div')
  element.innerHTML = html
  document.body.append(element)
  return element
}

async function mount(element: ReactNode, into: HTMLElement = container()) {
  const root = createRoot(into)
  mounted.push({ root, container: into })
  await act(async () => {
    root.render(element)
  })
  return { root, container: into }
}

async function hydrate(element: ReactNode, into: HTMLElement, onRecoverableError: () => void) {
  let root!: Root
  await act(async () => {
    root = hydrateRoot(into, element, { onRecoverableError })
  })
  mounted.push({ root, container: into })
}

afterEach(async () => {
  for (const { root, container: element } of mounted.splice(0)) {
    await act(async () => {
      root.unmount()
    })
    element.remove()
  }
  lifecycle.length = 0
  navigation.segment = null
  vi.restoreAllMocks()
})

describe('before hydration', () => {
  test.each([null, '(storefront)', '(auth)', ADMIN_ROUTE_GROUP])(
    'the server HTML holds none of the site code (segment %s)',
    (segment) => {
      navigation.segment = segment
      expect(renderToString(slot())).toBe('')
    },
  )

  test('hydrating that empty HTML is not a mismatch, and the site code arrives after it', async () => {
    navigation.segment = '(storefront)'
    const html = renderToString(slot())
    const onRecoverableError = vi.fn()

    const into = container(html)
    await hydrate(slot(), into, onRecoverableError)

    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(into.querySelector('[data-probe]')).not.toBeNull()
    expect(lifecycle).toEqual(['mount'])
  })

  describe('a component that renders differently on the server and in the browser', () => {
    let serving = true
    const Naive = () => <i>{serving ? 'server' : 'client'}</i>

    test('is the control: on its own it does mismatch, and the harness sees it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      serving = true
      const html = renderToString(<Naive />)
      serving = false

      const onRecoverableError = vi.fn()
      await hydrate(<Naive />, container(html), onRecoverableError)

      expect(onRecoverableError).toHaveBeenCalled()
    })

    test('behind the slot it does not', async () => {
      navigation.segment = '(storefront)'
      serving = true
      const html = renderToString(slot(<Naive />))
      serving = false

      const onRecoverableError = vi.fn()
      const into = container(html)
      await hydrate(slot(<Naive />), into, onRecoverableError)

      expect(onRecoverableError).not.toHaveBeenCalled()
      expect(into.textContent).toBe('client')
    })
  })
})

describe('the markup it adds', () => {
  test('is none: the site code is the only thing in the DOM', async () => {
    navigation.segment = '(storefront)'
    const { container: into } = await mount(slot())
    expect(into.innerHTML).toBe('<i data-probe=""></i>')
  })

  test('with nothing handed to it, it renders nothing at all', async () => {
    navigation.segment = '(storefront)'
    const { container: into } = await mount(<SiteEffectsSlot />)
    expect(into.innerHTML).toBe('')
  })
})

describe('the administration', () => {
  test('never mounts the site code', async () => {
    navigation.segment = ADMIN_ROUTE_GROUP
    const { container: into } = await mount(slot())

    expect(into.innerHTML).toBe('')
    expect(lifecycle).toEqual([])
  })

  test('unmounts it on a client navigation in, cleaning up, and mounts it again on the way out', async () => {
    navigation.segment = '(storefront)'
    const { root, container: into } = await mount(slot())
    expect(lifecycle).toEqual(['mount'])

    navigation.segment = ADMIN_ROUTE_GROUP
    await act(async () => {
      root.render(slot())
    })
    expect(into.innerHTML).toBe('')
    expect(lifecycle).toEqual(['mount', 'cleanup'])

    navigation.segment = '(auth)'
    await act(async () => {
      root.render(slot())
    })
    expect(into.querySelector('[data-probe]')).not.toBeNull()
    expect(lifecycle).toEqual(['mount', 'cleanup', 'mount'])
  })

  test('is named after a folder that exists and holds the dashboard', () => {
    // The slot compares the selected segment with this name. If the folder is
    // renamed, the comparison goes on running against a string no route carries
    // and the site code reaches every dashboard screen without a failure.
    expect(existsSync(join(APP_ROOT, 'app', ADMIN_ROUTE_GROUP, 'layout.tsx'))).toBe(true)
    expect(existsSync(join(APP_ROOT, 'app', ADMIN_ROUTE_GROUP, 'dashboard', 'page.tsx'))).toBe(true)
  })
})

describe('everywhere else', () => {
  // The storefront, the account screens, the QR game, the wall display, the CMS
  // preview, and the root-level not-found page, whose segment is not a name.
  test.each([null, '(storefront)', '(auth)', 'display', 'game', 'preview', '/_not-found'])(
    'mounts the site code (segment %s)',
    async (segment) => {
      navigation.segment = segment
      const { container: into } = await mount(slot())
      expect(into.querySelector('[data-probe]')).not.toBeNull()
    },
  )
})

describe('app/layout.tsx', () => {
  /** The layout without its comments, so a claim about the mount cannot pass for the mount. */
  const code = readFileSync(join(APP_ROOT, 'app', 'layout.tsx'), 'utf8')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  test('imports the slot from the engine', () => {
    expect(code).toMatch(
      /import\s*\{\s*SiteEffectsSlot\s*\}\s*from\s*['"]@\/components\/site-effects-slot['"]/,
    )
  })

  test('mounts it inside <body>, after Providers and not within them', () => {
    // After, so that what a site draws cannot push the page it follows; and
    // outside, so a crash in site code is not inside the providers.
    const providersClose = code.indexOf('</Providers>')
    const slotOpen = code.indexOf('<SiteEffectsSlot')
    const bodyClose = code.indexOf('</body>')

    expect(providersClose).toBeGreaterThan(-1)
    expect(slotOpen).toBeGreaterThan(providersClose)
    expect(bodyClose).toBeGreaterThan(slotOpen)
  })
})
