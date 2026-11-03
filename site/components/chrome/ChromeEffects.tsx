'use client'

/**
 * The chrome's own pieces — CLIENT ZONE. Owner: agent « chrome » (site/ART_DIRECTION.md § 10).
 *
 * The engine's header and footer have no slot for what the direction asks of them, so two small pieces are
 * portalled into their hydrated nodes (each container's own children are static, React never reorders them):
 *
 *   1. « Commander » (to the carte), at the end of the bar's row: after the account in tab order, the brushed
 *      orange `.ky-btn` with its ink label. Shown from 1024 px only (the phone bar and its menu have none); not on the cart, checkout and order
 *      pages, which have their own action.
 *   2. The top of the footer: the brand's logo in cream (the whole lockup from 1024 px, where its tagline is
 *      legible; the word alone below), then the painted promise, « 10 MIN » and « 1 H » in ochre, the sentence in
 *      full under them (the numbers are hidden from screen readers, the sentence says it).
 *
 * The phone menu's behaviour (dialog, focus, Escape, scroll lock, closing shutter) is `menu-behaviour.ts`.
 * On /checkout only, `checkout-scroll.ts` takes the page back to the top when the cash confirmation appears.
 * Without script none of this exists and nothing is missing that the page needs: the carte is in the bar.
 */

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { SEL, find } from './engine-nodes'
import { mountCheckoutScroll } from './checkout-scroll'
import { mountMenuBehaviour } from './menu-behaviour'

/** Pages whose own action is the order itself: no « Commander » to the carte in the bar there. */
const SANS_COMMANDER = /^\/(cart|checkout|order|track)(\/|$)/

type Targets = { nav: HTMLElement | null; footer: HTMLElement | null }

const same = (a: Targets, b: Targets) => a.nav === b.nav && a.footer === b.footer

function readTargets(): Targets {
  return { nav: find(SEL.nav), footer: find(SEL.footerInner) }
}

export function ChromeEffects() {
  const pathname = usePathname() ?? ''
  const [targets, setTargets] = useState<Targets>({ nav: null, footer: null })

  useEffect(() => mountMenuBehaviour(), [])

  // Below 1024 px the bar is the sign, the cart and the burger: no « Commander » there, nor in the phone menu.
  const [large, setLarge] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const read = () => setLarge(query.matches)
    read()
    query.addEventListener('change', read)
    return () => query.removeEventListener('change', read)
  }, [])

  // /checkout only: the engine leaves the cash confirmation off screen (checkout-scroll.ts).
  const auPaiement = /^\/checkout\/?$/.test(pathname)
  useEffect(() => (auPaiement ? mountCheckoutScroll() : undefined), [auPaiement])

  useEffect(() => {
    let queued = 0
    const update = () => {
      queued = 0
      const next = readTargets()
      setTargets((prev) => (same(prev, next) ? prev : next))
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
      {large && targets.nav && !SANS_COMMANDER.test(pathname)
        ? createPortal(
            <Link href="/menu" className="ky-btn ky-entete-commande" data-ky-dom="">
              Commander
            </Link>,
            targets.nav,
          )
        : null}
      {targets.footer
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
            targets.footer,
          )
        : null}
    </>
  )
}
