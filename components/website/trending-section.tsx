"use client"

import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useStoreId } from "@/lib/hooks/use-store-id"
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  Skeleton,
} from "@be-yours/ui"
import { Heading, MealCard } from "@/components/website"

interface TrendingProduct {
    _id: string
    name: string
    price: number
    preparationTime?: number
    images?: string[]
}

interface TrendingSectionProps {
    sectionTitle: string
    viewAllLabel: string
}

export function TrendingSection({ sectionTitle, viewAllLabel }: TrendingSectionProps) {
    const { storeId } = useStoreId()

    const store = useQuery(
        api.stores.getById,
        storeId ? { id: storeId as Id<"stores"> } : "skip"
    )

    const trendingMode = store?.trendingMode ?? "manual"

    const manualProducts = useQuery(
        api.products.getManualTrending,
        storeId && trendingMode === "manual" ? { storeId: storeId as Id<"stores"> } : "skip"
    )

    const autoProducts = useQuery(
        api.products.getTrending,
        storeId && trendingMode === "automatic" ? { storeId: storeId as Id<"stores"> } : "skip"
    )

    const products = trendingMode === "manual" ? manualProducts : autoProducts
    const isLoading = store === undefined || products === undefined

    // Loading state
    if (isLoading) {
        return (
            <section className="py-24 px-6 md:px-12 max-w-7xl mx-auto overflow-hidden">
                <Heading
                    title={sectionTitle}
                    barColor="bg-primary"
                    viewAll={{ label: viewAllLabel, href: "/menu" }}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-[320px] w-full rounded-3xl" />
                    ))}
                </div>
            </section>
        )
    }

    // Empty state — hide section entirely
    if (!products || products.length === 0) {
        return null
    }

    return (
        <section className="py-24 px-6 md:px-12 max-w-7xl mx-auto overflow-hidden">
            <Heading
                title={sectionTitle}
                barColor="bg-primary"
                viewAll={{ label: viewAllLabel, href: "/menu" }}
            />

            <Carousel opts={{ align: "start", loop: true }} className="w-full relative">
                <CarouselContent className="-ml-4 pb-8">
                    {(products as TrendingProduct[]).map((product) => (
                        <CarouselItem key={product._id} className="pl-4 basis-full sm:basis-1/2 lg:basis-1/3 xl:basis-1/4">
                            <MealCard
                                id={product._id}
                                title={product.name}
                                price={product.price / 100}
                                time={product.preparationTime ? `${product.preparationTime} mins` : undefined}
                                image={product.images?.[0] ?? "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?q=80&w=400&auto=format&fit=crop"}
                            />
                        </CarouselItem>
                    ))}
                </CarouselContent>
                <div className="flex justify-center md:justify-end gap-4 mt-8">
                    <CarouselPrevious className="static translate-y-0 h-12 w-12 rounded-full border border-border flex items-center justify-center hover:bg-primary-hover hover:text-primary-foreground transition-all bg-card dark:text-foreground" />
                    <CarouselNext className="static translate-y-0 h-12 w-12 rounded-full border border-border flex items-center justify-center bg-primary text-primary-foreground hover:scale-105 transition-all" />
                </div>
            </Carousel>
        </section>
    )
}
