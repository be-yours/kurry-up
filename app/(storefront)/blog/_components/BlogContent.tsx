"use client"

import React, { useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { ArrowRight, BookOpen } from "lucide-react"
import { motion } from "framer-motion"
import { useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Button, Badge } from "@be-yours/ui"
import { useCmsPage } from "@/lib/cms/useCmsPage"
import type { CmsInitialData } from "@/lib/cms/page-data"
import { parseColoredText } from "@/lib/parse-colored-text"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { articleCategoryClasses, formatArticleDate } from "@/lib/blog/presentation"
import type { Id } from "@/convex/_generated/dataModel"
import { toast } from "sonner"

export default function BlogPage({ initialData }: { initialData?: CmsInitialData | null }) {
    // `initialData` is the page as the server read it, so the first HTML says
    // what the owner wrote instead of the sample copy below.
    const { block } = useCmsPage("blog", { initialData })
    const { storeId } = useStoreId()
    const subscribe = useMutation(api.emailSubscribers.subscribe)
    const [newsletterEmail, setNewsletterEmail] = useState("")
    const [subscribing, setSubscribing] = useState(false)

    // Six demo posts used to live in this file, linking to twelve URLs that did
    // not exist. What the owner publishes in the admin is what belongs here.
    const articles = useQuery(
        api.blog.listPublishedArticles,
        storeId ? { storeId: storeId as Id<"stores"> } : "skip",
    )

    const hero = block("hero")

    const heroBadge = hero.field("badge").text ?? "Notre Blog"
    const heroTitle = hero.field("title").text ?? "Saveurs, conseils \n& {inspirations}"
    const heroSubtitle = hero.field("subtitle").text ?? "Restez informé des dernières nouvelles, recettes et conseils de notre équipe culinaire."

    const isLoading = articles === undefined
    const featured = articles?.[0] ?? null
    const posts = articles?.slice(1) ?? []

    return (
        <div className="min-h-screen bg-background dark:bg-muted text-foreground dark:text-foreground font-sans overflow-x-hidden transition-colors duration-500">
            {/* ─── HERO ─── */}
            <section className="relative pt-24 pb-20 md:pt-32 md:pb-32 px-6 md:px-12 overflow-hidden bg-primary rounded-b-none md:rounded-b-[6rem]">
                <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none">
                    <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-white/20 rounded-full blur-[100px]" />
                    <div className="absolute bottom-0 left-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px]" />
                </div>

                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    className="max-w-4xl mx-auto relative z-10 text-center"
                >
                    <Badge className="bg-primary-hover text-primary-foreground border-white/30 backdrop-blur-md px-4 py-1.5 rounded-full mb-6 font-black tracking-widest uppercase text-[10px] shadow-lg">
                        {heroBadge}
                    </Badge>
                    <h1 className="text-5xl md:text-7xl lg:text-8xl font-black text-primary-foreground leading-[0.9] tracking-tighter mb-8 whitespace-pre-line">
                        {parseColoredText(heroTitle, "text-primary-foreground italic")}
                    </h1>
                    <p className="text-lg md:text-xl text-primary-foreground max-w-2xl mx-auto leading-relaxed font-medium">
                        {heroSubtitle}
                    </p>
                </motion.div>
            </section>

            {/* ─── FEATURED POST ─── */}
            {featured && (
                <section className="py-16 md:py-24 px-6 md:px-12 max-w-7xl mx-auto -mt-12 relative z-20">
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, delay: 0.3 }}
                    >
                        <Link href={`/blog/${featured.slug}`} className="group block">
                            <div className="bg-card rounded-[3rem] overflow-hidden shadow-2xl shadow-black/[0.06] border border-border hover:shadow-3xl transition-all duration-500">
                                <div className="flex flex-col lg:flex-row">
                                    <div className="relative lg:w-3/5 aspect-[16/10] lg:aspect-auto overflow-hidden bg-muted">
                                        {featured.coverImage?.url && (
                                            <Image
                                                src={featured.coverImage.url}
                                                alt={featured.coverImage.alt ?? featured.title}
                                                fill
                                                className="object-cover group-hover:scale-105 transition-transform duration-1000"
                                            />
                                        )}
                                        <div className="absolute inset-0 bg-gradient-to-r from-black/20 via-transparent to-transparent" />
                                        <div className="absolute top-6 left-6">
                                            <Badge className="bg-primary text-primary-foreground border-none px-4 py-1.5 rounded-full font-black tracking-widest uppercase text-[10px] shadow-lg">
                                                À la une
                                            </Badge>
                                        </div>
                                    </div>
                                    <div className="lg:w-2/5 p-8 md:p-12 flex flex-col justify-center">
                                        {featured.category && (
                                            <Badge className={`w-fit mb-4 px-3 py-1 rounded-full font-black tracking-widest uppercase text-[9px] ${articleCategoryClasses(featured.category.slug)}`}>
                                                {featured.category.name}
                                            </Badge>
                                        )}
                                        <h2 className="text-3xl md:text-4xl font-black tracking-tighter leading-tight mb-4 text-foreground group-hover:text-accent-foreground dark:group-hover:text-accent-foreground transition-colors">
                                            {featured.title}
                                        </h2>
                                        <p className="text-muted-foreground font-medium leading-relaxed mb-6">
                                            {featured.excerpt}
                                        </p>
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                                                {formatArticleDate(featured.publishedAt)} · {featured.readingMinutes} min de lecture
                                            </span>
                                            <span className="text-[10px] font-black uppercase tracking-widest text-accent-foreground flex items-center gap-2 group-hover:gap-3 transition-all">
                                                Lire <ArrowRight className="h-3 w-3" />
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </Link>
                    </motion.div>
                </section>
            )}

            {/* ─── POSTS GRID ─── */}
            {/* Only worth a section when there is something under the heading:
                a store with a single article shows it above, as the featured
                one, and "Tous les articles (1)" over an empty grid reads as a
                page that failed to load. */}
            {(isLoading || articles?.length === 0 || posts.length > 0) && (
            <section className={`pb-24 px-6 md:px-12 max-w-7xl mx-auto ${featured ? "" : "pt-24"}`}>
                <div className="flex items-center gap-3 mb-12">
                    <div className="h-10 w-10 rounded-xl bg-primary/10 dark:bg-primary/30 flex items-center justify-center">
                        <BookOpen className="h-5 w-5 text-accent-foreground" />
                    </div>
                    <h2 className="text-2xl font-black uppercase tracking-tighter text-foreground">
                        Tous les articles
                    </h2>
                    {posts.length > 0 && (
                        <span className="text-sm font-bold text-muted-foreground">({posts.length})</span>
                    )}
                </div>

                {isLoading && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-96 rounded-[2.5rem] bg-card border border-border animate-pulse"
                            />
                        ))}
                    </div>
                )}

                {!isLoading && articles?.length === 0 && (
                    <div className="rounded-[2.5rem] border border-dashed border-border py-20 text-center">
                        <BookOpen className="h-8 w-8 mx-auto text-muted-foreground mb-4" />
                        <p className="text-muted-foreground font-medium">
                            Aucun article pour le moment. Revenez bientôt !
                        </p>
                    </div>
                )}

                {posts.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                        {posts.map((post, i) => (
                            <motion.div
                                key={post._id}
                                initial={{ opacity: 0, y: 20 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: i * 0.1 }}
                                viewport={{ once: true }}
                            >
                                <Link href={`/blog/${post.slug}`} className="group block h-full">
                                    <div className="bg-card rounded-[2.5rem] overflow-hidden shadow-lg shadow-black/[0.03] border border-border hover:shadow-xl hover:-translate-y-1 transition-all duration-300 h-full flex flex-col">
                                        <div className="relative aspect-[16/10] overflow-hidden bg-muted">
                                            {post.coverImage?.url && (
                                                <Image
                                                    src={post.coverImage.url}
                                                    alt={post.coverImage.alt ?? post.title}
                                                    fill
                                                    className="object-cover group-hover:scale-110 transition-all duration-700"
                                                />
                                            )}
                                            {post.category && (
                                                <div className="absolute top-4 left-4">
                                                    <Badge className={`px-3 py-1 rounded-full font-black tracking-widest uppercase text-[9px] ${articleCategoryClasses(post.category.slug)}`}>
                                                        {post.category.name}
                                                    </Badge>
                                                </div>
                                            )}
                                            <div className="absolute top-4 right-4 bg-card px-3 py-1.5 rounded-xl shadow-lg border border-border">
                                                <p className="text-[9px] font-black uppercase tracking-widest text-accent-foreground">{post.readingMinutes} min</p>
                                            </div>
                                        </div>
                                        <div className="p-6 md:p-8 flex-1 flex flex-col">
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                                                {formatArticleDate(post.publishedAt)}
                                            </p>
                                            <h3 className="text-xl font-black tracking-tighter text-foreground leading-tight mb-3 group-hover:text-accent-foreground dark:group-hover:text-accent-foreground transition-colors">
                                                {post.title}
                                            </h3>
                                            <p className="text-sm text-muted-foreground font-medium leading-relaxed flex-1">
                                                {post.excerpt}
                                            </p>
                                            <div className="mt-6 pt-4 border-t border-border flex items-center text-[10px] font-black uppercase tracking-widest text-accent-foreground group-hover:gap-3 gap-2 transition-all">
                                                Lire la suite <ArrowRight className="h-3 w-3" />
                                            </div>
                                        </div>
                                    </div>
                                </Link>
                            </motion.div>
                        ))}
                    </div>
                )}
            </section>
            )}

            {/* ─── NEWSLETTER CTA ─── */}
            <section className="px-6 md:px-12 max-w-7xl mx-auto mb-24">
                <div className="bg-primary rounded-[3rem] md:rounded-[4rem] p-10 md:p-16 text-center relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-full h-full pointer-events-none">
                        <div className="absolute top-[-10%] right-[-10%] w-[400px] h-[400px] bg-primary/10 rounded-full blur-[120px]" />
                    </div>
                    <div className="relative z-10 max-w-2xl mx-auto">
                        <h2 className="text-3xl md:text-5xl font-black text-primary-foreground tracking-tighter leading-tight mb-4">
                            Ne manquez rien
                        </h2>
                        <p className="text-primary-foreground font-medium mb-8">
                            Inscrivez-vous à notre newsletter pour recevoir nos derniers articles et offres exclusives.
                        </p>
                        <form
                            onSubmit={async (e) => {
                                e.preventDefault()
                                if (!storeId || !newsletterEmail || subscribing) return
                                setSubscribing(true)
                                try {
                                    await subscribe({
                                        storeId: storeId as Id<"stores">,
                                        email: newsletterEmail,
                                    })
                                    toast.success("Inscription confirmée !", {
                                        description: "Vérifiez votre boîte mail pour confirmer votre inscription.",
                                    })
                                    setNewsletterEmail("")
                                } catch {
                                    toast.error("Cet email est déjà inscrit ou une erreur est survenue.")
                                } finally {
                                    setSubscribing(false)
                                }
                            }}
                            className="flex flex-col sm:flex-row gap-3 max-w-lg mx-auto"
                        >
                            <input
                                type="email"
                                required
                                aria-label="Votre adresse email"
                                value={newsletterEmail}
                                onChange={(e) => setNewsletterEmail(e.target.value)}
                                placeholder="Votre email..."
                                className="flex-1 h-14 px-6 rounded-2xl bg-primary-hover border border-white/10 text-primary-foreground placeholder:text-primary-foreground font-bold text-sm outline-none focus:border-white/30 transition-colors"
                            />
                            <Button
                                type="submit"
                                disabled={subscribing}
                                className="h-14 px-8 rounded-2xl bg-primary-foreground hover:text-primary-hover text-primary font-black uppercase tracking-widest text-xs shadow-xl shadow-primary/20"
                            >
                                {subscribing ? "..." : "S'inscrire"}
                            </Button>
                        </form>
                    </div>
                </div>
            </section>
        </div>
    )
}
