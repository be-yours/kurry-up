"use client"

import { Suspense, useState } from "react"
import { authClient } from "@/lib/auth-client"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { motion } from "framer-motion"
import { Mail, Lock, ArrowLeft, ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react"
import { Button, Input, Label } from "@be-yours/ui"

/**
 * Where to land after authenticating.
 *
 * Read from `?redirect=`, and deliberately restricted to a path on this site:
 * an absolute URL here would turn either auth page into an open redirect, and
 * these are exactly the two pages a phishing link wants to borrow. A protocol-
 * relative `//evil.example` is a URL to a browser and a path to a naive check,
 * so it is refused as well.
 */
function safeRedirect(raw: string | null): string {
  if (!raw) return "/menu"
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/menu"
  return raw
}

function SignInForm() {
  const router = useRouter()
  const redirectTo = safeRedirect(useSearchParams().get("redirect"))
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  /** Set when the server refused because the address is not confirmed yet. */
  const [unverified, setUnverified] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      const result = await authClient.signIn.email({
        email,
        password,
      })

      if (result.error) {
        // A 403 EMAIL_NOT_VERIFIED is not a wrong password, and telling
        // somebody their credentials failed when the account is simply
        // unconfirmed sends them to reset a password that was never the
        // problem. The server has just re-sent the link (`sendOnSignIn`), so
        // say where to look.
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          setUnverified(true)
          toast.error("Confirmez votre adresse email pour vous connecter")
        } else {
          toast.error(result.error.message ?? "Échec de la connexion")
        }
      } else {
        toast.success("Connexion réussie !")
        router.push(redirectTo)
      }
    } catch {
      toast.error("Une erreur inattendue est survenue")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans overflow-hidden relative flex flex-col items-center justify-center px-6">
      {/* Background blobs */}
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] right-[-10%] w-[600px] h-[600px] bg-primary/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[400px] h-[400px] bg-accent-solid/10 rounded-full blur-[100px]" />
      </div>

      {/* Back link */}
      <Link
        href="/"
        className="absolute top-8 left-8 flex items-center gap-2 text-primary-ink font-black uppercase tracking-widest text-[10px] hover:translate-x-[-4px] transition-transform z-20"
      >
        <ArrowLeft className="h-4 w-4" /> Retour
      </Link>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="relative z-10 w-full max-w-xl"
      >
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl md:text-6xl font-black text-foreground tracking-tighter leading-[0.9] italic">
            Bon retour <br />
            <span className="text-accent-solid not-italic">parmi nous</span>
          </h1>
        </div>

        {/* Form card */}
        <div className="bg-card text-card-foreground rounded-[3rem] shadow-2xl shadow-primary/5 border border-border overflow-hidden">
          <div className="p-8 md:p-12">
            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Email */}
              <div className="space-y-3">
                <Label
                  htmlFor="email"
                  className="text-card-foreground font-black uppercase tracking-widest text-[10px] ml-1"
                >
                  Adresse email
                </Label>
                <div className="relative group">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground group-focus-within:text-primary-ink transition-colors" />
                  <Input
                    id="email"
                    type="email"
                    className="h-16 pl-12 pr-4 rounded-2xl border-border bg-muted focus:bg-card transition-all text-card-foreground font-bold placeholder:text-muted-foreground focus:ring-4 focus-visible:ring-ring focus:border-primary/20"
                    placeholder="jean@exemple.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              </div>

              {/* Password */}
              <div className="space-y-3">
                <div className="flex justify-between items-center px-1">
                  <Label
                    htmlFor="password"
                    className="text-card-foreground font-black uppercase tracking-widest text-[10px]"
                  >
                    Mot de passe
                  </Label>
                  <Link
                    href="/forgot-password"
                    className="text-[10px] text-accent-solid font-black uppercase tracking-widest hover:underline underline-offset-4"
                  >
                    Mot de passe oublié ?
                  </Link>
                </div>
                <div className="relative group">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground group-focus-within:text-primary-ink transition-colors" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    className="h-16 pl-12 pr-12 rounded-2xl border-border bg-muted focus:bg-card transition-all text-card-foreground font-bold placeholder:text-muted-foreground focus:ring-4 focus-visible:ring-ring focus:border-primary/20"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-card-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="h-5 w-5" />
                    ) : (
                      <Eye className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>

              {unverified && (
                <div
                  data-testid="unverified-notice"
                  role="status"
                  className="rounded-2xl border border-warning bg-warning/10 px-5 py-4 text-sm text-card-foreground"
                >
                  Cette adresse n&apos;est pas encore confirmée. Nous venons de
                  vous renvoyer le lien de confirmation — vérifiez votre boîte
                  mail, et vos spams.
                </div>
              )}

              {/* Submit */}
              <div className="space-y-4 pt-2">
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-16 rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-black uppercase tracking-widest text-xs shadow-xl shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98] group disabled:opacity-60"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      {/*
                        A spinner alone leaves the button with no accessible
                        name: assistive technology announces "button" and
                        nothing else, exactly when the user most wants to know
                        what is happening.
                      */}
                      <span className="sr-only">Connexion en cours...</span>
                    </>
                  ) : (
                    <>
                      Se connecter
                      <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>

        {/* Footer link */}
        <p className="text-center mt-12 text-muted-foreground font-medium">
          Pas encore de compte ?{" "}
          <Link
            href={`/sign-up?redirect=${encodeURIComponent(redirectTo)}`}
            className="text-primary-ink font-black hover:underline underline-offset-4"
          >
            Créer un compte
          </Link>
        </p>
      </motion.div>
    </div>
  )
}


/**
 * `useSearchParams` forces this tree to render on the client, and Next refuses
 * to prerender the route without a boundary to fall back to. The skeleton is
 * the page's own frame, so the transition is a fill rather than a flash.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={<AuthPageFallback />}>
      <SignInForm />
    </Suspense>
  )
}

/** The page frame, shown while the client half of the route hydrates. */
function AuthPageFallback() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <div className="w-full max-w-xl rounded-[3rem] border border-border bg-card p-12 shadow-2xl shadow-primary/5">
        <div className="h-6 w-40 animate-pulse rounded-full bg-muted" />
        <div className="mt-8 space-y-4">
          <div className="h-14 animate-pulse rounded-2xl bg-muted" />
          <div className="h-14 animate-pulse rounded-2xl bg-muted" />
          <div className="h-16 animate-pulse rounded-2xl bg-muted" />
        </div>
      </div>
    </div>
  )
}
