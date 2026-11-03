"use client"

import { useState } from "react"
import {
  AddressAutocomplete,
  type AddressValue,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Button,
} from "@be-yours/ui"

/**
 * A fixture page, so it supplies its own key when the environment has none.
 *
 * `useGooglePlacesAutocomplete` returns immediately on an empty key — before
 * it ever requests the Maps script. The e2e spec intercepts that request and
 * answers with a mock, so it was mocking a call the component had already
 * decided not to make, and no suggestion list ever appeared. Any non-empty
 * value gets the component past that guard; the request itself is either
 * intercepted by the test or fails harmlessly.
 */
const GOOGLE_MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || "address-test-fixture-key"

/**
 * Test-only page for Playwright E2E testing of AddressAutocomplete.
 * Not protected by AuthGuard.
 */
export default function AddressTestPage() {
  const [address, setAddress] = useState<AddressValue>({
    street: "",
    city: "",
    postalCode: "",
    country: "France",
  })

  const [dialogAddress, setDialogAddress] = useState<AddressValue>({
    street: "",
    city: "",
    postalCode: "",
    country: "France",
  })

  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold" data-testid="page-title">
        Test AddressAutocomplete
      </h1>

      {/* Standalone test */}
      <section data-testid="standalone-section" className="space-y-4">
        <h2 className="text-lg font-semibold">Standalone</h2>
        <AddressAutocomplete
          label="Adresse"
          value={address}
          onChange={setAddress}
          apiKey={GOOGLE_MAPS_API_KEY}
        />
      </section>

      {/* Inside Dialog test */}
      <section data-testid="dialog-section" className="space-y-4">
        <h2 className="text-lg font-semibold">Inside Dialog</h2>
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button data-testid="open-dialog-btn">Ouvrir le dialog</Button>
          </DialogTrigger>
          <DialogContent
            className="max-w-2xl"
            onPointerDownOutside={(e) => {
              const target = e.target as HTMLElement
              if (target.closest(".pac-container")) {
                e.preventDefault()
              }
            }}
            onInteractOutside={(e) => {
              const target = e.target as HTMLElement
              if (target.closest(".pac-container")) {
                e.preventDefault()
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Test Adresse dans Dialog</DialogTitle>
            </DialogHeader>
            <AddressAutocomplete
              label="Adresse"
              value={dialogAddress}
              onChange={setDialogAddress}
              apiKey={GOOGLE_MAPS_API_KEY}
            />
          </DialogContent>
        </Dialog>
      </section>
    </div>
  )
}
