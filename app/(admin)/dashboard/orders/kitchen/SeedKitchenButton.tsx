"use client"

import { useState } from "react"
import { useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { useAdminAuthStore } from "@be-yours/admin"
import { hasPermission, type Role } from "@be-yours/core"
import { Button } from "@be-yours/ui"
import { toast } from "sonner"
import { Plus, Trash2, Loader2 } from "lucide-react"

/**
 * The permission both mutations behind this control check.
 *
 * `seedKitchenOrders` and `cleanKitchenSeed` are `storeMutation`s on
 * `kitchen:manage`, which only `super_admin` holds. Named once here so the
 * screen and the server cannot drift: a gate that restated the role list would
 * go stale the first time a role gained the permission.
 */
const SEEDER_PERMISSION = "kitchen:manage"

export function SeedKitchenButton() {
  const storeId = useAdminStoreId()
  const role = useAdminAuthStore((s) => s.role)
  const seedMutation = useMutation(api.seedKitchenOrders.seedKitchenOrders)
  const cleanMutation = useMutation(api.seedKitchenOrders.cleanKitchenSeed)
  const [isSeeding, setIsSeeding] = useState(false)
  const [isCleaning, setIsCleaning] = useState(false)

  if (!storeId) return null

  /*
   * THE GATE (#523). This used to be `if (!storeId)` and nothing else, so both
   * buttons rendered for every role on every client site — on a working kitchen
   * display, next to the real tickets. Pressing one got a refusal toast, because
   * the mutations are guarded on a permission no client role holds.
   *
   * The harm is not the refusal. It is offering a paying establishment's staff a
   * control that fabricates orders, and then telling them they may not use it.
   *
   * `null` is the session still loading, and it is refused too: showing the
   * control and then withdrawing it is a flicker, adding it once the role is
   * known is not.
   */
  if (!role || !hasPermission(role as Role, SEEDER_PERMISSION)) return null

  const handleSeed = async () => {
    setIsSeeding(true)
    try {
      const result = await seedMutation({ storeId })
      toast.success(result.message)
    } catch (err) {
      toast.error(`Erreur: ${String(err)}`)
    } finally {
      setIsSeeding(false)
    }
  }

  const handleClean = async () => {
    setIsCleaning(true)
    try {
      const result = await cleanMutation({ storeId })
      toast.success(`${result.deletedTickets} tickets et ${result.deletedOrders} commandes supprimées`)
    } catch (err) {
      toast.error(`Erreur: ${String(err)}`)
    } finally {
      setIsCleaning(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={handleSeed}
        disabled={isSeeding || isCleaning}
      >
        {isSeeding ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Plus className="mr-2 h-4 w-4" />
        )}
        Créer commandes test
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={handleClean}
        disabled={isSeeding || isCleaning}
      >
        {isCleaning ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="mr-2 h-4 w-4" />
        )}
        Nettoyer test
      </Button>
    </div>
  )
}
