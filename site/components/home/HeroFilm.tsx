'use client'

/**
 * « Le film peint », the hero film of the home — CLIENT ZONE. Owner: the « accueil » agent (ART_DIRECTION.md §9).
 *
 * The brand's own film (four plans: the signs, the chicken tikka at the tongs, the composed bowl, the naan), cut
 * by site/tools/video.mjs so that every change of plan is a pass of the brush. The engine's hero has no slot for
 * a video, so the film is portalled into its media box (`.storefront-hero-media`, a framer wrapper whose own
 * children are static: React never reorders them). It is a grid item of that box, whose height is already
 * reserved by home.css: inserting it moves nothing.
 *
 * The engine's dish (`hero/street-food.webp`, the LCP image) stays the hero's picture until the film plays:
 * once the first frame is decoded, and not before the end of the load cinematic (1,4 s), the film window paints
 * itself over the dish from left to right (home.css, `data-ky-film="joue"`) and the dish fades away under it.
 *
 * Fallbacks: the dish stays and nothing is mounted (or the film is withdrawn) under `prefers-reduced-motion`,
 * Save-Data, a refused or failed playback, a browser that plays neither H.264 nor VP9, and without script.
 * The film pauses off screen (IntersectionObserver) and in a hidden tab, and has a pause button (WCAG 2.2.2:
 * it loops for more than five seconds beside the text).
 */

import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const TARGET = '.storefront-theme main section.storefront-hero .storefront-hero-media'
/** The end of the hero's load cinematic (home.css §7.1): the film never paints over it. */
const APRES_CINEMATIQUE = 1400

/** Has React hydrated this node? (read only: the key React sets on every host node it owns) */
function hydrated(el: Element | null): el is HTMLElement {
  return !!el && Object.keys(el).some((k) => k.startsWith('__reactFiber$'))
}

function saveData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return !!c?.saveData
}

function useMotionAllowed(): boolean {
  const [ok, setOk] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !saveData())
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setOk(!mq.matches && !saveData())
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return ok
}

export function HeroFilm() {
  const pathname = usePathname() ?? ''
  if (pathname !== '/') return null
  return <HeroFilmPortal />
}

function HeroFilmPortal() {
  const allowed = useMotionAllowed()
  const [failed, setFailed] = useState(false)
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useEffect(() => {
    let queued = 0
    const update = () => {
      queued = 0
      const el = document.querySelector(TARGET)
      // Hydrated AND committed: framer writes `opacity: 0` in the server HTML and changes it only after React has
      // committed the hero (a node of a hydration that is thrown away and restarted already carries its fiber
      // key; a portal inserted then is a hydration mismatch). Past 5 s, the fiber key alone is trusted.
      const next = hydrated(el) && (el.style.opacity !== '0' || performance.now() > 5000) ? el : null
      setTarget((prev) => (prev === next ? prev : next))
    }
    const schedule = () => {
      if (!queued) queued = window.requestAnimationFrame(update)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    schedule()
    const late = window.setTimeout(schedule, 5100)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(queued)
      window.clearTimeout(late)
    }
  }, [])

  if (!allowed || failed || !target) return null
  return createPortal(<Film onFail={() => setFailed(true)} />, target)
}

type Etat = 'attente' | 'joue'

function pickSource(video: HTMLVideoElement, size: string): string | null {
  if (video.canPlayType('video/mp4; codecs="avc1.640028"') || video.canPlayType('video/mp4; codecs="avc1.4D401F"')) {
    return `/brand/video/kurry-film-${size}.mp4`
  }
  if (video.canPlayType('video/webm; codecs="vp9"')) return `/brand/video/kurry-film-${size}.webm`
  return null
}

function Film({ onFail }: { onFail: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const userPaused = useRef(false)
  const [etat, setEtat] = useState<Etat>('attente')
  const [paused, setPaused] = useState(false)
  const [size] = useState(() => (window.matchMedia('(min-width: 768px)').matches ? '1080' : '720'))
  const failRef = useRef(onFail)
  useEffect(() => {
    failRef.current = onFail
  }, [onFail])

  useEffect(() => {
    const video = videoRef.current
    const root = rootRef.current
    if (!video || !root) return
    const src = pickSource(video, size)
    if (!src) {
      failRef.current()
      return
    }
    video.muted = true
    video.defaultMuted = true
    video.src = src

    let visible = false
    let shown = false
    let timer = 0
    const sync = () => {
      if (userPaused.current || !visible || document.hidden) {
        video.pause()
        return
      }
      video.play().catch((err: DOMException) => {
        // AbortError: a pause() came first (scrolled away); anything else is a refusal (Low Power mode…)
        if (err?.name !== 'AbortError') failRef.current()
      })
    }
    const onPlaying = () => {
      if (shown) return
      shown = true
      timer = window.setTimeout(() => setEtat('joue'), Math.max(0, APRES_CINEMATIQUE - performance.now()))
    }
    const onError = () => failRef.current()
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting)
        sync()
      },
      { threshold: 0.15 },
    )
    video.addEventListener('playing', onPlaying)
    video.addEventListener('error', onError)
    document.addEventListener('visibilitychange', sync)
    io.observe(root)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', sync)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('error', onError)
      window.clearTimeout(timer)
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [size])

  const toggle = () => {
    const video = videoRef.current
    if (!video) return
    userPaused.current = !userPaused.current
    setPaused(userPaused.current)
    if (userPaused.current) video.pause()
    else video.play().catch(() => undefined)
  }

  return (
    <div ref={rootRef} className="ky-film" data-ky-film={etat} data-ky-dom="">
      <div className="ky-film__fenetre">
        <video
          ref={videoRef}
          className="ky-film__video"
          muted
          loop
          playsInline
          preload="metadata"
          poster={`/brand/video/kurry-film-${size}.webp`}
          aria-hidden="true"
          tabIndex={-1}
          disablePictureInPicture
          disableRemotePlayback
        />
      </div>
      {etat === 'joue' ? (
        <button
          type="button"
          className="ky-film__pause"
          aria-label={paused ? 'Relancer la vidéo' : 'Mettre la vidéo en pause'}
          onClick={toggle}
        >
          {paused ? (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor" />
            </svg>
          )}
        </button>
      ) : null}
    </div>
  )
}
