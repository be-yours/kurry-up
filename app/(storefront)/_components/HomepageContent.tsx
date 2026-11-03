"use client"

import React from "react"
import Link from "next/link"
import Image from "next/image"
import {
    ShoppingBag,
    Clock,
    CreditCard,
    Leaf,
    Truck,
    Star,
    ArrowRight,
    ChevronRight,
} from "lucide-react"
import { motion } from "framer-motion"
import { Badge, Button } from "@be-yours/ui"
import {
    Heading,
    FeatureItem,
    BlogCard,
    TrendingSection,
    CategoriesSection,
} from "@/components/website"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useCmsPage } from "@/lib/cms/useCmsPage"
import type { CmsInitialData } from "@/lib/cms/page-data"
import { useStoreId } from "@/lib/hooks/use-store-id"
import { formatArticleDate } from "@/lib/blog/presentation"
import { parseColoredText } from "@/lib/parse-colored-text"

// ─── Page ───────────────────────────────────────────────────────────────────

export default function LandingPage({ initialData }: { initialData?: CmsInitialData | null }) {
    // `initialData` is the page as the server read it, so the first HTML says
    // what the owner wrote instead of the sample copy below.
    const { block } = useCmsPage("homepage", { initialData })

    const hero = block("hero")
    const features = block("features")
    const trending = block("trendingMeals")
    const cats = block("categories")
    const cta = block("cta")
    const blog = block("blog")

    // Three real articles, or no blog section at all. The teaser used to render
    // three hard-coded posts that all linked back to /blog.
    const { storeId } = useStoreId()
    const latestArticles = useQuery(
        api.blog.listPublishedArticles,
        storeId ? { storeId: storeId as Id<"stores">, limit: 3 } : "skip",
    )

    // Hero
    //
    // WHAT A FRESH SITE MAY NOT SAY ABOUT ITSELF. Four of these fell back to a
    // claim the establishment never made — « Restaurant Premium », a « Top
    // Rated · Gourmet Choice » stamp with a star, « Livraison rapide · 15-30
    // Mins » — and a fresh site published them on its own homepage with
    // nothing to tell the owner they were samples. A rating stamp is the thing
    // this product refuses to invent (the comment on the hero section below says
    // so), and a delivery time is a figure about an establishment, which is the
    // establishment's to state. Sample COPY may fall back; a claim or a figure
    // may not. Left empty, the badge or the pill is simply not drawn, and the
    // owner who wants one fills the field in the CMS.
    const heroBadge = hero.field("badge").text
    const heroTitle = hero.field("title").text ?? "Bienvenue Chez {Nous}"
    const heroSubtitle = hero.field("subtitle").text ?? "Découvrez nos plats préparés avec passion et des ingrédients frais, livrés directement chez vous ou à emporter."
    // No fallback path here: `/imagery/hero-burger-v2.png` never existed —
    // `public/imagery/` does not exist either — so the placeholder was a 400
    // from the image optimizer on every homepage without a hero upload. An
    // absent image is drawn as the empty frame it is.
    const heroImage = hero.field("image").mediaUrl
    // The CMS media field carries an `altText` the owner fills in (the admin
    // even offers to generate one), and this page ignored it in favour of the
    // literal "Hero" — one English word, identical on every storefront, saying
    // nothing about the dish in the picture. Read what they wrote. With
    // nothing written the image is marked decorative rather than mislabelled:
    // the h1 beside it already carries the meaning, and inventing a
    // description of an establishment's own photograph is not ours to do.
    const heroImageAlt = hero.field("image").altText ?? ""
    const heroCtaLabel = hero.field("ctaLabel").text ?? "Voir le Menu"
    const fb1Title = hero.field("floatingBadge1Title").text
    const fb1Subtitle = hero.field("floatingBadge1Subtitle").text
    const fb2Title = hero.field("floatingBadge2Title").text
    const fb2Subtitle = hero.field("floatingBadge2Subtitle").text

    // Features
    // The sample labels are French, like the rest of the page: these five and the
    // two sections below fell back to English on a French storefront. They are
    // sample copy, which is allowed to fall back, and worded so that none of
    // them claims a service or a quality the establishment has not said it has
    // (a pizzeria's categories are not « from juicy burgers to fresh salads »).
    const feat1 = features.field("feature1Label").text ?? "Livraison ou retrait"
    const feat1Img = features.field("feature1Image").mediaUrl
    const feat2 = features.field("feature2Label").text ?? "Paiement sécurisé"
    const feat2Img = features.field("feature2Image").mediaUrl
    const feat3 = features.field("feature3Label").text ?? "Une cuisine faite maison"
    const feat3Img = features.field("feature3Image").mediaUrl
    const feat4 = features.field("feature4Label").text ?? "Click & Collect"
    const feat4Img = features.field("feature4Image").mediaUrl
    const feat5 = features.field("feature5Label").text ?? "Commande en ligne"
    const feat5Img = features.field("feature5Image").mediaUrl

    // Trending
    const trendingTitle = trending.field("sectionTitle").text ?? "Nos plats du moment"
    const trendingViewAll = trending.field("viewAllLabel").text ?? "Tout voir"

    // Categories
    const catsBadge = cats.field("badge").text ?? "Découvrez le menu"
    const catsTitle = cats.field("sectionTitle").text ?? "Nos catégories"
    const catsDesc = cats.field("description").text ?? "Parcourez notre carte par catégorie."


    // CTA
    // No « Limited Time Offer » default: it announced an offer nobody had made,
    // on every fresh site, in English.
    const ctaBadge = cta.field("badge").text
    const ctaTitle = cta.field("title").text ?? "Prêt à {commander} ?"
    const ctaSubtitle = cta.field("subtitle").text ?? "Découvrez notre menu complet et commandez vos plats préférés en quelques clics."
    const ctaButtonText = cta.field("buttonText").text ?? "Explorer le Menu"
    const ctaBgImageAlt = cta.field("backgroundImage").altText ?? ""
    const ctaBgImage = cta.field("backgroundImage").mediaUrl ?? "https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=2070&auto=format&fit=crop"


    // Blog
    const blogTitle = blog.field("sectionTitle").text ?? "Consultez notre \n {Blog}"
    const blogViewAll = blog.field("viewAllLabel").text ?? "Tout voir"

    return (
        <div className="min-h-screen bg-background dark:bg-muted text-foreground dark:text-foreground font-sans overflow-x-hidden transition-colors duration-500">
            {/* ─── HERO ─── */}
            {/* `storefront-hero*` are hooks for the `hero` layout family (#507), not
                styling. THREE of its ten values are expressible on this markup and
                are CSS rules in `app/globals.css`; the other seven want a
                photograph, a second image, a locations board, a marquee — or a
                rating stamp this product refuses to invent — and would need a
                different tree. The default here IS `split`, so an unstyled hero is
                already correct. (Three, not four: `HONOURED.hero` has named
                `split`, `zen` and `banner` since #507 and this comment has said
                four since the day it was written.) */}
            <section className="storefront-hero relative pt-24 pb-20 md:pt-32 md:pb-32 px-6 md:px-12 overflow-hidden bg-primary rounded-b-none md:rounded-b-[6rem]">
                <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none">
                    <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-white/20 rounded-full blur-[100px]" />
                    <div className="absolute bottom-0 left-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px]" />
                </div>

                <div className="storefront-hero-row max-w-7xl mx-auto flex flex-col md:flex-row items-center gap-12 relative z-10">
                    <motion.div
                        initial={{ opacity: 0, x: -50 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                        className="storefront-hero-text flex-1 text-center md:text-left"
                    >
                        {heroBadge && (
                            <Badge className="bg-primary-hover text-primary-foreground border-white/30 backdrop-blur-md px-4 py-1.5 rounded-full mb-6 font-black tracking-widest uppercase text-[10px] shadow-lg">
                                {heroBadge}
                            </Badge>
                        )}
                        <h1 className="text-5xl md:text-7xl lg:text-8xl font-black text-primary-foreground leading-[0.9] tracking-tighter mb-8 drop-shadow-2xl whitespace-pre-line">
                            {parseColoredText(heroTitle, "text-primary-foreground italic")}
                        </h1>
                        <p className="text-lg md:text-xl text-primary-foreground mb-10 max-w-lg leading-relaxed font-black drop-shadow-md">
                            {heroSubtitle}
                        </p>
                        <div className="flex flex-col sm:flex-row items-center gap-4 w-full">
                            <Button
                                asChild
                                className="h-16 w-full sm:w-auto px-10 rounded-2xl bg-primary-foreground hover:text-primary-hover text-primary font-black uppercase tracking-widest text-xs shadow-xl shadow-primary/20 group transition-all duration-300"
                            >
                                <Link href="/menu">
                                    {heroCtaLabel}
                                    <ArrowRight className="h-5 w-5 ml-2 group-hover:translate-x-1 transition-transform" />
                                </Link>
                            </Button>
                        </div>
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
                        animate={{ opacity: 1, scale: 1, rotate: 0 }}
                        transition={{ duration: 1, ease: "easeOut", delay: 0.2 }}
                        className="storefront-hero-media flex-1 relative w-full mt-24 md:mt-0"
                    >
                        <div className="relative w-full aspect-square max-w-xl mx-auto">
                            {heroImage && (
                                <Image
                                    src={heroImage}
                                    alt={heroImageAlt}
                                    fill
                                    className="object-contain drop-shadow-[0_45px_45px_rgba(0,0,0,0.6)] z-20 scale-125"
                                    priority
                                />
                            )}

                            {/* Floating badge 1.

                                It floated forever. WCAG 2.2.2 (Pause, Stop,
                                Hide, Level A) covers moving content that
                                starts on its own, runs for more than five
                                seconds and sits beside other content, and it
                                wants a way to stop it. There is no pause
                                control on a restaurant hero and adding one
                                would be chrome nobody wants, so the motion
                                settles instead: one four-second float and the
                                badge comes to rest, which is inside the five
                                seconds the criterion allows and removes the
                                obligation rather than papering over it.

                                `prefers-reduced-motion` is a different
                                promise, kept separately by `MotionConfig` in
                                `app/providers.tsx` — that one suppresses the
                                float altogether. This one is for everybody
                                else. */}
                            {(fb1Title || fb1Subtitle) && (
                            <motion.div
                                animate={{ y: [0, -20, 0] }}
                                transition={{ duration: 4, ease: "easeInOut" }}
                                className="absolute top-10 -left-10 z-30 bg-primary-hover backdrop-blur-md p-4 rounded-3xl border border-primary-foreground/20 shadow-2xl"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-primary rounded-full">
                                        <Star className="h-4 w-4 text-primary-foreground fill-current" />
                                    </div>
                                    <div className="text-primary-foreground text-left">
                                        <p className="text-[10px] font-black uppercase tracking-tighter opacity-70 leading-none mb-1">
                                            {fb1Title}
                                        </p>
                                        <p className="text-sm font-black leading-none tracking-tight">
                                            {fb1Subtitle}
                                        </p>
                                    </div>
                                </div>
                            </motion.div>
                            )}

                            {/* Floating badge 2 — see badge 1. Four seconds
                                here too: it was five, and "more than five
                                seconds" is the line the criterion draws, so
                                sitting exactly on it is not a place to be. */}
                            {(fb2Title || fb2Subtitle) && (
                            <motion.div
                                animate={{ y: [0, 20, 0] }}
                                transition={{ duration: 4, ease: "easeInOut", delay: 1 }}
                                className="absolute bottom-1/4 -right-10 z-30 bg-primary-hover backdrop-blur-md p-4 rounded-3xl border border-primary-foreground/20 shadow-2xl"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-primary rounded-full">
                                        <Clock className="h-4 w-4 text-primary-foreground" />
                                    </div>
                                    <div className="text-primary-foreground text-left">
                                        <p className="text-[10px] font-black uppercase tracking-tighter opacity-70 leading-none mb-1">
                                            {fb2Title}
                                        </p>
                                        <p className="text-sm font-black leading-none tracking-tight">
                                            {fb2Subtitle}
                                        </p>
                                    </div>
                                </div>
                            </motion.div>
                            )}
                        </div>
                    </motion.div>
                </div>
            </section>

            {/* ─── FEATURES STRIP ─── */}
            <section className="py-12 px-6 md:px-12 max-w-7xl mx-auto -mt-16 relative z-30">
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
                    <FeatureItem icon={feat1Img ?? Truck} label={feat1} color="bg-accent text-accent-foreground" isImageUrl={!!feat1Img} />
                    <FeatureItem icon={feat2Img ?? CreditCard} label={feat2} color="bg-accent text-accent-foreground" isImageUrl={!!feat2Img} />
                    <FeatureItem icon={feat3Img ?? Leaf} label={feat3} color="bg-blue-100 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400" isImageUrl={!!feat3Img} />
                    <FeatureItem icon={feat4Img ?? ShoppingBag} label={feat4} color="bg-purple-100 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400" isImageUrl={!!feat4Img} />
                    <FeatureItem icon={feat5Img ?? Star} label={feat5} color="bg-accent text-accent-foreground" isImageUrl={!!feat5Img} />
                </div>
            </section>

            {/* ─── TRENDING SECTION ─── */}
            <TrendingSection
                sectionTitle={trendingTitle}
                viewAllLabel={trendingViewAll}
            />

            {/* ─── CATEGORIES ─── */}
            <CategoriesSection
                badge={catsBadge}
                sectionTitle={catsTitle}
                description={catsDesc}
            />

            {/* ─── CTA / PROMO BANNER ─── */}
            <section className="py-12 md:py-32 px-0 md:px-6 relative overflow-hidden">
                <div className="max-w-7xl mx-auto bg-primary-hover rounded-none md:rounded-[6rem] overflow-hidden relative p-12 md:p-16 lg:p-24 shadow-3xl shadow-primary/40">
                    <div className="absolute top-0 right-0 w-full h-full pointer-events-none">
                        <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] bg-primary/10 rounded-full blur-[120px]" />
                        <div className="absolute bottom-[-10%] left-[-10%] w-[300px] h-[300px] bg-primary/10 rounded-full blur-[100px]" />
                    </div>

                    <div className="relative z-10">
                        <div className="text-center mb-16 lg:mb-24">
                            {ctaBadge && (
                                <Badge className="bg-primary text-primary-foreground mb-8 px-4 py-1.5 rounded-full border-none font-black uppercase text-[10px] tracking-widest shadow-lg shadow-primary/20">
                                    {ctaBadge}
                                </Badge>
                            )}
                            <h2 className="text-4xl md:text-6xl lg:text-7xl xl:text-8xl font-black text-primary-foreground leading-[0.9] tracking-tighter italic whitespace-pre-line">
                                {parseColoredText(ctaTitle, "text-primary-foreground not-italic")}
                            </h2>
                        </div>

                        <div className="flex flex-col lg:flex-row items-center gap-16 lg:gap-24">
                            <div className="flex-1 text-center lg:text-left w-full">
                                <p className="text-primary-foreground text-lg md:text-xl font-medium mb-12 max-w-xl leading-relaxed mx-auto lg:mx-0">
                                    {ctaSubtitle}
                                </p>

                                {/* « Livraison Gratuite », typed into this component, stood
                                    here: a commercial promise printed for every
                                    establishment, whether it delivers or what it
                                    charges when it does. The delivery fee is the
                                    owner's setting, not a line of markup. */}

                                <Link href="/menu">
                                    <Button className="h-18 w-full md:w-auto px-12 rounded-2xl bg-card text-accent-foreground hover:bg-muted font-black uppercase tracking-widest text-sm shadow-2xl transition-all hover:scale-105 group">
                                        {ctaButtonText}
                                        <ArrowRight className="ml-3 h-5 w-5 group-hover:translate-x-2 transition-transform" />
                                    </Button>
                                </Link>
                            </div>

                            <div className="flex-1 w-full relative mt-16 md:mt-0">
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    whileInView={{ opacity: 1, scale: 1 }}
                                    transition={{ duration: 0.8 }}
                                    className="relative aspect-video lg:aspect-[4/3] rounded-[3rem] overflow-hidden shadow-2xl border-8 border-white/5 group"
                                >
                                    <Image
                                        src={ctaBgImage}
                                        alt={ctaBgImageAlt}
                                        fill
                                        className="object-cover group-hover:scale-110 transition-all duration-1000"
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-t from-primary-hover/80 via-transparent to-transparent" />

                                    {/* A play button and a « Watch our story · 2:45 Mins » card
                                        stood here. There is no video anywhere in the product —
                                        no field for one, no player, no handler on the button —
                                        so a diner was offered a story that could not be played,
                                        with a running time nobody had measured. The picture is
                                        the whole of this block until a video exists. */}
                                </motion.div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ─── BLOG ─── */}
            {(latestArticles?.length ?? 0) > 0 && (
                <section className="py-24 px-6 md:px-12 max-w-7xl mx-auto bg-card/40 rounded-[5rem] shadow-sm mb-24 border border-border transition-colors duration-500">
                    <div className="flex items-end justify-between mb-16 px-8">
                        <div>
                            <h2 className="text-5xl md:text-7xl font-black tracking-tighter text-foreground leading-[0.9] mb-6 whitespace-pre-line">
                                {parseColoredText(blogTitle, "text-accent-foreground italic")}
                            </h2>
                            <div className="h-2 w-24 bg-primary rounded-full" />
                        </div>
                        <Link href="/blog">
                            <Button variant="ghost" className="text-accent-foreground font-black uppercase tracking-widest text-[10px] items-center gap-2 hover:bg-accent">
                                {blogViewAll} <ChevronRight className="h-4 w-4" />
                            </Button>
                        </Link>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12 px-8">
                        {latestArticles?.map((post) => (
                            <Link key={post._id} href={`/blog/${post.slug}`}>
                                <BlogCard
                                    date={formatArticleDate(post.publishedAt)}
                                    title={post.title}
                                    image={post.coverImage?.url ?? ""}
                                />
                            </Link>
                        ))}
                    </div>
                </section>
            )}
        </div>
    )
}
