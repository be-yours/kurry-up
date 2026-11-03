"use client"

import { useState } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { toast } from "sonner"
import { Loader2, Plus, Pencil, Trash2, Check, X } from "lucide-react"
import {
  Button,
  Input,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@be-yours/ui"
import { DeleteConfirmDialog } from "@/components/admin/DeleteConfirmDialog"
import type { Id } from "@/convex/_generated/dataModel"

interface BlogCategoryManagerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BlogCategoryManager({
  open,
  onOpenChange,
}: BlogCategoryManagerProps) {
  const storeId = useAdminStoreId()

  const categories = useQuery(
    api.blog.listCategories,
    storeId ? { storeId } : "skip",
  )
  const createCategory = useMutation(api.blog.createCategory)
  const updateCategory = useMutation(api.blog.updateCategory)
  const deleteCategory = useMutation(api.blog.deleteCategory)

  // Create form
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    name: string
  } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!storeId || !newName.trim()) return

    setIsCreating(true)
    try {
      await createCategory({
        storeId,
        name: newName.trim(),
        ...(newDescription.trim() && { description: newDescription.trim() }),
      })
      toast.success("Catégorie créée")
      setNewName("")
      setNewDescription("")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la création"),
      )
    } finally {
      setIsCreating(false)
    }
  }

  const startEdit = (cat: { _id: string; name: string; description?: string }) => {
    setEditingId(cat._id)
    setEditName(cat.name)
    setEditDescription(cat.description ?? "")
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return

    setIsSaving(true)
    try {
      await updateCategory({
        categoryId: editingId as Id<"blogCategories">,
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      })
      toast.success("Catégorie modifiée")
      setEditingId(null)
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la modification"),
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return

    setIsDeleting(true)
    try {
      await deleteCategory({
        categoryId: deleteTarget.id as Id<"blogCategories">,
      })
      toast.success("Catégorie supprimée")
      setDeleteTarget(null)
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la suppression"),
      )
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Catégories</SheetTitle>
            <SheetDescription>
              Gérez les catégories de votre blog.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-6 px-4">
            {/* Create form */}
            <form onSubmit={handleCreate} className="space-y-3">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nom de la catégorie"
                disabled={isCreating}
              />
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optionnel)"
                disabled={isCreating}
              />
              <Button
                type="submit"
                size="sm"
                disabled={isCreating || !newName.trim()}
                className="w-full"
              >
                {isCreating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                Ajouter
              </Button>
            </form>

            {/* Categories list */}
            <div className="space-y-2">
              {categories === undefined ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : categories.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Aucune catégorie
                </p>
              ) : (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                categories.map((cat: any) => (
                  <div
                    key={cat._id}
                    className="flex items-center gap-2 rounded-md border px-3 py-2"
                  >
                    {editingId === cat._id ? (
                      <div className="flex-1 space-y-2">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          disabled={isSaving}
                          autoFocus
                        />
                        <Input
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          placeholder="Description (optionnel)"
                          disabled={isSaving}
                        />
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={handleSaveEdit}
                            disabled={isSaving || !editName.trim()}
                          >
                            {isSaving ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingId(null)}
                            disabled={isSaving}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            {cat.name}
                          </p>
                          {cat.description && (
                            <p className="text-xs text-muted-foreground truncate">
                              {cat.description}
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          onClick={() => startEdit(cat)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-destructive"
                          onClick={() =>
                            setDeleteTarget({ id: cat._id, name: cat.name })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        onConfirm={handleDelete}
        title="Supprimer la catégorie"
        description={`Êtes-vous sûr de vouloir supprimer la catégorie "${deleteTarget?.name}" ? Cette action est irréversible.`}
        isDeleting={isDeleting}
      />
    </>
  )
}
