"use client"

import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import Link from "next/link"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@be-yours/ui"
import { authClient } from "@/lib/auth-client"
import {
  User,
  ShoppingBag,
  MapPin,
  Heart,
  LogOut,
} from "lucide-react"

interface UserMenuProps {
  /**
   * Where the trigger sits. `transparent` is over the hero photograph, `solid`
   * on the opaque header bar, and `overlay` on the full-screen mobile menu,
   * which paints `bg-primary`.
   *
   * `overlay` exists because `--primary` is dark in the light scheme and light
   * in the dark one (a mint, in the default palette): `transparent`'s white ink
   * on `white/10` measured 1.93:1 there, against the 4.5:1 WCAG 1.4.3 asks. It
   * takes the pair the menu's own close button uses, which is meant to read on
   * `--primary` in both schemes.
   */
  variant?: "transparent" | "solid" | "overlay"
}

export function UserMenu({ variant = "solid" }: UserMenuProps) {
  const { data: session, isPending } = authClient.useSession()
  const hasMounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  // SSR and the first client render must emit identical HTML.
  // Use a <button> (not a Link) to avoid the hydration mismatch that occurs
  // when DropdownMenuTrigger injects a <button> on the client.
  if (!hasMounted || isPending || !session?.user) {
    return (
      <Button
        variant="ghost"
        asChild
        className={`h-10 rounded-full border px-4 font-black uppercase tracking-widest text-[10px] transition-all ${
          variant === "transparent"
            ? "bg-white/10 border-white/20 text-white hover:bg-white/20"
            : variant === "overlay"
              ? // The `ghost` variant hovers to `bg-accent` / `text-accent-foreground`
                // (and a `dark:` twin). Over `--primary` the pill measured 1.98:1
                // in light and 3.21:1 in dark that way, so the hover keeps the
                // resting pair. Its focus ring and border are `--ring`, which is
                // `--primary` — the menu's own background — so a keyboard user
                // saw nothing; they are drawn in ink instead.
                "bg-primary-hover border-white/20 text-primary-foreground hover:bg-primary-hover hover:border-white/40 hover:text-primary-foreground dark:hover:bg-primary-hover focus-visible:border-primary-foreground focus-visible:ring-primary-foreground"
              : "bg-card border-border shadow-sm text-accent-foreground hover:bg-muted"
        }`}
      >
        <Link href="/sign-in">
          <User className="mr-2 h-4 w-4" />
          Connexion
        </Link>
      </Button>
    )
  }

  const user = session.user

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={`relative h-10 w-10 rounded-full border-2 p-0 overflow-hidden transition-all ${
            variant === "transparent"
              ? "border-white/20 hover:border-white/40 hover:bg-white/10"
              : variant === "overlay"
                ? // As the pill above: the ghost hover fill would wash the ring
                  // behind the avatar, and `--ring` is the menu's own colour.
                  "border-white/20 hover:border-white/40 hover:bg-transparent dark:hover:bg-transparent focus-visible:border-primary-foreground focus-visible:ring-primary-foreground"
                : "border-border hover:border-primary hover:bg-accent"
          }`}
        >
          <Avatar className="h-full w-full">
            <AvatarImage
              src={user.image ?? undefined}
              alt={user.name ?? "User"}
              className="object-cover"
            />
            <AvatarFallback
              className={`font-black ${
                variant === "transparent"
                  ? "bg-white/20 text-white"
                  : variant === "overlay"
                    ? "bg-primary-hover text-primary-foreground"
                    : "bg-muted text-accent-foreground"
              }`}
            >
              {user.name?.charAt(0).toUpperCase() ?? "U"}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="w-72 p-2 rounded-[2rem] border-border shadow-2xl space-y-1"
        align="end"
        forceMount
      >
        {/* User info */}
        <div className="flex items-center gap-3 p-4 bg-muted rounded-[1.5rem] mb-2">
          <Avatar className="h-12 w-12 border-2 border-white shadow-sm">
            <AvatarImage src={user.image ?? undefined} />
            <AvatarFallback className="bg-accent text-accent-foreground font-black">
              {user.name?.charAt(0).toUpperCase() ?? "U"}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col space-y-0.5 overflow-hidden">
            <p className="text-sm font-black truncate text-foreground leading-none">
              {user.name}
            </p>
            <p className="text-xs font-bold text-muted-foreground truncate tracking-tight">
              {user.email}
            </p>
          </div>
        </div>

        <DropdownMenuGroup className="px-1">
          <Link href="/account" className="block w-full">
            <DropdownMenuItem className="cursor-pointer py-3 px-4 rounded-xl hover:bg-accent focus:bg-accent focus:text-accent-foreground group transition-colors">
              <User className="mr-3 h-5 w-5 text-muted-foreground group-hover:text-accent-foreground transition-colors" />
              <span className="font-black uppercase tracking-widest text-[10px]">
                Mon profil
              </span>
            </DropdownMenuItem>
          </Link>

          <Link href="/account/orders" className="block w-full">
            <DropdownMenuItem className="cursor-pointer py-3 px-4 rounded-xl hover:bg-accent focus:bg-accent focus:text-accent-foreground group transition-colors">
              <ShoppingBag className="mr-3 h-5 w-5 text-muted-foreground group-hover:text-accent-foreground transition-colors" />
              <span className="font-black uppercase tracking-widest text-[10px]">
                Mes commandes
              </span>
            </DropdownMenuItem>
          </Link>

          <Link href="/account/addresses" className="block w-full">
            <DropdownMenuItem className="cursor-pointer py-3 px-4 rounded-xl hover:bg-accent focus:bg-accent focus:text-accent-foreground group transition-colors">
              <MapPin className="mr-3 h-5 w-5 text-muted-foreground group-hover:text-accent-foreground transition-colors" />
              <span className="font-black uppercase tracking-widest text-[10px]">
                Mes adresses
              </span>
            </DropdownMenuItem>
          </Link>

          <Link href="/account/favorites" className="block w-full">
            <DropdownMenuItem className="cursor-pointer py-3 px-4 rounded-xl hover:bg-accent focus:bg-accent focus:text-accent-foreground group transition-colors">
              <Heart className="mr-3 h-5 w-5 text-muted-foreground group-hover:text-accent-foreground transition-colors" />
              <span className="font-black uppercase tracking-widest text-[10px]">
                Mes favoris
              </span>
            </DropdownMenuItem>
          </Link>
        </DropdownMenuGroup>

        <DropdownMenuSeparator className="mx-2 bg-muted" />

        <div className="px-1 pb-1">
          <DropdownMenuItem
            className="cursor-pointer py-3 px-4 rounded-xl text-destructive hover:bg-destructive/5 focus:bg-destructive/5 group transition-colors"
            onClick={async () => {
              await authClient.signOut()
              toast.success("Déconnexion réussie")
              window.location.href = "/menu"
            }}
          >
            <LogOut className="mr-3 h-5 w-5 transition-transform group-hover:-translate-x-1" />
            <span className="font-black uppercase tracking-widest text-[10px]">
              Se déconnecter
            </span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
