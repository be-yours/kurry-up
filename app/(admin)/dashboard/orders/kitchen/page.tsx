"use client"

import { KitchenPage } from "@be-yours/admin"
import { SeedKitchenButton } from "./SeedKitchenButton"

/**
 * The KDS screen comes from the engine.
 *
 * It used to be a local copy of it — the same 1,500 lines in this app and in
 * its twin, while the package exported an older third version that nothing
 * rendered. The seeder stays local because it is a test-bench affordance, and
 * the page takes it as a header action.
 */
export default function Page() {
  return <KitchenPage headerAction={<SeedKitchenButton />} />
}
