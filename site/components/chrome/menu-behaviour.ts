/**
 * The phone menu's behaviour — CLIENT ZONE. Owner: agent « chrome » (site/ART_DIRECTION.md § 10).
 *
 * The engine mounts `div.fixed.inset-0.bg-primary` while the menu is open and gives it no dialog semantics.
 * Here, from the outside and with attributes only (never a class or a text React rendered):
 *   - dialog semantics (`role`, `aria-modal`, `aria-label`), `aria-expanded` on the burger;
 *   - focus moves to the close cross, Tab and Shift+Tab cycle inside the panel, Escape closes it, the focus
 *     goes back to the burger when the panel closes on the same page;
 *   - the page under the panel does not scroll (`html[data-ky-menu]`, chrome.css);
 *   - the closing shutter: framer keeps the node 300 ms for its exit, chrome.css neutralises framer's slide,
 *     so `data-ky-sortie` runs the shutter back (or hides the panel at once under reduced motion);
 *   - a window widened past 1279 px (where the panel is hidden) closes it.
 *
 * Idempotent (StrictMode mounts twice in dev): the cleanup removes every attribute and listener.
 */

import { FOCUSABLE, SEL, closeButton, find, hydrated } from './engine-nodes'

export function mountMenuBehaviour(): () => void {
  const html = document.documentElement
  const wide = window.matchMedia('(min-width: 1280px)')
  let overlay: HTMLElement | null = null
  let openedOn = ''
  let disposed = false

  const lock = (on: boolean) => {
    if (on) html.setAttribute('data-ky-menu', '')
    else html.removeAttribute('data-ky-menu')
  }

  const focusables = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0)

  const isClosing = (el: HTMLElement) => el.hasAttribute('data-ky-sortie')

  const onOpen = (el: HTMLElement) => {
    overlay = el
    openedOn = location.pathname
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('aria-label', 'Menu')
    lock(true)
    window.requestAnimationFrame(() => {
      if (!disposed && overlay === el && !isClosing(el)) closeButton(el)?.focus({ preventScroll: true })
    })
  }

  const onClosing = (el: HTMLElement, burger: HTMLElement | null) => {
    el.setAttribute('data-ky-sortie', '')
    el.setAttribute('aria-hidden', 'true')
    lock(false)
    const active = document.activeElement
    const lost = !active || active === document.body || el.contains(active)
    // a room was chosen: the new page owns the focus; otherwise it goes back to the burger
    if (lost && location.pathname === openedOn) burger?.focus({ preventScroll: true })
  }

  const sync = () => {
    if (disposed) return
    const found = document.querySelector<HTMLElement>(SEL.overlay)
    const el = hydrated(found) ? found : null
    const burger = find(SEL.burger)

    if (!el) {
      if (overlay) {
        overlay = null
        lock(false)
      }
    } else {
      if (el !== overlay) onOpen(el)
      // the engine flips the burger's name in the same render that starts framer's exit
      const cross = closeButton(el)
      const closing = Boolean(cross && burger && burger.getAttribute('aria-label') !== cross.getAttribute('aria-label'))
      if (closing && !isClosing(el)) onClosing(el, burger)
      else if (!closing && isClosing(el)) {
        el.removeAttribute('data-ky-sortie')
        el.removeAttribute('aria-hidden')
        lock(true)
      }
    }

    if (burger) {
      const open = String(Boolean(el && !isClosing(el)))
      if (burger.getAttribute('aria-expanded') !== open) burger.setAttribute('aria-expanded', open)
    }
  }

  const observer = new MutationObserver(sync)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label'],
  })
  sync()

  const onKey = (event: KeyboardEvent) => {
    const el = overlay
    if (!el || !el.isConnected || isClosing(el)) return
    if (event.key === 'Escape') {
      // a Radix layer opened from the menu (account menu) closes first
      if (event.defaultPrevented || document.querySelector('[data-slot="dropdown-menu-content"]')) return
      event.preventDefault()
      closeButton(el)?.click()
      return
    }
    if (event.key !== 'Tab') return
    const items = focusables(el)
    if (items.length === 0) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const step = event.shiftKey ? -1 : 1
    const next = at < 0 ? (event.shiftKey ? items.length - 1 : 0) : (at + step + items.length) % items.length
    items[next]?.focus()
  }
  document.addEventListener('keydown', onKey)

  const onWide = () => {
    if (wide.matches && overlay && !isClosing(overlay)) closeButton(overlay)?.click()
  }
  wide.addEventListener('change', onWide)

  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener('keydown', onKey)
    wide.removeEventListener('change', onWide)
    lock(false)
    const el = document.querySelector<HTMLElement>(SEL.overlay)
    if (el) for (const name of ['role', 'aria-modal', 'aria-label', 'aria-hidden', 'data-ky-sortie']) el.removeAttribute(name)
    document.querySelector<HTMLElement>(SEL.burger)?.removeAttribute('aria-expanded')
    overlay = null
  }
}
