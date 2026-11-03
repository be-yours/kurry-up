"use client"

import { useState } from "react"
import { useMutation, useQuery } from "convex/react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { motion } from "framer-motion"
import { KeyRound, Loader2, ShieldCheck, ArrowRight, AlertTriangle } from "lucide-react"
import { Button, Input, Label } from "@be-yours/ui"
import { api } from "@/convex/_generated/api"
import { authClient } from "@/lib/auth-client"
import { convexErrorMessage } from "@/lib/convex-error"

/** The refusals `claimFirstAdmin` can return, in the operator's language. */
const BOOTSTRAP_ERRORS: Record<string, string> = {
  not_authenticated: "Connectez-vous avant de réclamer le siège.",
  bootstrap_not_configured:
    "L'amorçage n'est pas configuré sur ce déploiement. Posez ADMIN_BOOTSTRAP_TOKEN sur le backend Convex.",
  bootstrap_token_invalid: "Jeton d'amorçage invalide.",
  bootstrap_already_claimed: "Un administrateur a déjà été désigné.",
}

/**
 * Appoint the first administrator of a fresh deployment.
 *
 * `claimFirstAdmin` existed and had no caller. Provisioning a profile requires
 * a super admin and a new deployment has none, so the seat could only be taken
 * by writing to the database by hand — while `getAuthUser` threw
 * "User profile not found" on every admin screen. That is what made the whole
 * back office unreachable on a deployment nobody had hand-seeded.
 *
 * The mutation is guarded twice and this page cannot loosen either: it needs a
 * session, and it needs `ADMIN_BOOTSTRAP_TOKEN` — a value only whoever deployed
 * the backend holds. It is also self-closing, so this screen turns itself off
 * the moment the seat is taken.
 */
export default function SetupPage() {
  const router = useRouter()
  const { data: session, isPending: sessionPending } = authClient.useSession()
  const status = useQuery(api.userProfiles.bootstrapStatus)
  const claimFirstAdmin = useMutation(api.userProfiles.claimFirstAdmin)

  const [token, setToken] = useState("")
  const [claiming, setClaiming] = useState(false)

  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return

    setClaiming(true)
    try {
      await claimFirstAdmin({ bootstrapToken: token.trim() })
      toast.success("Vous êtes administrateur de ce déploiement")
      router.push("/dashboard")
    } catch (error: unknown) {
      // `claimFirstAdmin` throws ConvexError, whose `data` survives the
      // redaction Convex applies to a plain thrown message in production.
      // Reading a `code` rather than sniffing the message is the difference
      // between "jeton invalide" and a guess: both refusals mention
      // "amorçage", so a substring test got the reason wrong.
      toast.error(
        convexErrorMessage(
          error,
          BOOTSTRAP_ERRORS,
          "L'attribution a échoué. Réessayez ou consultez les journaux Convex."
        )
      )
    } finally {
      setClaiming(false)
    }
  }

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
            Premier <span className="text-accent-solid not-italic">administrateur</span>
          </h1>
        </div>

        <div className="rounded-[3rem] border border-border bg-card text-card-foreground p-8 md:p-12 shadow-2xl shadow-primary/5">
          {status === undefined || sessionPending ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : status.claimed ? (
            <div className="space-y-5 text-center" data-testid="setup-claimed">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                <ShieldCheck className="h-7 w-7" />
              </div>
              <h2 className="text-xl font-black tracking-tight">Déploiement déjà configuré</h2>
              <p className="text-muted-foreground leading-relaxed">
                Un administrateur a été désigné. Cette page ne sert plus à rien —
                demandez-lui une invitation depuis l&apos;écran Équipe.
              </p>
              <Button asChild className="h-14 w-full rounded-2xl bg-primary text-primary-foreground hover:bg-primary-hover font-black uppercase tracking-widest text-xs">
                <Link href="/dashboard">Aller au dashboard</Link>
              </Button>
            </div>
          ) : !status.configured ? (
            <div className="space-y-5" data-testid="setup-unconfigured">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-warning text-warning-foreground">
                <AlertTriangle className="h-7 w-7" />
              </div>
              <h2 className="text-xl font-black tracking-tight text-center">
                Amorçage non configuré
              </h2>
              <p className="text-muted-foreground leading-relaxed text-center">
                Ce déploiement n&apos;a pas de jeton d&apos;amorçage, donc personne
                ne peut devenir administrateur — y compris par erreur. C&apos;est
                voulu : la commande ci-dessous est réservée à qui a déployé le
                backend.
              </p>
              <pre className="overflow-x-auto rounded-2xl bg-foreground px-5 py-4 text-xs leading-relaxed text-background">
{`npx convex env set ADMIN_BOOTSTRAP_TOKEN "$(openssl rand -base64 32)"
npx convex env get ADMIN_BOOTSTRAP_TOKEN`}
              </pre>
              <p className="text-center text-xs text-muted-foreground">
                Rechargez cette page une fois la variable posée.
              </p>
            </div>
          ) : !session ? (
            <div className="space-y-5 text-center" data-testid="setup-signin-required">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <KeyRound className="h-7 w-7" />
              </div>
              <h2 className="text-xl font-black tracking-tight">Connectez-vous d&apos;abord</h2>
              <p className="text-muted-foreground leading-relaxed">
                Le siège d&apos;administrateur est attribué à un compte, pas à un
                jeton. Créez le vôtre, confirmez votre adresse, puis revenez ici.
              </p>
              <div className="space-y-3">
                <Button asChild className="h-14 w-full rounded-2xl bg-primary text-primary-foreground hover:bg-primary-hover font-black uppercase tracking-widest text-xs">
                  <Link href="/sign-in?redirect=%2Fsetup">Se connecter</Link>
                </Button>
                <Link
                  href="/sign-up?redirect=%2Fsetup"
                  className="block text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-card-foreground"
                >
                  Créer un compte
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleClaim} className="space-y-6" data-testid="setup-form">
              <p className="text-muted-foreground leading-relaxed">
                Vous êtes connecté en tant que{" "}
                <span className="font-black text-card-foreground">{session.user.email}</span>.
                Collez le jeton d&apos;amorçage pour attribuer le siège
                d&apos;administrateur à ce compte.
              </p>

              <div className="space-y-3">
                <Label
                  htmlFor="bootstrap-token"
                  className="ml-1 text-[10px] font-black uppercase tracking-widest text-card-foreground"
                >
                  Jeton d&apos;amorçage
                </Label>
                <div className="relative group">
                  <KeyRound className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary-ink transition-colors" />
                  <Input
                    id="bootstrap-token"
                    name="bootstrap-token"
                    type="password"
                    autoComplete="off"
                    className="h-14 rounded-2xl border-border bg-muted pl-12 pr-4 font-bold text-card-foreground placeholder:text-muted-foreground focus:bg-card"
                    placeholder="ADMIN_BOOTSTRAP_TOKEN"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                  />
                </div>
              </div>

              <Button
                type="submit"
                disabled={claiming}
                className="group h-16 w-full rounded-2xl bg-accent-solid text-xs font-black uppercase tracking-widest text-accent-solid-foreground shadow-xl shadow-accent-solid/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60"
              >
                {claiming ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="sr-only">Attribution en cours...</span>
                  </>
                ) : (
                  <>
                    Devenir administrateur
                    <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </>
                )}
              </Button>
            </form>
          )}
        </div>
      </motion.div>
    </div>
  )
}
