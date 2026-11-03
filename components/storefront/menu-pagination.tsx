"use client"

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@be-yours/ui"

interface MenuPaginationProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}

export function MenuPagination({
  currentPage,
  totalPages,
  onPageChange,
}: MenuPaginationProps) {
  if (totalPages <= 1) return null

  // Build visible page numbers with ellipsis
  const getPageNumbers = (): (number | "ellipsis")[] => {
    const pages: (number | "ellipsis")[] = []

    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i)
      return pages
    }

    // Always show first page
    pages.push(1)

    if (currentPage > 3) {
      pages.push("ellipsis")
    }

    // Pages around current
    const start = Math.max(2, currentPage - 1)
    const end = Math.min(totalPages - 1, currentPage + 1)
    for (let i = start; i <= end; i++) {
      pages.push(i)
    }

    if (currentPage < totalPages - 2) {
      pages.push("ellipsis")
    }

    // Always show last page
    pages.push(totalPages)

    return pages
  }

  return (
    <div className="flex justify-center mt-12 mb-20 bg-card p-6 rounded-3xl border border-border shadow-sm max-w-2xl mx-auto">
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              className={`cursor-pointer h-12 w-12 rounded-xl bg-card border-border hover:bg-muted text-foreground transition-all [&>span]:hidden ${
                currentPage === 1 ? "pointer-events-none opacity-50" : ""
              }`}
            />
          </PaginationItem>

          {getPageNumbers().map((page, i) =>
            page === "ellipsis" ? (
              <PaginationItem key={`ellipsis-${i}`}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={page}>
                <PaginationLink
                  onClick={() => onPageChange(page)}
                  isActive={currentPage === page}
                  className={`cursor-pointer font-black h-12 w-12 rounded-xl transition-all ${
                    currentPage === page
                      ? "bg-primary text-primary-foreground border-none shadow-lg hover:bg-primary-hover"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {page}
                </PaginationLink>
              </PaginationItem>
            )
          )}

          <PaginationItem>
            <PaginationNext
              onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
              className={`cursor-pointer h-12 w-12 rounded-xl bg-card border-border hover:bg-muted text-foreground transition-all [&>span]:hidden ${
                currentPage === totalPages ? "pointer-events-none opacity-50" : ""
              }`}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
