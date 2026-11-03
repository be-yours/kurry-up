"use client"

import { useState } from "react"
import {
  MapPin,
  MapPinOff,
  Star,
  Trash2,
  Plus,
  Pencil,
  CheckCircle2,
} from "lucide-react"
import {
  Button,
  Input,
  Label,
  Badge,
  Card,
  CardContent,
  Separator,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@be-yours/ui"
import { type SavedAddress } from "@/lib/stores/addresses-store"
import { useAddresses } from "@/lib/hooks/use-addresses"
import { authClient } from "@/lib/auth-client"
import { useGooglePlacesAutocomplete } from "@/hooks/useGooglePlacesAutocomplete"
import type { AddressValue } from "@/lib/address"
import { toast } from "sonner"

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""

const emptyAddress: AddressValue = {
  street: "",
  city: "",
  postalCode: "",
  country: "France",
}

export function AddressManager() {
  // Signed in, the list lives in the database and follows the customer across
  // devices; as a guest it stays in this browser, which is the only place a
  // guest has. The hook hides which one is in play.
  const { data: session } = authClient.useSession()
  const { addresses, addAddress, updateAddress, removeAddress, setDefault } =
    useAddresses(!!session?.user)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addressLabel, setAddressLabel] = useState("")
  const [manualAddress, setManualAddress] = useState<AddressValue>(emptyAddress)
  // "search" = only search bar visible, "selected" = address picked from Google, "manual" = user types manually
  const [addressMode, setAddressMode] = useState<"search" | "selected" | "manual">("search")

  const { inputRef: addressInputRef } = useGooglePlacesAutocomplete({
    apiKey: GOOGLE_MAPS_API_KEY,
    onSelect: (parsed) => {
      setManualAddress((prev) => ({
        street: parsed.street ?? prev.street,
        city: parsed.city ?? prev.city,
        postalCode: parsed.postalCode ?? prev.postalCode,
        country: parsed.country ?? prev.country,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
      }))
      setAddressMode("selected")
    },
  })

  const showAddressFields = addressMode === "selected" || addressMode === "manual"

  const resetForm = () => {
    setShowForm(false)
    setEditingId(null)
    setManualAddress(emptyAddress)
    setAddressLabel("")
    setAddressMode("search")
  }

  const handleEdit = (addr: SavedAddress) => {
    setEditingId(addr.id)
    setAddressLabel(addr.label ?? "")
    setManualAddress({
      street: addr.street,
      city: addr.city,
      postalCode: addr.postalCode,
      country: addr.country,
      // Carried through the edit, not dropped. `editLocationField` below
      // discards them again the moment one of the three fields they describe
      // is retyped, so an address only keeps coordinates that still match it.
      latitude: addr.latitude,
      longitude: addr.longitude,
    })
    setAddressMode("manual")
    setShowForm(true)
  }

  /**
   * Edit one of the fields the coordinates describe.
   *
   * Street, city and postcode are what the autocomplete geocoded. Retyping any
   * of them makes the stored point describe somewhere else, and a stale point
   * is worse than none: the checkout would quote a courier to the old address
   * without ever showing that it had. Dropping them puts the address back in
   * the state the schema documents — no coordinates, so re-entered at checkout
   * rather than geocoded blind.
   */
  const editLocationField = (field: "street" | "city" | "postalCode", value: string) => {
    setManualAddress((p) => ({
      ...p,
      [field]: value,
      latitude: undefined,
      longitude: undefined,
    }))
  }

  const handleSubmit = () => {
    if (!manualAddress.street.trim() || !manualAddress.city.trim() || !manualAddress.postalCode.trim()) {
      toast.error("Veuillez remplir au moins la rue, la ville et le code postal")
      return
    }
    const data = {
      label: addressLabel || undefined,
      street: manualAddress.street,
      city: manualAddress.city,
      postalCode: manualAddress.postalCode,
      country: manualAddress.country || "France",
      // The reason this address book exists is to spare the customer retyping
      // an address at checkout — and the checkout quotes Uber Direct from these
      // two numbers alone. Dropping them here meant the same address produced a
      // different delivery fee depending on where it had been entered.
      latitude: manualAddress.latitude,
      longitude: manualAddress.longitude,
    }
    if (editingId) {
      updateAddress(editingId, data)
      resetForm()
      toast.success("Adresse modifiée")
    } else {
      addAddress(data)
      resetForm()
      toast.success("Adresse ajoutée")
    }
  }

  const handleRemove = (id: string) => {
    if (window.confirm("Supprimer cette adresse ?")) {
      removeAddress(id)
      toast.success("Adresse supprimée")
    }
  }

  return (
    <div className="space-y-6">
      {/* Address list */}
      {addresses.length === 0 && !showForm && (
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MapPin className="h-5 w-5" />
            </EmptyMedia>
            <EmptyTitle>Aucune adresse enregistrée</EmptyTitle>
            <EmptyDescription>
              Ajoutez une adresse pour accélérer vos commandes.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {addresses.length > 0 && (
        <div className="space-y-3">
          {addresses.map((addr: SavedAddress) => (
            <Card key={addr.id} className="rounded-2xl">
              <CardContent className="flex items-start justify-between p-4">
                <div className="flex items-start gap-3">
                  <MapPin className="mt-1 h-5 w-5 text-muted-foreground" />
                  <div>
                    <div className="flex items-center gap-2">
                      {addr.label && (
                        <span className="font-medium">{addr.label}</span>
                      )}
                      {addr.isDefault && (
                        <Badge variant="secondary" className="text-[10px]">
                          Par défaut
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {addr.street}, {addr.postalCode} {addr.city}, {addr.country}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleEdit(addr)}
                    title="Modifier"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {!addr.isDefault && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setDefault(addr.id)}
                      title="Définir par défaut"
                    >
                      <Star className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    aria-label={`Supprimer l'adresse ${addr.street}`}
                    onClick={() => handleRemove(addr.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add form toggle */}
      {!showForm && (
        <Button
          variant="outline"
          onClick={() => setShowForm(true)}
          className="w-full"
        >
          <Plus className="mr-2 h-4 w-4" />
          Ajouter une adresse
        </Button>
      )}

      {/* Add form — same flow as checkout */}
      {showForm && (
        <div className="overflow-hidden rounded-[2.5rem] border-none bg-card p-2 shadow-xl shadow-black/[0.03]">
          <div className="p-8">
            <div className="mb-2 flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                <MapPin className="h-5 w-5" />
              </div>
              <h2 className="text-2xl font-black uppercase tracking-tighter text-foreground">
                {editingId ? "Modifier l\u2019adresse" : "Nouvelle adresse"}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Recherchez votre adresse ou saisissez-la manuellement.
            </p>
          </div>

          <div className="space-y-4 px-8 pb-8">
            {/* Label */}
            <div className="space-y-2">
              <Label htmlFor="address-label" className="ml-1 text-[10px] font-black uppercase tracking-widest">
                Nom (optionnel)
              </Label>
              <Input
                id="address-label"
                value={addressLabel}
                onChange={(e) => setAddressLabel(e.target.value)}
                placeholder="ex: Maison, Bureau"
                className="h-14 rounded-2xl border-input bg-muted px-6 text-sm font-medium transition-all focus:bg-card focus-visible:ring-ring"
              />
            </div>

            {/* Search with Google Places */}
            <div className="space-y-2">
              <Label
                htmlFor="address-manager-search"
                className="ml-1 text-[10px] font-black uppercase tracking-widest"
              >
                Rechercher une adresse
              </Label>
              <div className="relative">
                <MapPin className="absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-accent-foreground" />
                <input
                  id="address-manager-search"
                  ref={addressInputRef}
                  type="text"
                  placeholder="Ex : 12 rue de la Paix, Paris..."
                  className="storefront-pac-input h-14 w-full rounded-2xl border-2 border-border bg-muted pl-12 pr-6 text-sm font-medium transition-all placeholder:text-muted-foreground focus:border-primary focus:bg-card focus:outline-none focus:ring-2 focus-visible:ring-ring"
                />
              </div>
            </div>

            {/* "Can't find my address" fallback */}
            {addressMode === "search" && (
              <button
                type="button"
                onClick={() => setAddressMode("manual")}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border px-4 py-3 text-xs font-bold uppercase tracking-widest text-muted-foreground transition-all hover:border-border hover:text-muted-foreground"
              >
                <MapPinOff className="h-3.5 w-3.5" />
                Je ne trouve pas mon adresse
              </button>
            )}

            {/* Detail fields — shown after Google select or manual mode */}
            {showAddressFields && (
              <div className="space-y-4 rounded-2xl border-2 border-primary/20 bg-accent/30 p-5">
                {addressMode === "selected" && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-accent-foreground">
                        Adresse sélectionnée
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setAddressMode("search")
                        setManualAddress(emptyAddress)
                      }}
                      className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-muted-foreground"
                    >
                      Modifier
                    </button>
                  </div>
                )}
                {addressMode === "manual" && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      Saisie manuelle
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setAddressMode("search")
                        setManualAddress(emptyAddress)
                      }}
                      className="text-[10px] font-bold uppercase tracking-widest text-accent-foreground transition-colors hover:text-accent-foreground"
                    >
                      Revenir à la recherche
                    </button>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="address-street" className="ml-1 text-[10px] font-black uppercase tracking-widest">
                    Adresse *
                  </Label>
                  <Input
                    id="address-street"
                    value={manualAddress.street}
                    onChange={(e) => editLocationField("street", e.target.value)}
                    placeholder="123 rue de la Paix"
                    readOnly={addressMode === "selected"}
                    className="h-14 rounded-2xl border-input bg-card px-6 text-sm font-medium transition-all focus-visible:ring-ring"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="address-city" className="ml-1 text-[10px] font-black uppercase tracking-widest">
                      Ville *
                    </Label>
                    <Input
                      id="address-city"
                      value={manualAddress.city}
                      onChange={(e) => editLocationField("city", e.target.value)}
                      placeholder="Paris"
                      readOnly={addressMode === "selected"}
                      className="h-14 rounded-2xl border-input bg-card px-6 text-sm font-medium transition-all focus-visible:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="address-postal-code" className="ml-1 text-[10px] font-black uppercase tracking-widest">
                      Code postal *
                    </Label>
                    <Input
                      id="address-postal-code"
                      value={manualAddress.postalCode}
                      onChange={(e) => editLocationField("postalCode", e.target.value)}
                      placeholder="75001"
                      readOnly={addressMode === "selected"}
                      className="h-14 rounded-2xl border-input bg-card px-6 text-sm font-medium transition-all focus-visible:ring-ring"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address-country" className="ml-1 text-[10px] font-black uppercase tracking-widest">
                    Pays
                  </Label>
                  <Input
                    id="address-country"
                    value={manualAddress.country}
                    onChange={(e) => setManualAddress((p) => ({ ...p, country: e.target.value }))}
                    readOnly={addressMode === "selected"}
                    className="h-14 rounded-2xl border-input bg-card px-6 text-sm font-medium transition-all focus-visible:ring-ring"
                  />
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <Button
                onClick={handleSubmit}
                disabled={!showAddressFields}
                className="h-14 flex-1 rounded-2xl bg-primary font-black uppercase tracking-widest text-primary-foreground shadow-xl shadow-primary/10 transition-all hover:bg-primary-hover"
              >
                {editingId ? "Enregistrer" : "Ajouter l\u2019adresse"}
              </Button>
              <Button
                variant="outline"
                onClick={resetForm}
                className="h-14 rounded-2xl border-border px-8 font-black uppercase tracking-widest transition-all"
              >
                Annuler
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
