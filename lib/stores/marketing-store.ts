import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface CartItem {
    id: string | number;
    title: string;
    price: number;
    image: string;
    quantity: number;
    note?: string;
    selectedOptions?: { groupName: string; name: string; price: number }[];
}

interface MarketingState {
    cart: CartItem[];
    addToCart: (item: Omit<CartItem, 'quantity'>, quantity?: number) => void;
    removeFromCart: (id: string | number, note?: string) => void;
    updateQuantity: (id: string | number, quantity: number, note?: string) => void;
    clearCart: () => void;
    cartCount: () => number;
    cartTotal: () => number;
    favorites: (string | number)[];
    toggleFavorite: (id: string | number) => void;
    isFavorite: (id: string | number) => boolean;
}

export const useMarketingStore = create<MarketingState>()(
    persist(
        (set, get) => ({
            cart: [],
            addToCart: (item, quantity = 1) => {
                set((state) => {
                    const existingIndex = state.cart.findIndex(
                        (i) => i.id === item.id && i.note === item.note &&
                            JSON.stringify(i.selectedOptions) === JSON.stringify(item.selectedOptions)
                    );
                    if (existingIndex > -1) {
                        const newCart = [...state.cart];
                        newCart[existingIndex] = {
                            ...newCart[existingIndex]!,
                            quantity: newCart[existingIndex]!.quantity + quantity,
                        };
                        return { cart: newCart };
                    }
                    return {
                        cart: [...state.cart, { ...item, quantity }],
                    };
                });
            },
            removeFromCart: (id, note) => {
                set((state) => ({
                    cart: state.cart.filter((i) => !(i.id === id && i.note === note)),
                }));
            },
            updateQuantity: (id, quantity, note) => {
                if (quantity <= 0) {
                    set((state) => ({
                        cart: state.cart.filter((i) => !(i.id === id && i.note === note)),
                    }));
                    return;
                }
                set((state) => ({
                    cart: state.cart.map((i) =>
                        i.id === id && i.note === note ? { ...i, quantity } : i
                    ),
                }));
            },
            clearCart: () => set({ cart: [] }),
            cartCount: () => get().cart.reduce((sum, i) => sum + i.quantity, 0),
            cartTotal: () =>
                get().cart.reduce((sum, i) => {
                    const optionsPrice = (i.selectedOptions ?? []).reduce((s, o) => s + o.price, 0);
                    return sum + (i.price + optionsPrice) * i.quantity;
                }, 0),
            favorites: [],
            toggleFavorite: (id) => {
                set((state) => ({
                    favorites: state.favorites.includes(id)
                        ? state.favorites.filter((f) => f !== id)
                        : [...state.favorites, id],
                }));
            },
            isFavorite: (id) => get().favorites.includes(id),
        }),
        {
            name: "marketing-storage",
        }
    )
);
