"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@be-yours/convex-functions/userProfiles"
import {
  Package,
  MapPin,
  Heart,
  LogOut,
  Loader2,
  ChevronRight,
  Camera,
  Phone,
  Globe,
  Plus,
  Trash2,
} from "lucide-react"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Input,
  Label,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@be-yours/ui"
import { authClient } from "@/lib/auth-client"

// === Types ===

type PhoneEntry = { label: string; countryCode: string; number: string }

// === Constants ===

const PHONE_LABELS = ["Personnel", "Travail", "Autre"]

const COUNTRY_CODES = [
  { code: "+33", flag: "🇫🇷", country: "France" },
  { code: "+32", flag: "🇧🇪", country: "Belgique" },
  { code: "+41", flag: "🇨🇭", country: "Suisse" },
  { code: "+352", flag: "🇱🇺", country: "Luxembourg" },
  { code: "+377", flag: "🇲🇨", country: "Monaco" },
  { code: "+1", flag: "🇺🇸", country: "États-Unis" },
  { code: "+1", flag: "🇨🇦", country: "Canada" },
  { code: "+44", flag: "🇬🇧", country: "Royaume-Uni" },
  { code: "+49", flag: "🇩🇪", country: "Allemagne" },
  { code: "+34", flag: "🇪🇸", country: "Espagne" },
  { code: "+39", flag: "🇮🇹", country: "Italie" },
  { code: "+351", flag: "🇵🇹", country: "Portugal" },
  { code: "+31", flag: "🇳🇱", country: "Pays-Bas" },
  { code: "+46", flag: "🇸🇪", country: "Suède" },
  { code: "+47", flag: "🇳🇴", country: "Norvège" },
  { code: "+45", flag: "🇩🇰", country: "Danemark" },
  { code: "+358", flag: "🇫🇮", country: "Finlande" },
  { code: "+43", flag: "🇦🇹", country: "Autriche" },
  { code: "+48", flag: "🇵🇱", country: "Pologne" },
  { code: "+420", flag: "🇨🇿", country: "Tchéquie" },
  { code: "+30", flag: "🇬🇷", country: "Grèce" },
  { code: "+353", flag: "🇮🇪", country: "Irlande" },
  { code: "+36", flag: "🇭🇺", country: "Hongrie" },
  { code: "+40", flag: "🇷🇴", country: "Roumanie" },
  { code: "+359", flag: "🇧🇬", country: "Bulgarie" },
  { code: "+385", flag: "🇭🇷", country: "Croatie" },
  { code: "+90", flag: "🇹🇷", country: "Turquie" },
  { code: "+7", flag: "🇷🇺", country: "Russie" },
  { code: "+380", flag: "🇺🇦", country: "Ukraine" },
  { code: "+212", flag: "🇲🇦", country: "Maroc" },
  { code: "+213", flag: "🇩🇿", country: "Algérie" },
  { code: "+216", flag: "🇹🇳", country: "Tunisie" },
  { code: "+20", flag: "🇪🇬", country: "Égypte" },
  { code: "+221", flag: "🇸🇳", country: "Sénégal" },
  { code: "+225", flag: "🇨🇮", country: "Côte d'Ivoire" },
  { code: "+237", flag: "🇨🇲", country: "Cameroun" },
  { code: "+234", flag: "🇳🇬", country: "Nigeria" },
  { code: "+27", flag: "🇿🇦", country: "Afrique du Sud" },
  { code: "+242", flag: "🇨🇬", country: "Congo" },
  { code: "+243", flag: "🇨🇩", country: "RD Congo" },
  { code: "+961", flag: "🇱🇧", country: "Liban" },
  { code: "+966", flag: "🇸🇦", country: "Arabie Saoudite" },
  { code: "+971", flag: "🇦🇪", country: "Émirats" },
  { code: "+974", flag: "🇶🇦", country: "Qatar" },
  { code: "+91", flag: "🇮🇳", country: "Inde" },
  { code: "+86", flag: "🇨🇳", country: "Chine" },
  { code: "+81", flag: "🇯🇵", country: "Japon" },
  { code: "+82", flag: "🇰🇷", country: "Corée du Sud" },
  { code: "+55", flag: "🇧🇷", country: "Brésil" },
  { code: "+52", flag: "🇲🇽", country: "Mexique" },
  { code: "+54", flag: "🇦🇷", country: "Argentine" },
  { code: "+57", flag: "🇨🇴", country: "Colombie" },
  { code: "+61", flag: "🇦🇺", country: "Australie" },
  { code: "+64", flag: "🇳🇿", country: "Nouvelle-Zélande" },
] as const

const quickLinks = [
  {
    href: "/account/orders",
    icon: Package,
    label: "Mes commandes",
    description: "Historique et suivi",
    color: "bg-accent text-accent-foreground",
  },
  {
    href: "/account/addresses",
    icon: MapPin,
    label: "Mes adresses",
    description: "Adresses de livraison",
    color: "bg-accent text-accent-foreground",
  },
  {
    href: "/account/favorites",
    icon: Heart,
    label: "Mes favoris",
    description: "Vos plats préférés",
    color: "bg-destructive/10 text-destructive",
  },
]

const LANGUAGES = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ar", label: "العربية" },
  { code: "tr", label: "Türkçe" },
]

// === Helpers ===

async function uploadAvatar(file: File): Promise<string> {
  const formData = new FormData()
  formData.append("file", file)
  formData.append("folder", "users")

  const res = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  })

  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error ?? "Erreur upload")
  }

  const { publicUrl } = await res.json()
  return publicUrl
}

function phonesEqual(a: PhoneEntry[], b: PhoneEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => {
    const other = b[i]
    return (
      other !== undefined &&
      p.label === other.label &&
      p.countryCode === other.countryCode &&
      p.number === other.number
    )
  })
}

function getFlagForCode(countryCode: string): string {
  const entry = COUNTRY_CODES.find((c) => c.code === countryCode)
  return entry?.flag ?? "🌍"
}

// === Component ===

export default function AccountPage() {
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()

  const profile = useQuery(
    api.userProfiles.getMyProfile,
    session?.user ? {} : "skip"
  )
  const updateMyProfile = useMutation(api.userProfiles.updateMyProfile)

  const [profileName, setProfileName] = useState("")
  const [phones, setPhones] = useState<PhoneEntry[]>([])
  const [profileLanguage, setProfileLanguage] = useState("fr")
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false)
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
  const [emailNotifs, setEmailNotifs] = useState(DEFAULT_NOTIFICATION_PREFERENCES.email)
  const [isSavingPrefs, setIsSavingPrefs] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const savedPhonesRef = useRef<PhoneEntry[]>([])

  const avatarUrl = profile?.avatarUrl ?? session?.user?.image ?? undefined

  useEffect(() => {
    if (!isPending && !session?.user) {
      router.replace("/sign-in")
    }
  }, [isPending, session, router])

  useEffect(() => {
    if (session?.user) {
      setProfileName(session.user.name ?? "")
    }
  }, [session])

  useEffect(() => {
    if (profile) {
      const profilePhones = (profile.phones as PhoneEntry[] | undefined) ?? []
      setPhones(profilePhones)
      savedPhonesRef.current = profilePhones
      setProfileLanguage(profile.language ?? "fr")
      // Absent is not a refusal: a profile written before this field existed
      // has made no choice, and the defaults are what it has been getting.
      const prefs = profile.notificationPreferences ?? DEFAULT_NOTIFICATION_PREFERENCES
      setEmailNotifs(prefs.email)
    }
  }, [profile])

  if (isPending) {
    return (
      <div className="min-h-screen bg-background">
        <div className="pt-24 pb-20 px-6 bg-primary rounded-b-[4rem] md:rounded-b-[8rem] flex flex-col items-center">
          <Skeleton className="mb-6 h-24 w-24 rounded-full" />
          <Skeleton className="mb-2 h-12 w-64 rounded-xl" />
          <Skeleton className="h-6 w-48 rounded-lg" />
        </div>
      </div>
    )
  }

  if (!session?.user) return null

  const user = session.user

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 5 * 1024 * 1024) {
      toast.error("L'image ne doit pas dépasser 5MB")
      return
    }

    if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Format accepté : JPG, PNG ou WebP")
      return
    }

    setIsUploadingAvatar(true)
    try {
      // Step 1: Upload to S3
      const publicUrl = await uploadAvatar(file)

      // Step 2: Save URL in Convex profile (primary source of truth)
      await updateMyProfile({ avatarUrl: publicUrl })

      // Step 3: Try to sync with Better Auth session (non-blocking)
      try {
        await authClient.updateUser({ image: publicUrl })
      } catch {
        // Better Auth sync is best-effort — avatar is already saved in Convex
      }

      toast.success("Avatar mis à jour")
    } catch (error) {
      console.error("Avatar upload error:", error)
      const message = error instanceof Error ? error.message : "Erreur upload avatar"
      toast.error(message)
    } finally {
      setIsUploadingAvatar(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const addPhone = () => {
    setPhones((prev) => [...prev, { label: "Personnel", countryCode: "+33", number: "" }])
  }

  const removePhone = (index: number) => {
    setPhones((prev) => prev.filter((_, i) => i !== index))
  }

  const updatePhone = (index: number, field: keyof PhoneEntry, value: string) => {
    setPhones((prev) =>
      prev.map((p, i) => (i === index ? { ...p, [field]: value } : p))
    )
  }

  const handleUpdateProfile = async () => {
    if (!profileName.trim()) return

    const validPhones = phones.filter((p) => p.number.trim() !== "")

    setIsUpdatingProfile(true)
    try {
      // The Better Auth client RESOLVES on failure, with the reason in
      // `error` — it does not throw. Awaiting it inside a try/catch and then
      // announcing success is how a rejected update was reported as a saved
      // one. Every other call site in this app already knew that.
      const { error } = await authClient.updateUser({ name: profileName })
      if (error) {
        toast.error(error.message ?? "Erreur lors de la mise à jour du profil")
        return
      }

      await updateMyProfile({
        phones: validPhones,
        language: profileLanguage,
      })

      toast.success("Profil mis à jour")
    } catch {
      toast.error("Erreur lors de la mise à jour du profil")
    } finally {
      setIsUpdatingProfile(false)
    }
  }

  /**
   * The apply button had no `onClick` at all.
   *
   * The switch moved, the customer pressed "Appliquer", and nothing was sent
   * anywhere — no request, no error, no feedback. On the next visit it read
   * back whatever the default was, so the choice had never existed.
   *
   * Only the email channel is offered. The SMS switch that used to sit beside
   * it was removed because no SMS is sent anywhere in the engine — there is no
   * provider, no sender, no job — so it collected a preference nothing could
   * honour. The stored value is still submitted untouched: the validator
   * requires both channels together, and a screen that shows no SMS control
   * has no business overwriting what an earlier one recorded.
   */
  const handleUpdateNotificationPreferences = async () => {
    if (isSavingPrefs) return

    setIsSavingPrefs(true)
    try {
      await updateMyProfile({
        notificationPreferences: {
          email: emailNotifs,
          sms:
            profile?.notificationPreferences?.sms ??
            DEFAULT_NOTIFICATION_PREFERENCES.sms,
        },
      })
      toast.success("Préférences enregistrées")
    } catch {
      toast.error("Vos préférences n'ont pas pu être enregistrées.", {
        description: "Réessayez dans un instant.",
      })
    } finally {
      setIsSavingPrefs(false)
    }
  }

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const currentPassword = (form.elements.namedItem("current-password") as HTMLInputElement).value
    const newPassword = (form.elements.namedItem("new-password") as HTMLInputElement).value
    const confirmPassword = (form.elements.namedItem("confirm-password") as HTMLInputElement).value

    if (newPassword !== confirmPassword) {
      toast.error("Les mots de passe ne correspondent pas")
      return
    }

    try {
      // Same trap, and this one locks people out. `changePassword` resolves
      // with `{ error }` on a wrong current password; the result was ignored,
      // so the page said "Mot de passe mis à jour", the user believed the new
      // password was live, and the old one was still the only one that worked.
      const { error } = await authClient.changePassword({
        newPassword,
        currentPassword,
        revokeOtherSessions: true,
      })

      if (error) {
        toast.error(
          error.code === "INVALID_PASSWORD"
            ? "Mot de passe actuel incorrect"
            : (error.message ?? "Erreur lors du changement de mot de passe")
        )
        return
      }

      toast.success("Mot de passe mis à jour")
      form.reset()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors du changement de mot de passe"
      toast.error(message)
    }
  }

  const handleSignOut = async () => {
    await authClient.signOut()
    toast.success("Déconnexion réussie")
    router.push("/menu")
  }

  const hasProfileChanges =
    profileName !== (user.name ?? "") ||
    !phonesEqual(phones, savedPhonesRef.current) ||
    profileLanguage !== (profile?.language ?? "fr")

  return (
    <div className="min-h-screen bg-background text-foreground font-sans overflow-x-hidden pt-20 transition-colors duration-500">
      {/* Hero header */}
      <section className="pt-24 pb-20 px-6 md:px-12 bg-primary relative overflow-hidden rounded-b-[4rem] md:rounded-b-[8rem]">
        <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none">
          <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-white/20 rounded-full blur-[100px]" />
          <div className="absolute bottom-0 left-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px]" />
        </div>

        <div className="max-w-7xl mx-auto relative z-10 text-center">
          <Badge className="bg-primary-hover text-primary-foreground border-white/30 backdrop-blur-md px-4 py-1.5 rounded-full mb-8 font-black tracking-widest uppercase text-[10px] shadow-lg">
            Mon Espace
          </Badge>

          <Avatar className="mx-auto mb-6 h-24 w-24 border-4 border-white/20 shadow-2xl">
            <AvatarImage src={avatarUrl} />
            <AvatarFallback className="bg-accent text-accent-foreground text-3xl font-black">
              {user.name?.charAt(0).toUpperCase() ?? "U"}
            </AvatarFallback>
          </Avatar>

          <h1 className="text-6xl md:text-8xl font-black text-primary-foreground tracking-tighter leading-none mb-8 italic">
            Mon <span className="text-primary-foreground not-italic">Compte</span>
          </h1>
          <p className="text-xl text-primary-foreground max-w-2xl mx-auto font-medium">
            Bonjour, {user.name ?? user.email}
          </p>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-6 md:px-12 py-12">
        {/* Quick links */}
        <div className="grid gap-4 md:grid-cols-3 mb-8">
          {quickLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              <div className="group flex items-center gap-4 rounded-2xl bg-card p-5 shadow-sm border border-border hover:shadow-md hover:border-primary/20 transition-all">
                <div className={`rounded-xl p-3 ${link.color} transition-transform group-hover:scale-110`}>
                  <link.icon className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-black text-sm text-foreground uppercase tracking-tight">
                    {link.label}
                  </p>
                  <p className="text-xs text-muted-foreground font-medium">
                    {link.description}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-accent-foreground transition-colors" />
              </div>
            </Link>
          ))}
        </div>

        {/* Profile management tabs */}
        <div className="rounded-3xl bg-card shadow-sm border border-border overflow-hidden">
          <Tabs defaultValue="general" className="w-full">
            <div className="px-6 pt-6">
              <TabsList className="grid w-full grid-cols-3 bg-muted/80 p-1 rounded-2xl">
                <TabsTrigger
                  value="general"
                  className="rounded-xl data-[state=active]:bg-primary data-[state=active]:text-primary-foreground transition-all font-bold text-xs uppercase"
                >
                  Profil
                </TabsTrigger>
                <TabsTrigger
                  value="security"
                  className="rounded-xl data-[state=active]:bg-primary data-[state=active]:text-primary-foreground transition-all font-bold text-xs uppercase"
                >
                  Sécurité
                </TabsTrigger>
                <TabsTrigger
                  value="prefs"
                  className="rounded-xl data-[state=active]:bg-primary data-[state=active]:text-primary-foreground transition-all font-bold text-xs uppercase"
                >
                  Préférences
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="p-6">
              {/* General tab */}
              <TabsContent value="general" className="outline-none mt-0">
                <div className="space-y-4 pt-2">
                  {/* Avatar section */}
                  <div className="flex items-center gap-5 p-4 bg-muted rounded-3xl border border-border">
                    <div className="relative group">
                      <Avatar className="h-20 w-20 border-4 border-white shadow-md transition-transform duration-300 group-hover:scale-105">
                        <AvatarImage src={avatarUrl} />
                        <AvatarFallback className="text-xl bg-accent text-accent-foreground font-black">
                          {user.name?.charAt(0).toUpperCase() ?? "U"}
                        </AvatarFallback>
                      </Avatar>
                      <button
                        type="button"
                        aria-label="Changer la photo de profil"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploadingAvatar}
                        className="absolute -bottom-1 -right-1 bg-primary text-primary-foreground rounded-full p-1.5 shadow-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
                      >
                        {isUploadingAvatar ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Camera className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/jpg,image/png,image/webp"
                        onChange={handleAvatarChange}
                        className="hidden"
                      />
                    </div>
                    <div className="overflow-hidden">
                      <h3 className="font-black text-xl text-foreground truncate tracking-tight">
                        {user.name}
                      </h3>
                      <p className="text-sm text-muted-foreground truncate mb-1">
                        {user.email}
                      </p>
                      <p className="text-xs text-muted-foreground font-medium">
                        Cliquez sur l&apos;icône pour changer votre photo
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-4 pt-2">
                    <div className="space-y-1.5 px-1">
                      <Label
                        htmlFor="name"
                        className="text-xs font-black uppercase tracking-widest text-muted-foreground"
                      >
                        Nom complet
                      </Label>
                      <Input
                        id="name"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        className="rounded-xl h-12 bg-card border-border focus:border-primary focus-visible:ring-ring font-medium"
                      />
                    </div>
                    <div className="space-y-1.5 px-1">
                      <Label
                        htmlFor="email"
                        className="text-xs font-black uppercase tracking-widest text-muted-foreground"
                      >
                        Adresse email
                      </Label>
                      <Input
                        id="email"
                        defaultValue={user.email}
                        disabled
                        className="rounded-xl h-12 bg-muted border-border font-medium"
                      />
                    </div>

                    {/* Multi-phone section */}
                    <div className="space-y-3 px-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground">
                          <Phone className="inline h-3 w-3 mr-1" />
                          Téléphones
                        </Label>
                        <button
                          type="button"
                          onClick={addPhone}
                          className="flex items-center gap-1 text-xs font-bold text-accent-foreground hover:text-primary-ink transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Ajouter
                        </button>
                      </div>

                      {phones.length === 0 && (
                        <button
                          type="button"
                          onClick={addPhone}
                          className="w-full flex items-center justify-center gap-2 h-12 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary hover:text-accent-foreground transition-colors text-sm font-medium"
                        >
                          <Plus className="h-4 w-4" />
                          Ajouter un numéro de téléphone
                        </button>
                      )}

                      {phones.map((phone, index) => (
                        <div
                          key={index}
                          className="space-y-2 rounded-2xl border border-border bg-muted/50 p-3 animate-in fade-in slide-in-from-top-2 duration-200"
                        >
                          {/* Row 1: Label + Delete */}
                          <div className="flex items-center gap-2">
                            <select
                              value={phone.label}
                              onChange={(e) => updatePhone(index, "label", e.target.value)}
                              className="h-10 rounded-lg border border-border bg-card px-3 text-sm font-medium flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary"
                            >
                              {PHONE_LABELS.map((l) => (
                                <option key={l} value={l}>
                                  {l}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              aria-label="Supprimer ce numéro de téléphone"
                              onClick={() => removePhone(index)}
                              className="shrink-0 h-10 w-10 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-card transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                          {/* Row 2: Country code + Number */}
                          <div className="flex items-center gap-2">
                            <select
                              value={phone.countryCode}
                              onChange={(e) => updatePhone(index, "countryCode", e.target.value)}
                              className="h-12 rounded-xl border border-border bg-card pl-3 pr-2 text-sm font-medium shrink-0 w-[140px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary"
                            >
                              {COUNTRY_CODES.map((c, ci) => (
                                <option key={`${c.code}-${ci}`} value={c.code}>
                                  {c.flag} {c.code} {c.country}
                                </option>
                              ))}
                            </select>
                            <div className="flex-1 relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium pointer-events-none">
                                {getFlagForCode(phone.countryCode)} {phone.countryCode}
                              </span>
                              <Input
                                type="tel"
                                aria-label={`Numéro de téléphone ${index + 1}`}
                                value={phone.number}
                                onChange={(e) => updatePhone(index, "number", e.target.value)}
                                placeholder="6 12 34 56 78"
                                className="rounded-xl h-12 bg-card border-border focus:border-primary focus-visible:ring-ring font-medium pl-[4.5rem]"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-1.5 px-1">
                      <Label
                        htmlFor="language"
                        className="text-xs font-black uppercase tracking-widest text-muted-foreground"
                      >
                        <Globe className="inline h-3 w-3 mr-1" />
                        Langue
                      </Label>
                      <select
                        id="language"
                        value={profileLanguage}
                        onChange={(e) => setProfileLanguage(e.target.value)}
                        className="flex h-12 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium ring-offset-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary"
                      >
                        {LANGUAGES.map((lang) => (
                          <option key={lang.code} value={lang.code}>
                            {lang.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="pt-4">
                    <Button
                      onClick={handleUpdateProfile}
                      disabled={isUpdatingProfile || !hasProfileChanges}
                      className="w-full h-12 rounded-xl bg-primary hover:bg-primary-hover text-primary-foreground font-black uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-[0.98]"
                    >
                      {isUpdatingProfile ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Enregistrer le profil"
                      )}
                    </Button>
                  </div>
                </div>
              </TabsContent>

              {/* Security tab */}
              <TabsContent value="security" className="outline-none mt-0">
                <form onSubmit={handleUpdatePassword} className="space-y-4 pt-2">
                  <div className="grid gap-4">
                    <div className="space-y-1.5 px-1">
                      <Label
                        htmlFor="current-password"
                        className="text-xs font-black uppercase tracking-widest text-muted-foreground"
                      >
                        Mot de passe actuel
                      </Label>
                      <Input
                        id="current-password"
                        name="current-password"
                        type="password"
                        placeholder="••••••••"
                        required
                        className="rounded-xl h-12 border-border focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1.5 px-1">
                      <Label
                        htmlFor="new-password"
                        className="text-xs font-black uppercase tracking-widest text-muted-foreground"
                      >
                        Nouveau mot de passe
                      </Label>
                      <Input
                        id="new-password"
                        name="new-password"
                        type="password"
                        placeholder="••••••••"
                        required
                        className="rounded-xl h-12 border-border focus:border-primary"
                      />
                    </div>
                    <div className="space-y-1.5 px-1">
                      <Label
                        htmlFor="confirm-password"
                        className="text-xs font-black uppercase tracking-widest text-muted-foreground"
                      >
                        Confirmer le mot de passe
                      </Label>
                      <Input
                        id="confirm-password"
                        name="confirm-password"
                        type="password"
                        placeholder="••••••••"
                        required
                        className="rounded-xl h-12 border-border focus:border-primary"
                      />
                    </div>
                  </div>
                  <div className="pt-4">
                    <Button
                      type="submit"
                      className="w-full h-12 rounded-xl bg-primary hover:bg-primary-hover font-black uppercase tracking-widest"
                    >
                      Changer le mot de passe
                    </Button>
                  </div>
                </form>
              </TabsContent>

              {/* Preferences tab */}
              <TabsContent value="prefs" className="outline-none mt-0">
                <div className="space-y-5 px-1 pt-2">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label
                        htmlFor="pref-email-notifications"
                        className="text-sm font-black text-foreground tracking-tight"
                      >
                        Notifications email
                      </Label>
                      <p className="text-xs font-medium text-muted-foreground pr-8">
                        Recevoir les mises à jour de commandes et promotions
                      </p>
                    </div>
                    <Switch
                      id="pref-email-notifications"
                      checked={emailNotifs}
                      onCheckedChange={setEmailNotifs}
                      className="data-[state=checked]:bg-primary"
                    />
                  </div>
                  <div className="pt-6 border-t border-border">
                    <Button
                      variant="outline"
                      onClick={handleUpdateNotificationPreferences}
                      disabled={isSavingPrefs}
                      aria-busy={isSavingPrefs}
                      className="w-full h-12 rounded-xl border-border text-foreground font-black uppercase tracking-widest hover:bg-muted disabled:opacity-60"
                    >
                      {isSavingPrefs ? "Enregistrement…" : "Appliquer les préférences"}
                    </Button>
                  </div>
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </div>

        {/* Sign out */}
        <div className="mt-8 text-center">
          <Button
            variant="ghost"
            onClick={handleSignOut}
            className="text-destructive hover:bg-destructive/5 font-black uppercase tracking-widest text-xs rounded-xl px-8 h-12"
          >
            <LogOut className="mr-2 h-4 w-4" />
            Se déconnecter
          </Button>
        </div>
      </div>
    </div>
  )
}
