"use client";

import React from "react";
import Image from "next/image";
import { ArrowRight, Calendar } from "lucide-react";
import { useTranslation } from "@be-yours/restaurant";
import { cn } from "@/lib/utils";

interface BlogCardProps {
    title: string;
    date: string;
    image: string;
    className?: string;
}

export function BlogCard({ title, date, image, className }: BlogCardProps) {
    // « Read More » was typed into the markup, in English, on every teaser of a
    // French storefront. It is the catalogue's `blog.readMore` now.
    const { t } = useTranslation();

    return (
        <div className={cn("flex flex-col gap-8 group cursor-pointer lg:pb-8", className)}>
            <div className="relative aspect-[3/2.2] rounded-[3rem] overflow-hidden shadow-2xl border-none">
                {image ? (
                    <Image
                        src={image}
                        alt={title}
                        fill
                        className="object-cover group-hover:scale-110 transition-all duration-1000"
                    />
                ) : (
                    <div className="w-full h-full bg-muted flex items-center justify-center text-muted-foreground">
                        <Calendar className="h-12 w-12" />
                    </div>
                )}
                <div className="absolute top-6 left-6 h-16 w-16 bg-card rounded-2xl flex flex-col items-center justify-center shadow-xl shadow-black/10">
                    <span className="text-xl font-black text-foreground leading-none">{date.split(' ')[0]}</span>
                    <span className="text-[10px] font-black text-accent-foreground uppercase tracking-tighter leading-none mt-1">{date.split(' ')[1]}</span>
                </div>
            </div>
            <div className="px-2">
                <h3 className="text-2xl font-black tracking-tighter text-foreground leading-[1.2] group-hover:text-accent-foreground dark:group-hover:text-accent-foreground transition-colors">
                    {title}
                </h3>
                <div className="mt-8 flex items-center gap-3 text-accent-foreground font-black uppercase tracking-widest text-[10px] group-hover:translate-x-2 transition-all">
                    {t("blog.readMore")} <ArrowRight className="h-4 w-4" />
                </div>
            </div>
        </div>
    );
}
