"use client"

import { useRef, useState, useEffect } from "react"

export function useFlashDetection(readyIds: string[]): Set<string> {
  const prevIdsRef = useRef<Set<string>>(new Set())
  const [flashingIds, setFlashingIds] = useState<Set<string>>(new Set())

  // Detect new IDs via effect (not during render) to comply with React 19 rules
  useEffect(() => {
    const newIds = new Set<string>()
    for (const id of readyIds) {
      if (!prevIdsRef.current.has(id)) {
        newIds.add(id)
      }
    }
    prevIdsRef.current = new Set(readyIds)

    if (newIds.size === 0) return

    const timer = setTimeout(() => {
      setFlashingIds(prev => {
        const merged = new Set(prev)
        for (const id of newIds) merged.add(id)
        return merged
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [readyIds])

  // Auto-clear flashing after 3 seconds
  useEffect(() => {
    if (flashingIds.size === 0) return
    const timer = setTimeout(() => setFlashingIds(new Set()), 3000)
    return () => clearTimeout(timer)
  }, [flashingIds])

  return flashingIds
}
