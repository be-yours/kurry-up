import { Button } from "@be-yours/ui";

/**
 * Design System Demo Component
 *
 * Demonstrates the usage of the BeYours Engine design system
 * including colors, typography, and UI components.
 */
export function DesignSystemDemo() {
  return (
    <div className="min-h-screen p-8 space-y-12">
      {/* Typography */}
      <section className="space-y-4">
        <h1 className="text-4xl font-heading font-bold">
          Design System Demo
        </h1>
        <p className="text-lg text-muted-foreground font-sans">
          This page demonstrates the BeYours Engine design system with
          shadcn/ui components and Tailwind CSS v4.
        </p>
      </section>

      {/* Color Palette */}
      <section className="space-y-6">
        <h2 className="text-2xl font-heading font-semibold">Color Palette</h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-2">
            <div className="h-24 rounded-lg bg-primary" />
            <p className="text-sm font-medium">Primary</p>
            <p className="text-xs text-muted-foreground">Brand Orange</p>
          </div>

          <div className="space-y-2">
            <div className="h-24 rounded-lg bg-secondary" />
            <p className="text-sm font-medium">Secondary</p>
            <p className="text-xs text-muted-foreground">Light Gray</p>
          </div>

          <div className="space-y-2">
            <div className="h-24 rounded-lg bg-success" />
            <p className="text-sm font-medium">Success</p>
            <p className="text-xs text-muted-foreground">Green</p>
          </div>

          <div className="space-y-2">
            <div className="h-24 rounded-lg bg-destructive" />
            <p className="text-sm font-medium">Destructive</p>
            <p className="text-xs text-muted-foreground">Red</p>
          </div>
        </div>
      </section>

      {/* Order Status Colors */}
      <section className="space-y-6">
        <h2 className="text-2xl font-heading font-semibold">
          Order Status Colors
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <div className="h-16 rounded-lg bg-status-pending" />
            <p className="text-sm font-medium">Pending</p>
          </div>

          <div className="space-y-2">
            <div className="h-16 rounded-lg bg-status-confirmed" />
            <p className="text-sm font-medium">Confirmed</p>
          </div>

          <div className="space-y-2">
            <div className="h-16 rounded-lg bg-status-preparing" />
            <p className="text-sm font-medium">Preparing</p>
          </div>

          <div className="space-y-2">
            <div className="h-16 rounded-lg bg-status-ready" />
            <p className="text-sm font-medium">Ready</p>
          </div>

          <div className="space-y-2">
            <div className="h-16 rounded-lg bg-status-delivered" />
            <p className="text-sm font-medium">Delivered</p>
          </div>

          <div className="space-y-2">
            <div className="h-16 rounded-lg bg-status-cancelled" />
            <p className="text-sm font-medium">Cancelled</p>
          </div>
        </div>
      </section>

      {/* Buttons */}
      <section className="space-y-6">
        <h2 className="text-2xl font-heading font-semibold">Button Variants</h2>

        <div className="flex flex-wrap gap-4">
          <Button variant="default">Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="destructive">Destructive</Button>
        </div>

        <h3 className="text-xl font-heading font-medium mt-8">Button Sizes</h3>
        <div className="flex flex-wrap items-center gap-4">
          <Button size="xs">Extra Small</Button>
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
        </div>
      </section>

      {/* Typography Scale */}
      <section className="space-y-6">
        <h2 className="text-2xl font-heading font-semibold">
          Typography Scale
        </h2>

        <div className="space-y-4">
          <h1 className="text-4xl font-heading font-bold">
            Heading 1 - Poppins Bold
          </h1>
          <h2 className="text-3xl font-heading font-semibold">
            Heading 2 - Poppins Semibold
          </h2>
          <h3 className="text-2xl font-heading font-medium">
            Heading 3 - Poppins Medium
          </h3>
          <h4 className="text-xl font-heading font-medium">
            Heading 4 - Poppins Medium
          </h4>
          <p className="text-base font-sans">
            Body text - Inter Regular. This is the default font for all body
            content across the restaurant theme.
          </p>
          <p className="text-sm text-muted-foreground font-sans">
            Small text - Inter Regular with muted foreground color.
          </p>
        </div>
      </section>

      {/* Cards */}
      <section className="space-y-6">
        <h2 className="text-2xl font-heading font-semibold">Card Layout</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-card text-card-foreground rounded-lg border p-6 space-y-2">
            <h3 className="font-heading font-semibold text-lg">Card Title</h3>
            <p className="text-sm text-muted-foreground">
              This is a card component using the design system colors.
            </p>
            <Button size="sm" className="mt-4">
              Action
            </Button>
          </div>

          <div className="bg-card text-card-foreground rounded-lg border p-6 space-y-2">
            <h3 className="font-heading font-semibold text-lg">
              Another Card
            </h3>
            <p className="text-sm text-muted-foreground">
              Cards maintain consistent spacing and styling.
            </p>
            <Button size="sm" variant="outline" className="mt-4">
              Learn More
            </Button>
          </div>

          <div className="bg-card text-card-foreground rounded-lg border p-6 space-y-2">
            <h3 className="font-heading font-semibold text-lg">Third Card</h3>
            <p className="text-sm text-muted-foreground">
              All using the same design tokens for consistency.
            </p>
            <Button size="sm" variant="ghost" className="mt-4">
              Explore
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
