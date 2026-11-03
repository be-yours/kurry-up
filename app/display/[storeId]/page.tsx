"use client"

import { useParams, useSearchParams } from "next/navigation"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { DisplayHeader } from "./display-header"
import { DisplayColumn } from "./display-column"
import { DisplayFooter } from "./display-footer"
import { useFlashDetection } from "./use-flash-detection"
import "./display.css"

export default function DisplayPage() {
  const params = useParams<{ storeId: string }>()
  const search = useSearchParams()
  const storeId = params.storeId as Id<"stores">

  /*
   * The establishment's display token, from the URL of the wall tablet (#96).
   *
   * THE SCREEN USED TO NEED A STAFF SESSION. `getForDisplay` is wrapped with
   * `kitchen:read`, and this page is a tablet bolted to a wall in the dining
   * room — so the screen a customer is meant to read could only be opened by
   * somebody logged in. The audit called it "the unusable unauthenticated
   * display screen".
   *
   * `getForDisplayByToken` is the same query behind the establishment's own
   * credential, which the owner generates on the kitchen screen's settings and
   * pastes here once. A missing or wrong token answers `null`, and the panel
   * below says what to do rather than spinning on « Chargement… » for ever.
   */
  const token = search.get("token") ?? ""

  const data = useQuery(
    api.kitchenTickets.getForDisplayByToken,
    storeId && token ? { storeId, token } : "skip"
  )

  const readyIds = data?.ready.map((t: { _id: string }) => t._id) ?? []
  const flashingIds = useFlashDetection(readyIds)

  if (!token) {
    // Stated, not spun. A tablet whose URL lost its token showed « Chargement… »
    // for ever, which reads as a broken product rather than a missing parameter.
    return (
      <div className="display-root items-center justify-center p-8 text-center">
        <div className="max-w-md space-y-3">
          <p className="text-2xl text-slate-200">Écran non configuré</p>
          <p className="text-base text-slate-400">
            Cette page a besoin du jeton d&apos;affichage de l&apos;établissement. Générez-le
            dans l&apos;administration, écran cuisine, puis ouvrez l&apos;adresse complète sur
            cette tablette.
          </p>
        </div>
      </div>
    )
  }

  if (data === null) {
    return (
      <div className="display-root items-center justify-center p-8 text-center">
        <div className="max-w-md space-y-3">
          <p className="text-2xl text-slate-200">Jeton refusé</p>
          <p className="text-base text-slate-400">
            Ce jeton n&apos;est plus valable — il a peut-être été renouvelé. Générez-en
            un nouveau dans l&apos;administration et rouvrez l&apos;adresse indiquée.
          </p>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="display-root items-center justify-center">
        <div className="text-2xl text-slate-400 animate-pulse">
          Chargement...
        </div>
      </div>
    )
  }

  return (
    <div className="display-root">
      <DisplayHeader storeName={data.storeBranding.name} />

      <main className="flex-1 flex px-4 py-2">
        <DisplayColumn
          title="En préparation"
          tickets={data.preparing}
          variant="preparing"
          flashingIds={flashingIds}
        />
        <div className="w-px bg-slate-700 mx-2" />
        <DisplayColumn
          title="Prêts à récupérer"
          tickets={data.ready}
          variant="ready"
          flashingIds={flashingIds}
        />
      </main>

      <DisplayFooter storeSlug={data.storeBranding.slug} />
    </div>
  )
}
