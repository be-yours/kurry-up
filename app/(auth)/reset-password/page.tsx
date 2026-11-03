"use client"

import { Suspense, useState } from "react"
import { authClient } from "@/lib/auth-client"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { motion } from "framer-motion"
import {
  Lock,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  AlertTriangle,
} from "lucide-react"
import { Button, Input, Label, Skeleton } from "@be-yours/ui"

function ResetPasswordSkeleton() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <div className="w-full max-w-xl">
        <Skeleton className="h-20 w-64 mx-auto mb-12 rounded-2xl" />
        <div className="bg-card text-card-foreground rounded-[3rem] p-12 shadow-2xl border border-border">
          <div className="space-y-6">
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-14 w-full rounded-2xl" />
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-14 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ResetPasswordContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token")

  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (password !== confirmPassword) {
      toast.error("Les mots de passe ne correspondent pas")
      return
    }

    if (password.length < 12) {
      toast.error("Le mot de passe doit contenir au moins 12 caractères")
      return
    }

    if (!token) return

    setLoading(true)
    try {
      const result = await authClient.resetPassword({
        newPassword: password,
        token,
      })

      if (result.error) {
        toast.error(result.error.message ?? "Erreur lors de la réinitialisation")
      } else {
        setSuccess(true)
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
        href="/sign-in"
        className="absolute top-8 left-8 flex items-center gap-2 text-primary-ink font-black uppercase tracking-widest text-[10px] hover:translate-x-[-4px] transition-transform z-20"
      >
        <ArrowLeft className="h-4 w-4" /> Connexion
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
            Nouveau <br />
            <span className="text-accent-solid not-italic">mot de passe</span>
          </h1>
        </div>

        {/* Card */}
        <div className="bg-card text-card-foreground rounded-[3rem] shadow-2xl shadow-primary/5 border border-border overflow-hidden">
          <div className="p-8 md:p-12">
            {!token ? (
              /* Invalid/expired link */
              <div className="text-center py-8">
                <div className="flex justify-center mb-6">
                  <div className="h-20 w-20 rounded-[2rem] bg-destructive text-destructive-foreground flex items-center justify-center">
                    <AlertTriangle className="h-10 w-10" />
                  </div>
                </div>
                <h2 className="text-2xl font-black tracking-tighter text-card-foreground mb-3">
                  Lien invalide
                </h2>
                <p className="text-muted-foreground font-medium mb-8">
                  Ce lien de réinitialisation est invalide ou a expiré.
                </p>
                <Link href="/forgot-password">
                  <Button className="rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-black uppercase tracking-widest text-xs h-14 px-8">
                    Demander un nouveau lien
                  </Button>
                </Link>
              </div>
            ) : success ? (
              /* Success state */
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center py-8"
              >
                <div className="flex justify-center mb-6">
                  <div className="h-20 w-20 rounded-[2rem] bg-accent text-accent-foreground flex items-center justify-center">
                    <CheckCircle2 className="h-10 w-10" />
                  </div>
                </div>
                <h2 className="text-2xl font-black tracking-tighter text-card-foreground mb-3">
                  Mot de passe modifié !
                </h2>
                <p className="text-muted-foreground font-medium mb-8">
                  Votre mot de passe a été réinitialisé avec succès.
                </p>
                <Button
                  onClick={() => router.push("/sign-in")}
                  className="rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-black uppercase tracking-widest text-xs h-14 px-8 group"
                >
                  Se connecter
                  <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                </Button>
              </motion.div>
            ) : (
              /* Form */
              <form onSubmit={handleSubmit} className="space-y-8">
                <div className="space-y-3">
                  <Label
                    htmlFor="password"
                    className="text-card-foreground font-black uppercase tracking-widest text-[10px] ml-1"
                  >
                    Nouveau mot de passe
                  </Label>
                  <div className="relative group">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground group-focus-within:text-primary-ink transition-colors" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      className="h-16 pl-12 pr-12 rounded-2xl border-border bg-muted focus:bg-card transition-all text-card-foreground font-bold placeholder:text-muted-foreground focus:ring-4 focus-visible:ring-ring focus:border-primary/20"
                      placeholder="Min. 12 caractères"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={12}
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

                <div className="space-y-3">
                  <Label
                    htmlFor="confirm"
                    className="text-card-foreground font-black uppercase tracking-widest text-[10px] ml-1"
                  >
                    Confirmer le mot de passe
                  </Label>
                  <div className="relative group">
                    <CheckCircle2 className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground group-focus-within:text-primary-ink transition-colors" />
                    <Input
                      id="confirm"
                      type={showPassword ? "text" : "password"}
                      className="h-16 pl-12 pr-4 rounded-2xl border-border bg-muted focus:bg-card transition-all text-card-foreground font-bold placeholder:text-muted-foreground focus:ring-4 focus-visible:ring-ring focus:border-primary/20"
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={12}
                    />
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-16 rounded-2xl bg-primary hover:bg-primary-hover text-primary-foreground font-black uppercase tracking-widest text-xs shadow-xl shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98] group disabled:opacity-60"
                >
                  {loading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      Réinitialiser
                      <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />
                    </>
                  )}
                </Button>
              </form>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<ResetPasswordSkeleton />}>
      <ResetPasswordContent />
    </Suspense>
  )
}
