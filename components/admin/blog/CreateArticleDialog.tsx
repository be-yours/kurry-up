"use client"

import { useState } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { convexErrorMessage } from "@/lib/convex-error"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, FolderPlus } from "lucide-react"
import {
  Button,
  Input,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@be-yours/ui"
import type { Id } from "@/convex/_generated/dataModel"

interface CreateArticleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenCategoryManager: () => void
}

export function CreateArticleDialog({
  open,
  onOpenChange,
  onOpenCategoryManager,
}: CreateArticleDialogProps) {
  const storeId = useAdminStoreId()
  const router = useRouter()

  const categories = useQuery(
    api.blog.listCategories,
    storeId ? { storeId } : "skip",
  )
  const createArticle = useMutation(api.blog.createArticle)

  const [title, setTitle] = useState("")
  const [categoryId, setCategoryId] = useState<string>("")
  const [isCreating, setIsCreating] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!storeId || !title.trim() || !categoryId) return

    setIsCreating(true)
    try {
      const articleId = await createArticle({
        storeId,
        title: title.trim(),
        categoryId: categoryId as Id<"blogCategories">,
      })
      onOpenChange(false)
      setTitle("")
      setCategoryId("")
      // Navigate immediately — don't wait for dialog animation
      router.push(`/dashboard/content/blog/${articleId}`)
      toast.success("Article créé")
    } catch (err) {
      toast.error(
        convexErrorMessage(err, {}, "Erreur lors de la création"),
      )
    } finally {
      setIsCreating(false)
    }
  }

  const handleOpenCategoryManager = () => {
    // Close dialog first, then open category manager (avoid stacked overlays)
    onOpenChange(false)
    onOpenCategoryManager()
  }

  const hasCategories = categories && categories.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nouvel article</DialogTitle>
          <DialogDescription>
            Créez un nouvel article de blog.
          </DialogDescription>
        </DialogHeader>

        {categories === undefined ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !hasCategories ? (
          <div className="text-center py-8 space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <FolderPlus className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">Aucune catégorie</p>
              <p className="text-sm text-muted-foreground mt-1">
                Vous devez créer au moins une catégorie avant de pouvoir créer un article.
              </p>
            </div>
            <Button onClick={handleOpenCategoryManager}>
              Créer une catégorie
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="article-title">
                Titre
              </label>
              <Input
                id="article-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Titre de l'article"
                required
                autoFocus
                disabled={isCreating}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="article-category">
                Catégorie
              </label>
              <Select
                value={categoryId}
                onValueChange={setCategoryId}
                disabled={isCreating}
              >
                <SelectTrigger id="article-category">
                  <SelectValue placeholder="Choisir une catégorie" />
                </SelectTrigger>
                <SelectContent>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {categories.map((cat: any) => (
                    <SelectItem key={cat._id} value={cat._id}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isCreating}
              >
                Annuler
              </Button>
              <Button
                type="submit"
                disabled={isCreating || !title.trim() || !categoryId}
              >
                {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Créer
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
