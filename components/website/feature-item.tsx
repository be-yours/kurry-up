import React from "react";
import { cn } from "@/lib/utils";

interface FeatureItemProps {
    icon: React.ElementType | string;
    label: string;
    color?: string;
    isImageUrl?: boolean;
}

export function FeatureItem({ icon, label, color, isImageUrl }: FeatureItemProps) {
    const Icon = icon as React.ElementType;
    return (
        <div className="bg-card p-6 md:p-8 rounded-[2.5rem] shadow-xl shadow-black/[0.03] border border-white dark:border-border hover:border-border transition-all hover:scale-105 group h-full flex flex-col items-center text-center">
            <div className={cn(
                "w-24 h-24 rounded-[1.5rem] flex items-center justify-center mb-6 group-hover:scale-110 transition-all overflow-hidden bg-transparent shrink-0",
                color,
                // The brand branches are gone: `color` now arrives as
                // `bg-accent text-accent-foreground`, and a token already
                // carries its own dark value, so sniffing the string for
                // "bg-orange-" to bolt one on had nothing left to match.
                // Blue and purple stay literal — two of the five feature tiles
                // are deliberately off-brand accents, and #41 is about the
                // colours that should follow the template, not about these.
                color?.includes("bg-blue-") && "dark:bg-blue-950/30 dark:text-blue-400",
                color?.includes("bg-purple-") && "dark:bg-purple-950/30 dark:text-purple-400"
            )}>
                {isImageUrl ? (
                    <img src={icon as string} alt={label} className="w-full h-full object-contain drop-shadow-xl p-1" />
                ) : (
                    <Icon className="h-8 w-8" />
                )}
            </div>
            <p className="text-sm md:text-md font-black italic tracking-tight text-foreground leading-tight">
                {label}
            </p>
        </div>
    );
}
