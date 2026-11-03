"use client";

import type { ComponentProps } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { MotionConfig } from "framer-motion";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_SITE_THEME, type SiteTheme } from "@/lib/site-theme";
import { SiteThemeProvider } from "@/lib/site-theme-provider";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

/**
 * From better-auth 1.6.22 on, `@convex-dev/better-auth`'s `AuthClient` type
 * infers `useSession().data` as `never` for every client built with
 * `createAuthClient`, so a correct client is refused. The provider only calls
 * `useSession`, `getSession` and `convex.token` at runtime, all unchanged, so
 * the client is narrowed to the prop's own type here. 1.6.22 is the release
 * that fixes GHSA-qq9h-g4jm-xgf3. Drop the cast the day an adapter release
 * types the client correctly.
 */
type ProviderAuthClient = ComponentProps<
  typeof ConvexBetterAuthProvider
>["authClient"];

export function Providers({
  children,
  initialToken,
  theme = DEFAULT_SITE_THEME,
}: {
  children: React.ReactNode;
  initialToken?: string | null;
  /**
   * The site's colour-scheme settings: the `theme` entry of `site.config.ts`,
   * read by `readSiteTheme` in the layout that has one (`lib/site-theme.ts`).
   * Left out, the app follows the visitor's device and offers the toggle, which
   * is what the bench's layout gets.
   */
  theme?: SiteTheme;
}) {
  return (
    <ConvexBetterAuthProvider
      client={convex}
      authClient={authClient as unknown as ProviderAuthClient}
      initialToken={initialToken}
    >
      {/*
        `defaultTheme` is what a visitor sees until they choose: `system` unless
        the site says otherwise. `enableSystem` stays on whatever the default is,
        because `system` is one of the three choices the header's toggle offers.
      */}
      <ThemeProvider
        attribute="class"
        defaultTheme={theme.default}
        enableSystem
        disableTransitionOnChange
      >
        <SiteThemeProvider value={theme}>
          {/*
            `prefers-reduced-motion`, for the animations that do not go through
            CSS at all.

            `globals.css` carries a reduced-motion block and it reached NOTHING
            that framer-motion draws: framer animates by writing inline `style`
            on each frame, which no stylesheet rule can override, and the block
            was scoped to `.animate-in` besides — one occurrence in the whole
            app. So a diner who had asked their operating system to stop moving
            things still met every `motion.*` element on the buying path, the
            floating hero badges included.

            `reducedMotion="user"` is the framework's own answer and it is a
            context: it reaches every `motion` component under it — the
            storefront, the auth pages, the admin — without each one asking. It
            suppresses transform and layout animation and keeps opacity and
            colour, which is the distinction the preference is actually about.
          */}
          <MotionConfig reducedMotion="user">
            {children}
            <Toaster position="bottom-right" richColors closeButton />
          </MotionConfig>
        </SiteThemeProvider>
      </ThemeProvider>
    </ConvexBetterAuthProvider>
  );
}
