"use client"

import { useAdminStoreId as usePackageAdminStoreId } from "@be-yours/admin"
import { useState, useEffect } from "react"
import type { Id } from "@/convex/_generated/dataModel"

/**
 * Hook to get the current admin store ID
 * Returns null if no store is selected
 *
 * This used to be a second implementation reading a different source than the
 * package hook of the same name - 18 components here against 36 in
 * `packages/admin`, indistinguishable at the call site. It now forwards to the
 * one hook, and only narrows the id to the app's Convex table type.
 */
export function useAdminStoreId(): Id<"stores"> | null {
  return usePackageAdminStoreId() as Id<"stores"> | null
}

/**
 * Hook to debounce a value
 * Useful for search inputs and other frequent updates
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}
