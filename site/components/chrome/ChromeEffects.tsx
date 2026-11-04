'use client'

/**
 * The chrome's own pieces — CLIENT ZONE. Owner: agent « chrome » (site/ART_DIRECTION.md § 10).
 *
 * The engine's footer has no slot for what the direction asks of it, so one small piece is portalled into its
 * hydrated node (the container's own children are static, React never reorders them):
 *
 *   The top of the footer: the brand's logo in cream (the whole lockup from 1024 px, where its tagline is
 *      legible; the word alone below), then the painted promise, « 10 MIN » and « 1 H » in ochre, the sentence in
 *      full under them (the numbers are hidden from screen readers, the sentence says it).
 *
 * The phone menu's behaviour (dialog, focus, Escape, scroll lock, closing shutter) is `menu-behaviour.ts`.
 * On /checkout only, `checkout-scroll.ts` takes the page back to the top when the cash confirmation appears.
 * The bar has no « Commander » button at any width (the user dropped it, 2026-11-04): the carte is one of its rooms.
 * Without script none of this exists and nothing is missing that the page needs.
 */

import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { SEL, find } from './engine-nodes'
import { mountCheckoutScroll } from './checkout-scroll'
import { mountMenuBehaviour } from './menu-behaviour'

function readTarget(): HTMLElement | null {
  return find(SEL.footerInner)
}

export function ChromeEffects() {
  const pathname = usePathname() ?? ''
  const [footer, setFooter] = useState<HTMLElement | null>(null)

  useEffect(() => mountMenuBehaviour(), [])

  // /checkout only: the engine leaves the cash confirmation off screen (checkout-scroll.ts).
  const auPaiement = /^\/checkout\/?$/.test(pathname)
  useEffect(() => (auPaiement ? mountCheckoutScroll() : undefined), [auPaiement])

  useEffect(() => {
    let queued = 0
    const update = () => {
      queued = 0
      const next = readTarget()
      setFooter((prev) => (prev === next ? prev : next))
    }
    const schedule = () => {
      if (!queued) queued = window.requestAnimationFrame(update)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(queued)
    }
  }, [])

  return (
    <>
      {footer
        ? createPortal(
            <div className="ky-pied-promesse" data-ky-dom="">
              {/* decorative: the shop's name is the footer's heading just below */}
              <Image
                className="ky-pied-logo ky-pied-logo--complet"
                src="/brand/logo/kurry-up-creme.svg"
                alt=""
                width={556}
                height={176}
                unoptimized
              />
              <Image
                className="ky-pied-logo ky-pied-logo--mot"
                src="/brand/logo/kurry-up-mot-creme.svg"
                alt=""
                width={556}
                height={131}
                unoptimized
              />
              <div className="ky-pied-promesse__chiffres" aria-hidden="true">
                <p className="ky-chiffre ky-pied-promesse__chiffre" style={{ ['--i' as string]: 0 }}>
                  10<span className="ky-chiffre__unite">min</span>
                </p>
                <p className="ky-chiffre ky-pied-promesse__chiffre" style={{ ['--i' as string]: 1 }}>
                  1<span className="ky-chiffre__unite">h</span>
                </p>
              </div>
              <p className="ky-pied-promesse__phrase">Retrait en 10 minutes sur place, livraison en 1 heure max.</p>
            </div>,
            footer,
          )
        : null}
    </>
  )
}
