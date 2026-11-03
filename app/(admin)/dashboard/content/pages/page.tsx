"use client"

import "@/lib/cms/init"
import { useState, useMemo } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useAdminStoreId } from "@/lib/admin/hooks"
import { useRouter } from "next/navigation"
import { FileText, Globe, PenLine, Search } from "lucide-react"
import {
  Badge,
  Button,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@be-yours/ui"
import { getCmsGroups } from "@be-yours/cms"

interface CmsPageSummary {
  slug: string
  label: string
  groupId?: string
  hasPublished: boolean
  hasUnpublishedChanges: boolean
}

type StatusFilter = "all" | "published" | "draft" | "unmodified"

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "Tous" },
  { value: "published", label: "Publié" },
  { value: "draft", label: "Brouillon" },
  { value: "unmodified", label: "Non modifié" },
]

function matchesStatus(page: CmsPageSummary, filter: StatusFilter): boolean {
  switch (filter) {
    case "published":
      return page.hasPublished === true
    case "draft":
      return page.hasUnpublishedChanges === true
    case "unmodified":
      return !page.hasPublished && !page.hasUnpublishedChanges
    default:
      return true
  }
}

function CmsPagesListSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header + search/filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-full sm:w-72 rounded-md" />
      </div>

      {/* Filter pills */}
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20 rounded-full" />
        ))}
      </div>

      {/* Group 1 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-20 ml-1" />
        <div className="rounded-lg border">
          <div className="flex items-center gap-4 px-4 py-3 border-b">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-36 hidden sm:block" />
            <div className="ml-auto">
              <Skeleton className="h-4 w-16" />
            </div>
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0"
            >
              <div className="flex items-center gap-2 min-w-[180px]">
                <Skeleton className="h-4 w-4 rounded" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-4 w-28 hidden sm:block" />
              <div className="ml-auto">
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Group 2 */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-24 ml-1" />
        <div className="rounded-lg border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0"
            >
              <div className="flex items-center gap-2 min-w-[180px]">
                <Skeleton className="h-4 w-4 rounded" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-24 hidden sm:block" />
              <div className="ml-auto">
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function CmsPagesListPage() {
  const storeId = useAdminStoreId()
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  const pages = useQuery(
    api.cms.listPages,
    storeId ? { storeId } : "skip",
  )

  const groups = useMemo(() => getCmsGroups(), [])

  const filteredGroupedPages = useMemo(() => {
    if (!pages) return []

    const query = search.toLowerCase().trim()
    const filtered = pages.filter((p: CmsPageSummary) => {
      const matchesSearch =
        !query ||
        p.label.toLowerCase().includes(query) ||
        p.slug.toLowerCase().includes(query)
      return matchesSearch && matchesStatus(p, statusFilter)
    })

    const grouped: Array<{
      groupId: string
      groupLabel: string
      pages: typeof filtered
    }> = []

    for (const group of groups) {
      const groupPages = filtered
        .filter((p: CmsPageSummary) => p.groupId === group.id)
        .sort((a: CmsPageSummary, b: CmsPageSummary) => a.label.localeCompare(b.label, "fr"))

      if (groupPages.length > 0) {
        grouped.push({
          groupId: group.id,
          groupLabel: group.label,
          pages: groupPages,
        })
      }
    }

    const ungrouped = filtered
      .filter((p: CmsPageSummary) => !p.groupId)
      .sort((a: CmsPageSummary, b: CmsPageSummary) => a.label.localeCompare(b.label, "fr"))

    if (ungrouped.length > 0) {
      grouped.push({
        groupId: "__ungrouped",
        groupLabel: "Autres",
        pages: ungrouped,
      })
    }

    return grouped
  }, [pages, groups, search, statusFilter])

  // Count pages per status for filter badges
  const statusCounts = useMemo(() => {
    if (!pages) return { all: 0, published: 0, draft: 0, unmodified: 0 }
    return {
      all: pages.length,
      published: pages.filter((p: CmsPageSummary) => p.hasPublished).length,
      draft: pages.filter((p: CmsPageSummary) => p.hasUnpublishedChanges).length,
      unmodified: pages.filter(
        (p: CmsPageSummary) => !p.hasPublished && !p.hasUnpublishedChanges,
      ).length,
    }
  }, [pages])

  if (!storeId) return null

  if (pages === undefined) {
    return <CmsPagesListSkeleton />
  }

  return (
    <div className="space-y-6">
      {/* Header + Search */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Pages</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Modifiez le contenu des pages de votre site.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher une page..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const count = statusCounts[f.value]
          const isActive = statusFilter === f.value
          return (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {f.label}
              <span
                className={`inline-flex items-center justify-center rounded-full px-1.5 min-w-[18px] text-[10px] font-semibold ${
                  isActive
                    // The INVERSE of the chip this badge sits in, so the fill
                    // token is the right one here and the ink token is not:
                    // `--primary-foreground` is whatever reads on `--primary`,
                    // and the token matrix already asserts that pair clears AA.
                    // `text-primary-ink` broke it — a template is free to make
                    // `--primary-foreground` near-black (asiatique-dragon does),
                    // and a mid-tone brand ink on near-black measured 2.964:1.
                    ? "bg-primary-foreground text-primary"
                    : "bg-background text-muted-foreground"
                }`}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Page list */}
      {filteredGroupedPages.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Aucune page ne correspond à vos filtres.
        </p>
      ) : (
        <div className="space-y-6">
          {filteredGroupedPages.map((group) => (
            <div key={group.groupId}>
              <h2 className="text-sm font-medium text-muted-foreground mb-2 px-1">
                {group.groupLabel}
              </h2>
              <div className="rounded-lg border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Page</TableHead>
                      <TableHead>Statut</TableHead>
                      <TableHead className="hidden sm:table-cell">
                        Dernière modification
                      </TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {group.pages.map((page: any) => (
                      <TableRow
                        key={page.slug}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          router.push(`/dashboard/content/pages/${page.slug}`)
                        }
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="font-medium">{page.label}</p>
                              <p className="text-xs text-muted-foreground">
                                {page.route ?? `/${page.slug}`}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            {page.hasPublished && (
                              <Badge
                                variant="default"
                                className="text-[10px]"
                              >
                                <Globe className="mr-1 h-2.5 w-2.5" />
                                Publié
                              </Badge>
                            )}
                            {page.hasUnpublishedChanges && (
                              <Badge
                                variant="secondary"
                                className="text-[10px]"
                              >
                                <PenLine className="mr-1 h-2.5 w-2.5" />
                                Brouillon
                              </Badge>
                            )}
                            {!page.hasPublished &&
                              !page.hasUnpublishedChanges && (
                                <span className="text-xs text-muted-foreground">
                                  Non modifié
                                </span>
                              )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-sm text-muted-foreground">
                            {page.draftUpdatedAt
                              ? new Date(
                                  page.draftUpdatedAt,
                                ).toLocaleDateString("fr-FR", {
                                  day: "numeric",
                                  month: "short",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              router.push(`/dashboard/content/pages/${page.slug}`)
                            }}
                          >
                            Modifier
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
