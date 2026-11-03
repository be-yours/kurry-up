"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, MapPin } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { Badge, Skeleton } from "@be-yours/ui"
import { AddressManager } from "@/components/storefront/address-manager"

export default function AddressesContent() {
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()

  useEffect(() => {
    if (!isPending && !session?.user) {
      router.replace("/sign-in")
    }
  }, [isPending, session, router])

  if (isPending || !session?.user) {
    return (
      <div className="min-h-screen bg-background">
        <div className="pt-24 pb-20 px-6 bg-primary rounded-b-[4rem] md:rounded-b-[8rem] flex flex-col items-center">
          <Skeleton className="mb-4 h-10 w-48 rounded-xl" />
          <Skeleton className="h-6 w-64 rounded-lg" />
        </div>
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-12">
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans overflow-x-hidden pt-20 transition-colors duration-500">
      {/* Hero header */}
      <section className="pt-24 pb-20 px-6 md:px-12 bg-primary relative overflow-hidden rounded-b-[4rem] md:rounded-b-[8rem]">
        <div className="absolute top-0 right-0 w-full h-full opacity-10 pointer-events-none">
          <div className="absolute top-1/4 right-1/4 w-96 h-96 bg-white/20 rounded-full blur-[100px]" />
          <div className="absolute bottom-0 left-0 w-[800px] h-[800px] bg-primary/10 rounded-full blur-[120px]" />
        </div>

        <div className="max-w-7xl mx-auto relative z-10 text-center">
          <Link
            href="/account"
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-primary-foreground transition-colors hover:underline hover:underline-offset-4 font-medium"
          >
            <ArrowLeft className="h-4 w-4" />
            Mon compte
          </Link>
          <Badge className="bg-primary-hover text-primary-foreground border-white/30 backdrop-blur-md px-4 py-1.5 rounded-full mb-8 font-black tracking-widest uppercase text-[10px] shadow-lg block mx-auto w-fit">
            Livraison
          </Badge>
          <h1 className="text-6xl md:text-8xl font-black text-primary-foreground tracking-tighter leading-none mb-8 italic">
            Mes <span className="text-primary-foreground not-italic">Adresses</span>
          </h1>
          <p className="text-xl text-primary-foreground max-w-2xl mx-auto font-medium">
            Gérez vos adresses de livraison
          </p>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-6 md:px-12 py-12">
        <div className="rounded-3xl bg-card shadow-sm border border-border p-6">
          <AddressManager />
        </div>
      </div>
    </div>
  )
}
