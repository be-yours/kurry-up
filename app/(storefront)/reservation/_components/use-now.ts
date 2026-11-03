'use client'

import { useEffect, useState } from 'react'

/**
 * The clock a countdown reads: one tick a second while `active`, and none otherwise, so a
 * page with no hold to count does not wake up every second for nothing.
 *
 * The first value is read on the first render and the first tick corrects it a second
 * later; callers only render it behind a query that has already answered, so the server's
 * HTML never carries a time that differs from the browser's.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
