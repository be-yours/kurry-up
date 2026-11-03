"use client"

import { useEffect, useRef, useCallback } from "react"
import type { AddressValue } from "@/lib/address"

// Singleton: track script loading state across all hook instances
let googleScriptStatus: "idle" | "loading" | "ready" | "error" = "idle"
const loadCallbacks: Array<() => void> = []

function loadGoogleMapsScript(apiKey: string): Promise<void> {
  if (googleScriptStatus === "ready") return Promise.resolve()
  if (googleScriptStatus === "error") return Promise.reject(new Error("Google Maps script failed to load"))

  return new Promise((resolve, reject) => {
    if (googleScriptStatus === "loading") {
      loadCallbacks.push(resolve)
      return
    }

    googleScriptStatus = "loading"
    const script = document.createElement("script")
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`
    script.async = true
    script.defer = true

    script.onload = () => {
      googleScriptStatus = "ready"
      resolve()
      loadCallbacks.forEach((cb) => cb())
      loadCallbacks.length = 0
    }

    script.onerror = () => {
      googleScriptStatus = "error"
      reject(new Error("Google Maps script failed to load"))
    }

    document.head.appendChild(script)
  })
}

/**
 * Parse a Google Places result into an AddressValue
 */
function parsePlaceResult(place: google.maps.places.PlaceResult): Partial<AddressValue> {
  const result: Partial<AddressValue> = {}

  let streetNumber = ""
  let route = ""

  if (place.address_components) {
    for (const component of place.address_components) {
      const type = component.types[0]
      switch (type) {
        case "street_number":
          streetNumber = component.long_name
          break
        case "route":
          route = component.long_name
          break
        case "locality":
          result.city = component.long_name
          break
        case "postal_code":
          result.postalCode = component.long_name
          break
        case "country":
          result.country = component.long_name
          break
      }
    }
  }

  result.street = streetNumber ? `${streetNumber} ${route}` : route

  if (place.geometry?.location) {
    result.latitude = place.geometry.location.lat()
    result.longitude = place.geometry.location.lng()
  }

  return result
}

interface UseGooglePlacesAutocompleteOptions {
  apiKey: string
  countries?: string[]
  onSelect: (address: Partial<AddressValue>) => void
}

export function useGooglePlacesAutocomplete({
  apiKey,
  countries = ["fr"],
  onSelect,
}: UseGooglePlacesAutocompleteOptions) {
  const inputRef = useRef<HTMLInputElement>(null)
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  const init = useCallback(async () => {
    if (!inputRef.current || !apiKey) return

    try {
      await loadGoogleMapsScript(apiKey)
    } catch {
      return
    }

    if (!inputRef.current || autocompleteRef.current) return

    const autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
      types: ["address"],
      componentRestrictions: { country: countries },
      fields: ["address_components", "geometry"],
    })

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace()
      if (place.address_components) {
        const parsed = parsePlaceResult(place)
        onSelectRef.current(parsed)
      }
    })

    autocompleteRef.current = autocomplete
  }, [apiKey, countries])

  useEffect(() => {
    init()

    return () => {
      if (autocompleteRef.current) {
        google.maps.event.clearInstanceListeners(autocompleteRef.current)
        autocompleteRef.current = null
      }
    }
  }, [init])

  return { inputRef }
}
