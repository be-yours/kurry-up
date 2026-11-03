"use client"

import React, { useState, useRef } from "react"
import {
    Send,
    MapPin,
    Phone,
    Mail,
    Clock,
    CheckCircle2,
    MessageSquare,
} from "lucide-react"
import { motion } from "framer-motion"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Button, Badge } from "@be-yours/ui"
import { useCmsPage } from "@/lib/cms/useCmsPage"
import type { CmsInitialData } from "@/lib/cms/page-data"
import { parseColoredText } from "@/lib/parse-colored-text"
import { useStoreId } from "@/lib/hooks/use-store-id"
import {
    formatStoreAddressLines,
    formatWeeklyHours,
    resolveStoreHours,
} from "@be-yours/restaurant"
import type { Id } from "@/convex/_generated/dataModel"
import { toast } from "sonner"
import { recordSignal } from "@be-yours/restaurant"

export default function ContactPage({ initialData }: { initialData?: CmsInitialData | null }) {
    // `initialData` is the page as the server read it, so the first HTML says
    // what the owner wrote instead of the sample copy below.
    const { block } = useCmsPage("contact", { initialData })
    const { storeId } = useStoreId()

    const store = useQuery(
        api.stores.getById,
        storeId ? { id: storeId as Id<"stores"> } : "skip"
    )

    // The week this page PUBLISHES has to be the week the order path ENFORCES.
    // It called `resolveStoreHours(store)` with no second argument, so a
    // location following the deployment-wide week printed its own stale one —
    // and the contact page is where a diner goes to find out when to turn up.
    const globalSettings = useQuery(api.globalSettings.get)

    const hero = block("hero")
    const form = block("form")
    const info = block("info")
    const responseTime = block("responseTime")

    // Hero
    const heroBadge = hero.field("badge").text ?? "Contactez-nous"
    const heroTitle = hero.field("title").text ?? "On est là pour {vous}"
    const heroSubtitle = hero.field("subtitle").text ?? "Une question, une suggestion ou un commentaire ? N'hésitez pas à nous contacter, notre équipe vous répondra dans les plus brefs délais."

    // Form
    const formHeading = form.field("heading").text ?? "Envoyez-nous un message"
    // No delay in the fallback. « … nous vous répondrons sous 24h » was printed
    // for every establishment, and a response time is a commitment the
    // establishment makes — not one a template makes for it. See `responseTime`.
    const formDesc = form.field("description").text ?? "Remplissez le formulaire ci-dessous pour nous écrire."
    const formSubmit = form.field("submitLabel").text ?? "Envoyer le message"

    // Info
    const infoAddress = info.field("addressTitle").text ?? "Adresse"
    const infoHours = info.field("hoursTitle").text ?? "Horaires"
    const infoContact = info.field("contactTitle").text ?? "Contact"

    // The response-time card. It has NO fallback: « Réponse rapide · Nous
    // répondons sous 24h en moyenne » was typed into this page and printed on
    // every site, an unverifiable commitment (the engine already dropped
    // « Délai estimé », « 10K+ clients satisfaits » and « Livraison Gratuite »
    // for the same reason). The owner who keeps one fills the block in.
    const responseTitle = responseTime.field("title").text?.trim() || null
    const responseText = responseTime.field("text").text?.trim() || null

    // `store` is `undefined` while the query is in flight and `null` when the
    // visitor has no store selected. Both mean "nothing to show yet", and the
    // card renders a skeleton rather than the invented address it used to:
    // a placeholder street on a real restaurant's contact page is a visitor
    // sent to the wrong door.
    const isLoadingStore = store === undefined
    const addressLines = store ? formatStoreAddressLines(store.address) : []
    const hoursRows = store ? formatWeeklyHours(resolveStoreHours(store, globalSettings)) : []

    const [submitted, setSubmitted] = useState(false)
    const [sending, setSending] = useState(false)
    const formRef = useRef<HTMLFormElement>(null)
    const createContactMessage = useMutation(api.contactMessages.create)

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (!storeId || sending) return
        setSending(true)
        try {
            const fd = new FormData(e.currentTarget)
            await createContactMessage({
                storeId: storeId as Id<"stores">,
                name: fd.get("name") as string,
                email: fd.get("email") as string,
                phone: (fd.get("phone") as string) || undefined,
                subject: fd.get("subject") as string,
                message: fd.get("message") as string,
            })
            setSubmitted(true)
            toast.success("Message envoyé avec succès !")
        } catch (err) {
            toast.error("Erreur lors de l'envoi. Veuillez réessayer.")
        } finally {
            setSending(false)
        }
    }

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

            {/* ─── CONTENT ─── */}
            <section className="py-16 md:py-24 px-6 md:px-12 max-w-7xl mx-auto -mt-12 relative z-20">
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
                    {/* Form card */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, delay: 0.2 }}
                        className="lg:col-span-3"
                    >
                        <div className="bg-card rounded-[2.5rem] p-8 md:p-12 shadow-2xl shadow-black/[0.04] border border-border">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="h-10 w-10 rounded-xl bg-primary/10 dark:bg-primary/30 flex items-center justify-center">
                                    <MessageSquare className="h-5 w-5 text-accent-foreground" />
                                </div>
                                <h2 className="text-2xl font-black tracking-tighter text-foreground">
                                    {formHeading}
                                </h2>
                            </div>
                            <p className="text-muted-foreground font-medium mb-8">
                                {formDesc}
                            </p>

                            {submitted ? (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    className="text-center py-16"
                                >
                                    <div className="h-20 w-20 rounded-[1.5rem] bg-accent flex items-center justify-center mx-auto mb-6">
                                        <CheckCircle2 className="h-10 w-10 text-success" />
                                    </div>
                                    <h3 className="text-3xl font-black tracking-tighter text-foreground mb-3">
                                        Message envoyé !
                                    </h3>
                                    <p className="text-muted-foreground font-medium max-w-md mx-auto">
                                        Merci pour votre message. Notre équipe vous répondra dans les plus brefs délais.
                                    </p>
                                    <Button
                                        onClick={() => setSubmitted(false)}
                                        variant="outline"
                                        className="mt-8 h-12 rounded-xl font-bold"
                                    >
                                        Envoyer un autre message
                                    </Button>
                                </motion.div>
                            ) : (
                                <form ref={formRef} onSubmit={handleSubmit} className="space-y-5">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                                        <div>
                                            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 block" htmlFor="contact-name">
                                                Nom complet
                                            </label>
                                            <input
                                                name="name"
                                                id="contact-name"
                                                type="text"
                                                required
                                                placeholder="Votre nom"
                                                className="w-full h-14 px-5 rounded-2xl bg-muted border border-border font-bold text-sm placeholder:text-muted-foreground outline-none focus:border-primary dark:focus:border-primary transition-colors"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 block" htmlFor="contact-email">
                                                Email
                                            </label>
                                            <input
                                                name="email"
                                                id="contact-email"
                                                type="email"
                                                required
                                                placeholder="votre@email.com"
                                                className="w-full h-14 px-5 rounded-2xl bg-muted border border-border font-bold text-sm placeholder:text-muted-foreground outline-none focus:border-primary dark:focus:border-primary transition-colors"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 block" htmlFor="contact-phone">
                                            Téléphone (optionnel)
                                        </label>
                                        <input
                                            name="phone"
                                            id="contact-phone"
                                            type="tel"
                                            placeholder="+33 6 00 00 00 00"
                                            className="w-full h-14 px-5 rounded-2xl bg-muted border border-border font-bold text-sm placeholder:text-muted-foreground outline-none focus:border-primary dark:focus:border-primary transition-colors"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 block" htmlFor="contact-subject">
                                            Sujet
                                        </label>
                                        <select
                                            name="subject"
                                            id="contact-subject"
                                            required
                                            className="w-full h-14 px-5 rounded-2xl bg-muted border border-border font-bold text-sm text-foreground outline-none focus:border-primary dark:focus:border-primary transition-colors appearance-none"
                                        >
                                            <option value="">Choisir un sujet...</option>
                                            <option value="order">Ma commande</option>
                                            <option value="feedback">Retour d&apos;expérience</option>
                                            <option value="partnership">Partenariat</option>
                                            <option value="press">Presse</option>
                                            <option value="other">Autre</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2 block" htmlFor="contact-message">
                                            Message
                                        </label>
                                        <textarea
                                            name="message"
                                            id="contact-message"
                                            required
                                            rows={5}
                                            placeholder="Comment pouvons-nous vous aider ?"
                                            className="w-full px-5 py-4 rounded-2xl bg-muted border border-border font-bold text-sm placeholder:text-muted-foreground outline-none focus:border-primary dark:focus:border-primary transition-colors resize-none"
                                        />
                                    </div>
                                    <Button
                                        type="submit"
                                        disabled={sending}
                                        className="h-16 w-full rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-black uppercase tracking-widest text-xs shadow-xl shadow-primary/10 transition-all group"
                                    >
                                        {sending ? (
                                            <span className="flex items-center gap-2">
                                                <span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                Envoi en cours...
                                            </span>
                                        ) : (
                                            <>
                                                {formSubmit}
                                                <Send className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                                            </>
                                        )}
                                    </Button>
                                </form>
                            )}
                        </div>
                    </motion.div>

                    {/* Info sidebar */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, delay: 0.4 }}
                        className="lg:col-span-2 space-y-6"
                    >
                        {/* Address */}
                        <div className="bg-card rounded-[2rem] p-8 shadow-lg shadow-black/[0.03] border border-border">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="h-10 w-10 rounded-xl bg-accent flex items-center justify-center">
                                    <MapPin className="h-5 w-5 text-accent-foreground" />
                                </div>
                                <h3 className="text-sm font-black uppercase tracking-widest text-foreground">
                                    {infoAddress}
                                </h3>
                            </div>
                            {isLoadingStore ? (
                                <div className="space-y-2" aria-hidden="true">
                                    <div className="h-4 w-3/4 rounded-full bg-muted animate-pulse" />
                                    <div className="h-4 w-1/2 rounded-full bg-muted animate-pulse" />
                                </div>
                            ) : addressLines.length > 0 ? (
                                <address className="not-italic text-muted-foreground font-medium leading-relaxed">
                                    {addressLines.map((line, i) => (
                                        <React.Fragment key={line}>
                                            {i > 0 && <br />}
                                            {line}
                                        </React.Fragment>
                                    ))}
                                </address>
                            ) : (
                                <p className="text-muted-foreground font-medium leading-relaxed">
                                    Adresse bientôt disponible.
                                </p>
                            )}
                        </div>

                        {/* Hours */}
                        <div className="bg-card rounded-[2rem] p-8 shadow-lg shadow-black/[0.03] border border-border">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="h-10 w-10 rounded-xl bg-accent flex items-center justify-center">
                                    <Clock className="h-5 w-5 text-accent-foreground" />
                                </div>
                                <h3 className="text-sm font-black uppercase tracking-widest text-foreground">
                                    {infoHours}
                                </h3>
                            </div>
                            {isLoadingStore ? (
                                <div className="space-y-2" aria-hidden="true">
                                    <div className="h-4 w-full rounded-full bg-muted animate-pulse" />
                                    <div className="h-4 w-full rounded-full bg-muted animate-pulse" />
                                </div>
                            ) : hoursRows.length > 0 ? (
                                <dl className="space-y-2">
                                    {hoursRows.map((row) => (
                                        <div key={row.days} className="flex items-center justify-between gap-4">
                                            <dt className="text-sm font-bold text-muted-foreground">{row.days}</dt>
                                            <dd className="text-sm font-black text-foreground">{row.hours}</dd>
                                        </div>
                                    ))}
                                </dl>
                            ) : (
                                <p className="text-sm font-medium text-muted-foreground">
                                    Horaires bientôt disponibles.
                                </p>
                            )}
                        </div>

                        {/* Contact */}
                        <div className="bg-card rounded-[2rem] p-8 shadow-lg shadow-black/[0.03] border border-border">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="h-10 w-10 rounded-xl bg-info/10 flex items-center justify-center">
                                    <Phone className="h-5 w-5 text-info" />
                                </div>
                                <h3 className="text-sm font-black uppercase tracking-widest text-foreground">
                                    {infoContact}
                                </h3>
                            </div>
                            <div className="space-y-3">
                                {isLoadingStore ? (
                                    <div className="space-y-3" aria-hidden="true">
                                        <div className="h-4 w-2/3 rounded-full bg-muted animate-pulse" />
                                        <div className="h-4 w-3/4 rounded-full bg-muted animate-pulse" />
                                    </div>
                                ) : (
                                    <>
                                        {store?.phone && (
                                            <a
                                                href={`tel:${store.phone.replace(/\s+/g, "")}`}
                                                // A booking this site will never
                                                // see otherwise: the diner rings,
                                                // eats, and no row is ever
                                                // written. Counted, never
                                                // identified.
                                                onClick={() => recordSignal("call")}
                                                className="flex items-center gap-3 text-muted-foreground hover:text-accent-foreground dark:hover:text-accent-foreground transition-colors group"
                                            >
                                                <Phone className="h-4 w-4" />
                                                <span className="font-bold text-sm group-hover:underline">
                                                    {store.phone}
                                                </span>
                                            </a>
                                        )}
                                        {store?.email && (
                                            <a
                                                href={`mailto:${store.email}`}
                                                className="flex items-center gap-3 text-muted-foreground hover:text-accent-foreground dark:hover:text-accent-foreground transition-colors group"
                                            >
                                                <Mail className="h-4 w-4" />
                                                <span className="font-bold text-sm group-hover:underline">
                                                    {store.email}
                                                </span>
                                            </a>
                                        )}
                                        {!store?.phone && !store?.email && (
                                            <p className="text-sm font-medium text-muted-foreground">
                                                Écrivez-nous avec le formulaire, on vous répond vite.
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Response-time card — drawn only when the owner wrote one
                            (« Engagement de réponse » in the CMS). */}
                        {(responseTitle || responseText) && (
                            <div className="bg-primary rounded-[2rem] p-8 text-center relative overflow-hidden">
                                <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-3xl -mr-16 -mt-16" />
                                <div className="relative z-10">
                                    <div className="h-14 w-14 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center mx-auto mb-4">
                                        <Clock className="h-6 w-6 text-primary-foreground" />
                                    </div>
                                    {responseTitle && (
                                        <p className="text-primary-foreground font-black text-lg tracking-tight mb-1">
                                            {responseTitle}
                                        </p>
                                    )}
                                    {responseText && (
                                        <p className="text-primary-foreground text-sm font-medium">
                                            {responseText}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                    </motion.div>
                </div>
            </section>
        </div>
    )
}
