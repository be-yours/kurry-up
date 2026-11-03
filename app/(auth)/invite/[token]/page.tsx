"use client"

import { use, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { motion } from "framer-motion"
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarX,
  Loader2,
  LogIn,
  SearchX,
} from "lucide-react"
import { Button } from "@be-yours/ui"
import { api } from "@/convex/_generated/api"
import { authClient } from "@/lib/auth-client"
import { convexErrorMessage } from "@/lib/convex-error"

/** What the team screen calls each role, so the invitee reads the same word. */
const ROLE_LABELS: Record<string, string> = {
  manager: "Manager",
  kitchen: "Cuisine",
  waiter: "Serveur",
  delivery: "Livreur",
}

/** The refusals `acceptInvitation` can return, as ConvexError `data.code`. */
const ACCEPT_ERRORS: Record<string, string> = {
  not_authenticated: "Connectez-vous pour accepter cette invitation.",
  not_found: "Cette invitation n'existe plus.",
  invitation_expired: "Cette invitation a expiré.",
  invitation_not_pending: "Cette invitation a déjà été acceptée.",
}

/**
 * A pending invitation, with the fields the offer needs proved to be present.
 *
 * The server pins this shape with a `returns` validator, but the type Convex
 * generates for a union-returning query flattens the arms into one object with
 * optional properties — so `status === "pending"` narrows nothing, and
 * `invitation.email` stays `string | undefined` in the branch that cannot
 * receive anything else. This checks at runtime instead of asserting: a cast
 * here would be a claim about the server that this file cannot see.
 */
interface PendingInvitation {
  name: string
  email: string
  role: string
  allStores: boolean
  storeName: string | null
}

function asPendingInvitation(value: {
  status: string
  name?: string
  email?: string
  role?: string
  allStores?: boolean
  storeName?: string | null
}): PendingInvitation | null {
  if (value.status !== "pending") return null
  if (typeof value.email !== "string" || typeof value.role !== "string") return null
  return {
    name: value.name ?? value.email,
    email: value.email,
    role: value.role,
    allStores: value.allStores === true,
    storeName: value.storeName ?? null,
  }
}

/**
 * Accept a team invitation.
 *
 * The invitation email has always linked to `/invite/<token>` and this route did
 * not exist, so every invitation ended on a 404. `acceptInvitation` is the only
 * thing that writes `userProfiles` — the record the authorisation chain actually
 * reads — so until someone reached it, an invited manager was a row on a roster
 * with no rights at all. The whole team feature was decorative from the outside.
 */
export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = use(params)
  const router = useRouter()
  const { data: session, isPending: sessionPending } = authClient.useSession()

  const invitation = useQuery(api.teamMembers.getInvitationPreview, { token })
  const acceptInvitation = useMutation(api.teamMembers.acceptInvitation)

  const [accepting, setAccepting] = useState(false)

  const offer = invitation ? asPendingInvitation(invitation) : null

  const handleAccept = async () => {
    setAccepting(true)
    try {
      await acceptInvitation({ token })
      toast.success("Invitation acceptée")
      router.push("/dashboard")
    } catch (error: unknown) {
      toast.error(
        convexErrorMessage(
          error,
          ACCEPT_ERRORS,
          "L'acceptation a échoué. Réessayez dans un instant."
        )
      )
    } finally {
      setAccepting(false)
    }
  }

  const signInHref = `/sign-in?redirect=${encodeURIComponent(`/invite/${token}`)}`
  const signUpHref = `/sign-up?redirect=${encodeURIComponent(`/invite/${token}`)}`

  return (
    <div className="min-h-screen bg-background text-foreground font-sans flex items-center justify-center px-6 py-20">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-xl"
      >
        <div className="text-center mb-10">
          <h1 className="text-4xl md:text-5xl font-black tracking-tighter leading-[0.95] text-foreground italic">
            Rejoindre <span className="text-accent-solid not-italic">l&apos;équipe</span>
          </h1>
        </div>

        <div className="rounded-[3rem] border border-border bg-card text-card-foreground p-8 md:p-12 shadow-2xl shadow-primary/5">
          {invitation === undefined || sessionPending ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : invitation.status === "not_found" ? (
            <InviteNotice
              testId="invite-not-found"
              icon={<SearchX className="h-7 w-7" />}
              tone="neutral"
              title="Invitation introuvable"
              body="Ce lien ne correspond à aucune invitation. Il a peut-être déjà
              été utilisé, ou remplacé par un lien plus récent — demandez à la
              personne qui vous a invité de le renvoyer."
            />
          ) : invitation.status === "invitation_expired" ? (
            <InviteNotice
              testId="invite-expired"
              icon={<CalendarX className="h-7 w-7" />}
              tone="warning"
              title="Invitation expirée"
              body="Les invitations sont valables sept jours. Demandez un
              nouveau lien depuis l'écran Équipe — l'ancien ne fonctionnera
              plus."
            />
          ) : invitation.status === "invitation_not_pending" ? (
            <InviteNotice
              testId="invite-already-accepted"
              icon={<BadgeCheck className="h-7 w-7" />}
              tone="success"
              title="Invitation déjà acceptée"
              body="Ce poste vous a déjà été attribué. Connectez-vous pour
              rejoindre le tableau de bord."
              action={
                <Button
                  asChild
                  className="h-14 w-full rounded-2xl bg-primary text-primary-foreground text-xs font-black uppercase tracking-widest hover:bg-primary-hover"
                >
                  <Link href={session ? "/dashboard" : signInHref}>
                    {session ? "Aller au dashboard" : "Se connecter"}
                  </Link>
                </Button>
              }
            />
          ) : offer === null ? (
            // `getInvitationPreview` answers with one of four statuses and the
            // three above are handled; this is the shape check failing, which
            // means the deployment answered something this build does not know.
            <InviteNotice
              testId="invite-unreadable"
              icon={<SearchX className="h-7 w-7" />}
              tone="neutral"
              title="Invitation illisible"
              body="Cette invitation n'a pas pu être lue. Demandez à la personne
              qui vous a invité de renvoyer le lien."
            />
          ) : (
            <div className="space-y-7" data-testid="invite-pending">
              <div className="space-y-4 rounded-3xl bg-muted text-card-foreground p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-background">
                    <Building2 className="h-5 w-5 text-primary-ink" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      Établissement
                    </p>
                    <p className="truncate text-lg font-black text-card-foreground">
                      {offer.allStores
                        ? "Tous les établissements"
                        : (offer.storeName ?? "Établissement")}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-background">
                    <BadgeCheck className="h-5 w-5 text-accent-solid" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      Rôle
                    </p>
                    <p className="text-lg font-black text-card-foreground">
                      {ROLE_LABELS[offer.role] ?? offer.role}
                    </p>
                  </div>
                </div>
              </div>

              {session ? (
                <>
                  <p className="text-center text-sm text-muted-foreground leading-relaxed">
                    Le poste sera attribué à{" "}
                    <span className="font-black text-card-foreground">
                      {session.user.email}
                    </span>
                    .{" "}
                    {session.user.email?.toLowerCase() !==
                      offer.email.toLowerCase() && (
                      <>
                        L&apos;invitation a été envoyée à{" "}
                        <span className="font-black text-card-foreground">
                          {offer.email}
                        </span>{" "}
                        — connectez-vous avec ce compte si ce n&apos;est pas le
                        vôtre.
                      </>
                    )}
                  </p>
                  <Button
                    type="button"
                    onClick={handleAccept}
                    disabled={accepting}
                    data-testid="accept-invitation"
                    className="group h-16 w-full rounded-2xl bg-accent-solid text-xs font-black uppercase tracking-widest text-accent-solid-foreground shadow-xl shadow-accent-solid/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60"
                  >
                    {accepting ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span className="sr-only">Acceptation en cours...</span>
                      </>
                    ) : (
                      <>
                        Accepter l&apos;invitation
                        <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                      </>
                    )}
                  </Button>
                </>
              ) : (
                <div className="space-y-4" data-testid="invite-signin-required">
                  <p className="text-center text-sm leading-relaxed text-muted-foreground">
                    Le poste est attribué à un compte. Connectez-vous — ou créez
                    votre compte avec{" "}
                    <span className="font-black text-card-foreground">
                      {offer.email}
                    </span>{" "}
                    — et vous reviendrez ici.
                  </p>
                  <Button
                    asChild
                    className="h-14 w-full rounded-2xl bg-primary text-primary-foreground text-xs font-black uppercase tracking-widest hover:bg-primary-hover"
                  >
                    <Link href={signInHref}>
                      <LogIn className="mr-2 h-4 w-4" />
                      Se connecter
                    </Link>
                  </Button>
                  <Link
                    href={signUpHref}
                    className="block text-center text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-card-foreground"
                  >
                    Créer un compte
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}

/**
 * The three dead ends share a shape; only the words, the icon and the tone
 * differ.
 *
 * The tone carries the ink as well as the fill, and the icons above are handed
 * in WITHOUT a colour of their own so they inherit it. Written the other way —
 * a colour on the icon, at the call site — the two would be resolved against
 * different surfaces: the icon's is this badge, but the call site's is the
 * card, and a green that reads on `--accent` is not the green that reads on
 * `--card` once dark mode inverts one of them.
 */
function InviteNotice({
  testId,
  icon,
  tone,
  title,
  body,
  action,
}: {
  testId: string
  icon: React.ReactNode
  tone: "neutral" | "warning" | "success"
  title: string
  body: string
  action?: React.ReactNode
}) {
  const toneClass =
    tone === "warning"
      ? "bg-warning text-warning-foreground"
      : tone === "success"
        ? "bg-accent text-accent-foreground"
        : "bg-muted text-muted-foreground"

  return (
    <div className="space-y-5 text-center" data-testid={testId}>
      <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ${toneClass}`}>
        {icon}
      </div>
      <h2 className="text-xl font-black tracking-tight">{title}</h2>
      <p className="text-muted-foreground leading-relaxed">{body}</p>
      {action}
    </div>
  )
}
