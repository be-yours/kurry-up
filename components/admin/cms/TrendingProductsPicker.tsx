"use client"
/* eslint-disable @typescript-eslint/no-explicit-any -- Convex query results */

import { useState, useCallback } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import {
  TrendingUp,
  Search,
  X,
  GripVertical,
  Plus,
  Loader2,
  Sparkles,
  Hand,
} from "lucide-react"
import {
  Button,
  Input,
  Badge,
  Switch,
  Skeleton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@be-yours/ui"
import type { Id } from "@/convex/_generated/dataModel"

export function TrendingProductsPicker() {
  const storeId = useAdminStoreId()

  // Queries
  const store = useQuery(
    api.stores.getById,
    storeId ? { id: storeId } : "skip"
  )
  // `listAll`, not `list`: this is the admin choosing which dishes to feature,
  // so it has to see the ones not currently on sale. `list` is now the diner's
  // view and stops at `isActive` (#443).
  const allProducts = useQuery(
    api.products.listAll,
    storeId ? { storeId } : "skip"
  )
  const manualTrending = useQuery(
    api.products.getManualTrending,
    storeId ? { storeId } : "skip"
  )

  // Mutations
  const updateTrendingMode = useMutation(api.stores.updateTrendingMode)
  const setTrendingProducts = useMutation(api.products.setTrendingProducts)

  // Local state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [saving, setSaving] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Id<"products">[]>([])

  const trendingMode = store?.trendingMode ?? "manual"
  const isManual = trendingMode === "manual"

  // Initialize selected IDs from server data when dialog opens
  const handleDialogOpen = useCallback(
    (open: boolean) => {
      if (open && manualTrending) {
        setSelectedIds(manualTrending.map((p: any) => p._id))
        setSearch("")
      }
      setDialogOpen(open)
    },
    [manualTrending]
  )

  // Toggle mode
  const handleModeToggle = useCallback(
    async (checked: boolean) => {
      if (!storeId) return
      try {
        await updateTrendingMode({
          id: storeId,
          trendingMode: checked ? "automatic" : "manual",
        })
        toast.success(
          checked
            ? "Mode automatique activé (basé sur les ventes)"
            : "Mode manuel activé"
        )
      } catch {
        toast.error("Erreur lors du changement de mode")
      }
    },
    [storeId, updateTrendingMode]
  )

  // Add product to selection
  const addProduct = useCallback((productId: Id<"products">) => {
    setSelectedIds((prev) => {
      if (prev.includes(productId)) return prev
      return [...prev, productId]
    })
  }, [])

  // Remove product from selection
  const removeProduct = useCallback((productId: Id<"products">) => {
    setSelectedIds((prev) => prev.filter((id) => id !== productId))
  }, [])

  // Move product in list
  const moveProduct = useCallback(
    (index: number, direction: "up" | "down") => {
      setSelectedIds((prev) => {
        const next = [...prev]
        const targetIndex = direction === "up" ? index - 1 : index + 1
        if (targetIndex < 0 || targetIndex >= next.length) return prev
        const a = next[index]!
        const b = next[targetIndex]!
        next[index] = b
        next[targetIndex] = a
        return next
      })
    },
    []
  )

  // Save
  const handleSave = useCallback(async () => {
    if (!storeId) return
    setSaving(true)
    try {
      await setTrendingProducts({ storeId, productIds: selectedIds })
      toast.success("Produits tendance mis à jour")
      setDialogOpen(false)
    } catch {
      toast.error("Erreur lors de la sauvegarde")
    } finally {
      setSaving(false)
    }
  }, [storeId, selectedIds, setTrendingProducts])

  // Filter products for the "add" list (active, not already selected)
  const availableProducts = (allProducts ?? [])
    .filter(
      (p: any) =>
        p.isActive &&
        !selectedIds.includes(p._id) &&
        (search === "" ||
          p.name.toLowerCase().includes(search.toLowerCase()))
    )
    .slice(0, 20)

  // Resolve selected product details
  const productMap = new Map<string, any>(
    (allProducts ?? []).map((p: any) => [p._id, p])
  )

  if (!storeId || store === undefined) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex items-center justify-between rounded-lg border px-4 py-3">
        <div className="flex items-center gap-2">
          {isManual ? (
            <Hand className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Sparkles className="h-4 w-4 text-warning" />
          )}
          <div>
            <p className="text-sm font-medium">
              {isManual ? "Sélection manuelle" : "Mode automatique"}
            </p>
            <p className="text-xs text-muted-foreground">
              {isManual
                ? "Vous choisissez les produits affichés"
                : "Basé sur les ventes des 30 derniers jours"}
            </p>
          </div>
        </div>
        <Switch
          checked={!isManual}
          onCheckedChange={handleModeToggle}
          aria-label="Mode automatique"
        />
      </div>

      {/* Manual mode: show current selection and picker */}
      {isManual && (
        <div className="space-y-3">
          {/* Current trending products */}
          {manualTrending === undefined ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : manualTrending.length === 0 ? (
            <div className="rounded-lg border border-dashed py-6 text-center">
              <TrendingUp className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                Aucun produit tendance sélectionné
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {manualTrending.map((product: any, index: number) => (
                <div
                  key={product._id}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="text-xs font-bold text-muted-foreground w-5 text-center">
                    {index + 1}
                  </span>
                  {product.images?.[0] && (
                    <img
                      src={product.images[0]}
                      alt={product.name}
                      className="h-8 w-8 rounded-md object-cover"
                    />
                  )}
                  <span className="text-sm font-medium flex-1 truncate">
                    {product.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {(product.price / 100).toFixed(2)} €
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Edit button → opens dialog */}
          <Dialog open={dialogOpen} onOpenChange={handleDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full">
                <Plus className="mr-2 h-3.5 w-3.5" />
                {manualTrending && manualTrending.length > 0
                  ? "Modifier la sélection"
                  : "Sélectionner des produits"}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
              <DialogHeader>
                <DialogTitle>Produits tendance</DialogTitle>
              </DialogHeader>

              <div className="flex flex-col gap-4 flex-1 min-h-0">
                {/* Selected products (reorderable) */}
                {selectedIds.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      Sélection ({selectedIds.length})
                    </p>
                    <div className="space-y-1 max-h-[200px] overflow-y-auto">
                      {selectedIds.map((id, index) => {
                        const product = productMap.get(id)
                        if (!product) return null
                        return (
                          <div
                            key={id}
                            className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                          >
                            <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="text-xs font-bold text-muted-foreground w-4 text-center">
                              {index + 1}
                            </span>
                            {product.images?.[0] && (
                              <img
                                src={product.images[0]}
                                alt={product.name}
                                className="h-7 w-7 rounded object-cover"
                              />
                            )}
                            <span className="text-sm flex-1 truncate">
                              {product.name}
                            </span>
                            <div className="flex items-center gap-0.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="h-6 w-6"
                                disabled={index === 0}
                                onClick={() => moveProduct(index, "up")}
                              >
                                <span className="text-xs">↑</span>
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="h-6 w-6"
                                disabled={index === selectedIds.length - 1}
                                onClick={() => moveProduct(index, "down")}
                              >
                                <span className="text-xs">↓</span>
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="h-6 w-6 text-destructive"
                                onClick={() => removeProduct(id)}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Search + add */}
                <div className="space-y-2 flex-1 min-h-0 flex flex-col">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Rechercher un produit..."
                      className="pl-8 h-8 text-sm"
                    />
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-0.5 min-h-[120px] max-h-[250px]">
                    {availableProducts.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        {search
                          ? "Aucun produit trouvé"
                          : "Tous les produits sont déjà sélectionnés"}
                      </p>
                    ) : (
                      availableProducts.map((product: any) => (
                        <button
                          key={product._id}
                          type="button"
                          className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left hover:bg-muted/50 transition-colors"
                          onClick={() => addProduct(product._id)}
                        >
                          <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          {product.images?.[0] && (
                            <img
                              src={product.images[0]}
                              alt={product.name}
                              className="h-7 w-7 rounded object-cover"
                            />
                          )}
                          <span className="text-sm flex-1 truncate">
                            {product.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {(product.price / 100).toFixed(2)} €
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                {/* Save button */}
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full"
                >
                  {saving && (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  )}
                  Enregistrer ({selectedIds.length} produit
                  {selectedIds.length !== 1 ? "s" : ""})
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* Automatic mode: info */}
      {!isManual && (
        <div className="rounded-lg border border-dashed bg-muted/20 py-4 px-4 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-warning" />
          <p className="mt-2 text-sm text-muted-foreground">
            Les produits les plus vendus des 30 derniers jours seront affichés automatiquement.
          </p>
        </div>
      )}
    </div>
  )
}
