"use client"

import { CustomersPage } from "@be-yours/admin"

/**
 * The Clients screen comes from the engine.
 *
 * It rendered the "coming soon" placeholder here while three surfaces sold it,
 * the strongest being the onboarding tour — which said « Clients — Votre
 * carnet d'adresses intelligent ! » and navigated here, until #363 deleted the
 * step rather than let it lead somewhere empty (#364).
 *
 * The placeholder's component name is deliberately not written out:
 * `onboarding-tour.test.ts` scans this file for that literal to catch a tour
 * step that narrates a feature and lands on a placeholder, and the scan cannot
 * tell a comment from a render.
 */
export default function Page() {
  return <CustomersPage />
}
