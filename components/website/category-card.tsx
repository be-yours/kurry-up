"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "@be-yours/restaurant";
import { cn } from "@/lib/utils";

interface CategoryCardProps {
    title: string;
    icon: string;
    /** Where the card leads: the carte, narrowed to this category. */
    href: string;
    itemsCount?: number;
    color: string;
    borderColor: string;
    isImageUrl?: boolean;
}

/**
 * « 1 produit » / « 12 produits ».
 *
 * Which of the two keys a count takes is the language's call, not `count === 1`:
 * French reads zero as singular (« 0 produit »), English and Spanish do not.
 * `Intl.PluralRules` knows; a locale it cannot parse reads as the plural, which
 * is the safe side of a number that is rarely 1.
 */
function isSingular(count: number, locale: string): boolean {
    try {
        return new Intl.PluralRules(locale).select(count) === "one";
    } catch {
        return false;
    }
}

export function CategoryCard({
    title,
    icon,
    href,
    itemsCount,
    color,
    borderColor,
    isImageUrl
}: CategoryCardProps) {
    const { t, locale } = useTranslation();

    // The count read "N Items" in English, or "0 Items" when nobody supplied
    // one; a card whose count is unknown now says nothing rather than zero.
    const displayCount =
        itemsCount === undefined
            ? null
            : t(
                  isSingular(itemsCount, locale)
                      ? "storefront.categoryProductsOne"
                      : "storefront.categoryProductsOther",
                  { count: itemsCount },
              );

    // It was a `motion.div` with an `onClick` that raised an English toast —
    // « Exploring Pizzas… » — and went nowhere. A card that offers a category is
    // a link to it: the carte already filters on `?category=<slug>`.
    return (
        <Link
            href={href}
            className="block h-full rounded-[2.5rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
            <motion.div
                whileHover={{ y: -10 }}
                className={cn(
                    "relative p-8 rounded-[2.5rem] border bg-gradient-to-br transition-all duration-300 group flex flex-col items-center justify-center gap-4 text-center h-full",
                    color,
                    borderColor,
                    // As in feature-item.tsx: the brand arrives as a token that
                    // already knows its dark value, so the two branches that
                    // sniffed for "-orange-" / "-emerald-" are gone.
                    borderColor?.includes("-blue-") && "dark:border-blue-900/50",
                    borderColor?.includes("-yellow-") && "dark:border-yellow-900/50",
                    borderColor?.includes("-pink-") && "dark:border-pink-900/50",
                    color?.includes("from-blue-") && "dark:from-blue-950/20 dark:to-blue-950/5",
                    color?.includes("from-yellow-") && "dark:from-yellow-950/20 dark:to-yellow-950/5",
                    color?.includes("from-pink-") && "dark:from-pink-950/20 dark:to-pink-950/5"
                )}
            >
                <div className="h-24 w-24 rounded-3xl bg-transparent flex items-center justify-center text-4xl group-hover:scale-110 group-hover:rotate-6 transition-all duration-500 overflow-hidden shrink-0">
                    {(isImageUrl && icon && icon.length > 0) ? (
                        // Decorative: the heading beside it names the category,
                        // and the link's name is built from that heading.
                        <img src={icon} alt="" className="w-full h-full object-contain" />
                    ) : (
                        icon || "🍽️"
                    )}
                </div>
                <div>
                    <h3 className="text-lg font-black tracking-tighter text-foreground mb-1">{title}</h3>
                    {displayCount && (
                        <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">
                            {displayCount}
                        </p>
                    )}
                </div>

                <div className="absolute bottom-4 right-4 h-8 w-8 rounded-full bg-card dark:bg-muted opacity-0 group-hover:opacity-100 transition-all duration-300 flex items-center justify-center shadow-lg translate-y-2 group-hover:translate-y-0">
                    <ChevronRight className="h-4 w-4 text-accent-foreground" />
                </div>
            </motion.div>
        </Link>
    );
}
