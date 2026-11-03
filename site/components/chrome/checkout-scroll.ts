/**
 * /checkout: bring the confirmation into view — CLIENT ZONE. Owner: agent « chrome ».
 *
 * After « Confirmer la commande » (cash), the engine's checkout page (app/(storefront)/checkout/page.tsx) swaps
 * its form for the success screen in place, without scrolling: the visitor, who was at the foot of a long form,
 * is left looking at the footer while « Commande confirmée » sits above, off screen (QA défaut 11).
 * The engine file cannot be patched from here, so this watches for the success screen to appear and takes the
 * page back to its top: smoothly, or at once under `prefers-reduced-motion`. Focus moves to the success title
 * (the submit button it was on is gone), without a second scroll.
 *
 * Mounted only while the path is /checkout (ChromeEffects). Card payments leave the page for another URL and
 * never reach this. Undo: the returned function disconnects everything.
 */

/** The engine's success screen: `div.min-h-screen.pt-32 > div.max-w-xl.text-center > h1` (« Commande Confirmée »). */
const SUCCES = 'div.min-h-screen.pt-32 > div.max-w-xl.text-center > h1'

export function mountCheckoutScroll(): () => void {
  // A success screen already on the page when this mounts was not just reached: leave the scroll alone.
  let vu = document.querySelector(SUCCES) !== null
  let queued = 0

  const check = () => {
    queued = 0
    const titre = document.querySelector<HTMLElement>(SUCCES)
    if (!titre) {
      vu = false
      return
    }
    if (vu) return
    vu = true
    const reduit = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, left: 0, behavior: reduit ? 'instant' : 'smooth' })
    if (!titre.hasAttribute('tabindex')) titre.setAttribute('tabindex', '-1')
    titre.focus({ preventScroll: true })
  }

  const schedule = () => {
    if (!queued) queued = window.requestAnimationFrame(check)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    window.cancelAnimationFrame(queued)
  }
}
