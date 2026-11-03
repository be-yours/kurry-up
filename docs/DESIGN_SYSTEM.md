# Design System - Restaurant Theme

## Overview

The BeYours Engine restaurant theme uses a comprehensive design system built on shadcn/ui and Tailwind CSS v4, providing a consistent and accessible UI across all restaurant types.

## Setup

### Dependencies

- **shadcn/ui**: Component library with customizable primitives
- **Tailwind CSS v4**: Utility-first CSS framework
- **Lucide React**: Icon library
- **clsx + tailwind-merge**: Utility class composition

### Configuration Files

- `components.json`: shadcn/ui configuration
- `app/globals.css`: Design tokens and CSS variables
- `lib/utils.ts`: Utility functions (cn helper)

## Design Tokens

### Color System

All colors are defined using HSL values with CSS variables for easy theming and dark mode support.

#### Base Colors

```css
--background: 0 0% 100%;
--foreground: 222.2 84% 4.9%;
--primary: 22 100% 50%;        /* Orange - Restaurant brand color */
--secondary: 210 40% 96.1%;
--muted: 210 40% 96.1%;
--accent: 210 40% 96.1%;
--destructive: 0 84.2% 60.2%;
--border: 214.3 31.8% 91.4%;
```

#### Component Colors

```css
--card: 0 0% 100%;
--popover: 0 0% 100%;
--input: 214.3 31.8% 91.4%;
--ring: 22 100% 50%;
```

#### Restaurant-Specific Colors

```css
--success: 142 76% 36%;        /* Green for success states */
--warning: 38 92% 50%;         /* Yellow for warnings */
--info: 217 91% 60%;           /* Blue for information */
```

#### Order Status Colors

```css
--status-pending: 38 92% 50%;      /* Yellow - Order pending */
--status-confirmed: 217 91% 60%;   /* Blue - Order confirmed */
--status-preparing: 25 95% 53%;    /* Orange - Being prepared */
--status-ready: 142 76% 36%;       /* Green - Ready for pickup */
--status-delivered: 262 83% 58%;   /* Purple - Delivered */
--status-cancelled: 0 84% 60%;     /* Red - Cancelled */
```

### Typography

#### Font Families

- **Sans (Body)**: Inter - Clean, modern sans-serif for body text
- **Heading**: Poppins - Bold, friendly font for headings and emphasis

#### Font Variables

```css
--font-sans: var(--font-inter);
--font-heading: var(--font-poppins);
```

#### Usage in Components

```tsx
<h1 className="font-heading">Welcome to Our Restaurant</h1>
<p className="font-sans">Browse our delicious menu items...</p>
```

### Spacing & Layout

- **Border Radius**: `--radius: 0.5rem` (8px) - Consistent rounded corners
- **Container**: Use Tailwind's container utilities with max-width constraints

## Using Colors in Components

### With Tailwind Classes

```tsx
<button className="bg-primary text-primary-foreground">
  Order Now
</button>

<div className="bg-card text-card-foreground">
  Card content
</div>

<span className="text-status-ready">Ready</span>
```

### With CSS Variables

```tsx
<div style={{ backgroundColor: 'hsl(var(--success))' }}>
  Success message
</div>
```

## Dark Mode

Dark mode is automatically supported through CSS variables. It is on while the `dark` class is on the `<html>` element, and `next-themes`, mounted in `app/providers.tsx`, puts it there.

The storefront header has a button that steps through light, dark and the visitor's device setting, and the choice is stored in the visitor's browser. A site sets what a visitor sees first, and whether the button exists, in the `theme` entry of its `site.config.ts` (see `docs/CUSTOMIZATION.md` in the template).

```tsx
// Read or change the scheme from any client component
import { useTheme } from "next-themes"

const { theme, setTheme } = useTheme() // "light" | "dark" | "system"
setTheme("dark")
```

## Component Utilities

### cn() Helper

The `cn()` utility combines class names and properly merges Tailwind classes to avoid conflicts.

```tsx
import { cn } from "@/lib/utils"

<button
  className={cn(
    "bg-primary text-white",
    isLoading && "opacity-50 cursor-not-allowed",
    className
  )}
>
  Click me
</button>
```

## Where the components live

Every shared component comes from `@be-yours/ui`, and there is exactly one
implementation of each:

```tsx
import { Button, Card, Input, Badge } from "@be-yours/ui"
```

This app used to carry its own `components/ui/` as well — 37 files that had
drifted from the package, so the same site rendered two button heights
depending on the page. That directory is gone and must not come back.
`packages/ui/src/__tests__/design-system-singularity.test.ts` fails if it does.

**Adding a component.** Add it to `packages/ui` in the engine repository, not
here — a component added here is a component the next engine update cannot fix
and no other site benefits from. A one-off that is genuinely specific to this
site belongs in `components/` under its own name, composed out of the design
system rather than reimplementing it.

## Theme Customization

There are three places a colour can come from, and they are not
interchangeable.

### 1. The establishment owner, from the admin

`/dashboard/design` → **Couleurs**. Primary, secondary and accent are saved on
the establishment and painted onto the storefront's custom properties at
runtime, per store — so a two-location client can give each site its own
palette. This is the one an owner can use without a developer, and the one to
reach for first.

The screen derives the rest of the palette from what is picked: the focus ring
follows the primary, the accent becomes a tint rather than a slab (`bg-accent`
paints hover states), the text on a coloured button is chosen by contrast ratio,
and a dark-mode set is emitted alongside. The preview on the screen is rendered
by the same code as the storefront, so it cannot drift from it.

### 2. This site's own theme — `site/theme.css`

The client zone. Loaded after `app/globals.css`, so anything redefined here
overrides the engine default for the whole site, and an engine update never
touches it. Use it for a palette that is part of the build rather than
something an owner edits.

```css
:root {
  --primary: 8 76% 45%;
  --ring: 8 76% 45%;
}
```

`pnpm template:apply <slug>` writes this file (and `site/fonts.ts`) from one of
the ready-made themes under `templates/` — `pnpm template:list` shows them.

### 3. `app/globals.css` — the engine default

Do not edit it. It is the engine's own file and an update overwrites it; the
orange it defines is only what a site renders when neither of the two above has
said otherwise.

## Best Practices

### Accessibility

- Always use semantic HTML elements
- Ensure sufficient color contrast (WCAG AA minimum)
- Include ARIA labels for interactive elements
- Support keyboard navigation

### Performance

- Use `font-display: swap` for custom fonts (already configured)
- Minimize custom CSS; prefer Tailwind utilities
- Tree-shake unused styles in production

### Consistency

- Use design tokens instead of arbitrary values, so an establishment's chosen
  colours reach what you build. A hard-coded `bg-[#FF6B00]` is a component that
  ignores the owner's palette.
- Follow the component composition pattern from shadcn/ui
- Take shared components from `@be-yours/ui`; keep genuinely site-specific
  ones in `components/`, composed out of the design system
- Document new components with JSDoc comments

## Chart Colors

For data visualization (charts, graphs):

```css
--chart-1: 12 76% 61%;   /* Coral */
--chart-2: 173 58% 39%;  /* Teal */
--chart-3: 197 37% 24%;  /* Dark Blue */
--chart-4: 43 74% 66%;   /* Yellow */
--chart-5: 27 87% 67%;   /* Orange */
```

## Resources

- [shadcn/ui Documentation](https://ui.shadcn.com)
- [Tailwind CSS v4 Documentation](https://tailwindcss.com)
- [Lucide Icons](https://lucide.dev)
- [WCAG Contrast Checker](https://webaim.org/resources/contrastchecker/)

---

**Version**: 1.0.0
**Last Updated**: February 15, 2026
**Maintained by**: BeYours Team
