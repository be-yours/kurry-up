"use client"

import { useState } from "react"
import { useQuery, useMutation } from "convex/react"
import { useAction } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Lock, Sparkles, FolderPlus, Plus, Check, Languages } from "lucide-react"
import {
  Button,
  Input,
  Switch,
  Badge,
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
import Link from "next/link"
import type { Id } from "@/convex/_generated/dataModel"

interface GenerateArticleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function GenerateArticleDialog({
  open,
  onOpenChange,
}: GenerateArticleDialogProps) {
  const storeId = useAdminStoreId()
  const router = useRouter()

  const accessStatus = useQuery(api.blogAutoConfig.getAccessStatus)
  const categories = useQuery(
    api.blog.listCategories,
    storeId ? { storeId } : "skip"
  )
  const languages = useQuery(
    api.languages.list,
    storeId ? { storeId } : "skip"
  )

  const generateArticle = useAction(api.blogAutoGenerate.generateArticle)
  const createCategory = useMutation(api.blog.createCategory)

  const [topic, setTopic] = useState("")
  const [tone, setTone] = useState<string>("")
  const [locale, setLocale] = useState<string>("")
  const [categoryId, setCategoryId] = useState<string>("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [autoTranslate, setAutoTranslate] = useState(false)

  // Inline category creation
  const [showNewCategory, setShowNewCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState("")
  const [isCreatingCategory, setIsCreatingCategory] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!storeId || !topic.trim() || !tone || !locale || !categoryId) return

    setIsGenerating(true)
    try {
      const result = await generateArticle({
        storeId,
        topic: topic.trim(),
        tone: tone as "formel" | "decontracte" | "storytelling",
        locale,
        categoryId: categoryId as Id<"blogCategories">,
        autoTranslate,
      })
      onOpenChange(false)
      resetForm()
      router.push(`/dashboard/content/blog/${result.articleId}`)
      toast.success("Article généré avec succès")
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "La génération a échoué, réessayez"
      )
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCreateCategory = async () => {
    if (!storeId || !newCategoryName.trim()) return

    setIsCreatingCategory(true)
    try {
      const newId = await createCategory({
        storeId,
        name: newCategoryName.trim(),
      })
      setCategoryId(newId as string)
      setNewCategoryName("")
      setShowNewCategory(false)
      toast.success("Catégorie créée")
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Erreur lors de la création"
      )
    } finally {
      setIsCreatingCategory(false)
    }
  }

  const resetForm = () => {
    setTopic("")
    setTone("")
    setLocale("")
    setCategoryId("")
    setAutoTranslate(false)
    setShowNewCategory(false)
    setNewCategoryName("")
  }

  const hasCategories = categories && categories.length > 0

  // ── Loading state ──────────────────────────────────────────────────────
  if (accessStatus === undefined) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Générer avec l&apos;IA</DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  // ── Locked state ───────────────────────────────────────────────────────
  if (!accessStatus.allowed) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Générer avec l&apos;IA</DialogTitle>
            <DialogDescription>
              Cette fonctionnalité nécessite un abonnement Auto Blog actif.
            </DialogDescription>
          </DialogHeader>
          <div className="text-center py-6 space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              {accessStatus.reason}
            </p>
            {accessStatus.reason !== "Quota mensuel atteint" && (
              <Button asChild>
                <Link href="/dashboard/subscription">Voir les abonnements</Link>
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  // ── Form state ─────────────────────────────────────────────────────────
  const remainingQuota = accessStatus.remainingQuota ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>Générer avec l&apos;IA</DialogTitle>
            <Badge variant="secondary" className="text-xs">
              {remainingQuota >= 9999
                ? "Illimité"
                : `${remainingQuota} restant${remainingQuota > 1 ? "s" : ""}`}
            </Badge>
          </div>
          <DialogDescription>
            Décrivez le sujet et l&apos;IA générera un article complet en
            brouillon.
          </DialogDescription>
        </DialogHeader>

        {categories === undefined || languages === undefined ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="generate-topic">
                Sujet
              </label>
              <Input
                id="generate-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Ex: Les bienfaits des ingrédients frais"
                required
                autoFocus
                disabled={isGenerating}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="generate-tone">
                Ton
              </label>
              <Select
                value={tone}
                onValueChange={setTone}
                disabled={isGenerating}
              >
                <SelectTrigger id="generate-tone">
                  <SelectValue placeholder="Choisir un ton" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="formel">Formel</SelectItem>
                  <SelectItem value="decontracte">Décontracté</SelectItem>
                  <SelectItem value="storytelling">Storytelling</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="generate-locale">
                Langue
              </label>
              <Select
                value={locale}
                onValueChange={setLocale}
                disabled={isGenerating}
              >
                <SelectTrigger id="generate-locale">
                  <SelectValue placeholder="Choisir une langue" />
                </SelectTrigger>
                <SelectContent>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {languages.map((lang: any) => (
                    <SelectItem key={lang._id} value={lang.code}>
                      {lang.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Languages className="h-4 w-4 text-muted-foreground" />
                  <label className="text-sm font-medium" htmlFor="generate-auto-translate">
                    Traduire automatiquement
                  </label>
                  {!accessStatus.entitlements?.autoBlog?.allowMultiLanguage && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      Enterprise
                    </Badge>
                  )}
                </div>
                <Switch
                  id="generate-auto-translate"
                  checked={autoTranslate}
                  onCheckedChange={setAutoTranslate}
                  disabled={
                    isGenerating ||
                    !accessStatus.entitlements?.autoBlog?.allowMultiLanguage
                  }
                />
              </div>
              {!accessStatus.entitlements?.autoBlog?.allowMultiLanguage ? (
                <p className="text-xs text-muted-foreground">
                  Disponible avec le plan Enterprise.{" "}
                  <Link
                    href="/dashboard/subscription"
                    className="underline hover:text-foreground"
                  >
                    Mettre a niveau
                  </Link>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  L&apos;article sera traduit dans toutes les langues actives du
                  store après génération.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                {/* Heads a block that swaps between two controls, so it names neither. */}
                <p className="text-sm font-medium">Catégorie</p>
                {!showNewCategory && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowNewCategory(true)}
                    disabled={isGenerating}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Nouvelle
                  </Button>
                )}
              </div>

              {showNewCategory ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    placeholder="Nom de la catégorie"
                    disabled={isCreatingCategory}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        handleCreateCategory()
                      }
                      if (e.key === "Escape") {
                        setShowNewCategory(false)
                        setNewCategoryName("")
                      }
                    }}
                    autoFocus
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleCreateCategory}
                    disabled={isCreatingCategory || !newCategoryName.trim()}
                  >
                    {isCreatingCategory ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ) : hasCategories ? (
                <Select
                  value={categoryId}
                  onValueChange={setCategoryId}
                  disabled={isGenerating}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choisir une catégorie" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {categories!.map((cat: any) => (
                      <SelectItem key={cat._id} value={cat._id}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="rounded-md border border-dashed p-3 text-center">
                  <p className="text-sm text-muted-foreground mb-2">
                    Aucune catégorie
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowNewCategory(true)}
                  >
                    <FolderPlus className="mr-2 h-4 w-4" />
                    Créer une catégorie
                  </Button>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isGenerating}
              >
                Annuler
              </Button>
              <Button
                type="submit"
                disabled={
                  isGenerating ||
                  !topic.trim() ||
                  !tone ||
                  !locale ||
                  !categoryId
                }
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Génération en cours...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Générer
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
