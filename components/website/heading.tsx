import React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Button } from "@be-yours/ui"

interface HeadingProps {
    badge?: string;
    title: React.ReactNode;
    description?: string;
    align?: "left" | "center";
    viewAll?: { label?: string, href: string };
    badgeColor?: string;
    barColor?: string;
    textColor?: string;
    className?: string;
}

export function Heading({
    badge,
    title,
    description,
    align = "left",
    viewAll,
    badgeColor = "bg-accent text-accent-foreground dark:bg-primary/30 dark:text-accent-foreground",
    barColor,
    textColor = "text-foreground",
    className
}: HeadingProps) {
    const isCenter = align === "center";

    return (
        <div className={cn(
            "flex flex-col md:flex-row items-center md:items-end justify-between mb-16 gap-8",
            isCenter && "flex-col md:flex-col items-center md:items-center text-center",
            className
        )}>
            <div className={cn(
                "flex flex-col",
                isCenter ? "items-center" : "items-center md:items-start text-center md:text-left"
            )}>
                {badge && (
                    <Badge className={cn("mb-6 px-4 py-1.5 rounded-lg border-none font-black uppercase text-[10px] tracking-widest", badgeColor)}>
                        {badge}
                    </Badge>
                )}
                <h2 className={cn(
                    "text-4xl md:text-6xl font-black tracking-tighter leading-[1.1] whitespace-pre-line",
                    textColor,
                    isCenter ? "mb-6" : "mb-4"
                )}>
                    {typeof title === "string" ? (
                        title.split(/(\{[\s\S]*?\})/g).map((part, i) => {
                            if (part.startsWith("{") && part.endsWith("}")) {
                                return (
                                    <span key={i} className="text-accent-foreground italic">
                                        {part.slice(1, -1)}
                                    </span>
                                );
                            }
                            return part;
                        })
                    ) : (
                        title
                    )}
                </h2>
                {description && (
                    <p className={cn(
                        "text-muted-foreground font-medium max-w-xl",
                        isCenter ? "text-lg md:text-xl" : "text-md"
                    )}>
                        {description}
                    </p>
                )}
                {barColor && !isCenter && (
                    <div className={cn("h-1.5 w-24 rounded-full mt-4 mx-auto md:mx-0", barColor)} />
                )}
            </div>

            {viewAll && (
                <Link href={viewAll.href}>
                    {/*
                        This used to branch on whether `barColor` or `badgeColor`
                        SPELLED "emerald", to pick between a green and an orange
                        "View all". Both palettes were the brand wearing two
                        names, so both branches now resolve to the brand token
                        and the test between them has nothing left to decide.
                    */}
                    <Button variant="ghost" className={cn(
                        "font-black uppercase tracking-widest text-[10px] items-center gap-2",
                        "text-accent-foreground hover:bg-accent"
                    )}>
                        {viewAll.label || "View All"} <ChevronRight className="h-4 w-4" />
                    </Button>
                </Link>
            )}
        </div>
    );
}
