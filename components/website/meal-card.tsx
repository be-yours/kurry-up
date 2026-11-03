"use client";

import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { Star, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from "@be-yours/ui"
import { toast } from "sonner";
import { useCartStore, formatPrice, useTranslation } from "@be-yours/restaurant";
import { FavoriteButton } from "./favorite-button";

interface MealCardProps {
    id?: string | number;
    title: string;
    price: number;
    rating?: number;
    // Optional, and not invented: a dish nobody timed used to be given
    // « 20-30 mins » by its caller. The card does not print it today, which is
    // why nobody saw it; a figure about a dish is the kitchen's to state.
    time?: string;
    image: string;
    category?: string;
    isVeg?: boolean;
    isSpicy?: boolean;
    className?: string;
}

export function MealCard({
    id,
    title,
    price,
    rating,
    time,
    image,
    category,
    isVeg,
    isSpicy,
    className,
}: MealCardProps) {
    const { addItem } = useCartStore();
    // The label was the English word « Price », on a French storefront. It is
    // the catalogue's `product.price` now, which follows the visitor's language
    // and which the restaurateur can reword in « Traductions UI ».
    const { t } = useTranslation();

    const handleAddToCart = (e: React.MouseEvent) => {
        e.stopPropagation();
        addItem({
            productId: String(id ?? `__fallback_${title}_${price}`),
            name: title,
            price: Math.round(price * 100),
            quantity: 1,
            options: [],
            imageUrl: image,
        });
        toast.success(`${title} ajouté au panier !`, {
            description: "1 article ajouté.",
            duration: 2000,
        });
    };

    const resolvedImage = (() => {
        if (typeof image === "string" && image.trim() !== "") {
            if (image.startsWith("/api/storage/")) {
                const convexUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
                const storageId = image.split("/").pop();
                return `${convexUrl}/get-image?storageId=${storageId}`;
            }
            return image;
        }
        if (image && typeof image === "object" && (image as unknown as { url: string }).url) {
            return (image as unknown as { url: string }).url;
        }
        // Not "/imagery/hero-burger-v2.png": that file does not exist, so every
        // product without a photo asked the image optimizer for it and got a
        // 400. The wrapper below is already a neutral tile.
        return null;
    })();

    return (
        <motion.div
            whileHover={{ y: -10 }}
            className={cn(
                "bg-card rounded-[2.5rem] overflow-hidden shadow-2xl shadow-black/[0.04] border border-border hover:border-primary/20 transition-all group flex flex-col h-full cursor-pointer",
                className
            )}
        >
            <div className="relative aspect-[4/3] overflow-hidden bg-gray-100">
                {resolvedImage && (
                    <Image
                        src={resolvedImage}
                        alt={title}
                        fill
                        className="object-cover group-hover:scale-110 transition-all duration-700"
                    />
                )}
                <div className="absolute top-4 left-4 flex gap-2">
                    {isVeg ? (
                        <Badge className="bg-card/90 backdrop-blur-md text-foreground border-none py-1.5 px-3 rounded-lg font-bold uppercase text-[9px] shadow-sm">Veg</Badge>
                    ) : isSpicy ? (
                        <Badge className="bg-card/90 backdrop-blur-md text-foreground border-none py-1.5 px-3 rounded-lg font-bold uppercase text-[9px] shadow-sm">Spicy</Badge>
                    ) : null}
                </div>
                <div className="absolute top-4 right-4 z-10">
                    <FavoriteButton itemId={id ?? `__fallback_${title}_${price}`} itemTitle={title} />
                </div>
            </div>
            <div className="p-8 flex flex-col flex-1">
                <h3 className="text-lg font-black tracking-tighter text-foreground leading-tight mb-3 group-hover:text-accent-foreground transition-colors uppercase">
                    {title}
                </h3>
                {rating !== undefined && (
                    <div className="flex items-center gap-4 mb-6">
                        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-accent text-accent-foreground rounded-lg text-[10px] font-black">
                            <Star className="h-3 w-3 fill-current" />
                            {rating}
                        </div>
                    </div>
                )}

                <div className="mt-auto flex items-center justify-between gap-4">
                    <div className="flex flex-col">
                        <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest leading-none mb-1">{t("product.price")}</span>
                        <span className="text-xl font-black text-accent-foreground leading-none">{formatPrice(Math.round(price * 100))}</span>
                    </div>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                onClick={handleAddToCart}
                                className="h-12 w-12 rounded-2xl bg-primary text-primary-foreground hover:bg-primary-hover shadow-lg shadow-primary/10 hover:scale-110 transition-all p-0 border-none"
                            >
                                <Plus className="h-6 w-6" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent className="bg-primary text-primary-foreground border-none font-bold uppercase text-[10px] tracking-widest px-4 py-2 rounded-xl">
                            Ajouter au panier
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>
        </motion.div>
    );
}
