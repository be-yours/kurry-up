// PATCH BOILERPLATE vs engine: metadata + fonts + theme + layout + color
// scheme come from the site zone (site.config.ts, site/fonts.ts,
// site/theme.css, site/layout.ts), and the site's own browser-side code
// (site/components/SiteEffects.tsx) is handed to the engine's
// SiteEffectsSlot. All other logic must stay identical to the engine (see
// docs/UPDATES.md § Patched files).
import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import "@/site/theme.css";
import { Providers } from "./providers";
import { SiteEffectsSlot } from "@/components/site-effects-slot";
import { siteConfig } from "@/site.config";
import { fontVariables } from "@/site/fonts";
import { siteLayout } from "@/site/layout";
import { SiteEffects } from "@/site/components/SiteEffects";
import { layoutAttributes } from "@/lib/layout-families";
import { siteIconsMetadata } from "@/lib/site-icons";
import { readSiteTheme } from "@/lib/site-theme";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: siteConfig.titleTemplate,
  },
  description: siteConfig.description,
  // The tab icons come from the site zone (`site.config.ts` → `icons`). The
  // engine used to ship `app/favicon.ico`, and Next gives a file-based icon
  // priority over this very field, so a site's own icon could never win.
  icons: siteIconsMetadata(siteConfig),
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const lang = cookieStore.get("beid_locale")?.value || siteConfig.defaultLocale;

  return (
    // The layout families go on `<html>`, as they do in the demo engine this
    // catalogue is generated from (#507). Every RULE that reads one is confined
    // to `.storefront-theme` in globals.css — `<html>` is the administration's
    // ancestor too, and a template must not repaint the dashboard. That is the
    // lesson #410 and #41 cost, applied one layer up.
    <html
      lang={lang}
      suppressHydrationWarning
      className={fontVariables}
      {...layoutAttributes(siteLayout)}
    >
      <body className="antialiased">
        {/* The color scheme is read here, not in `providers.tsx`: that file is
            the engine's and is identical in the bench, which has no site.config.ts. */}
        <Providers theme={readSiteTheme(siteConfig)}>{children}</Providers>
        {/*
          The site's own browser-side code, mounted once for the whole site.
          The slot renders it after hydration and never in the administration,
          and adds no markup of its own. The component is the site's
          (site/components/SiteEffects.tsx) and ships empty.
        */}
        <SiteEffectsSlot>
          <SiteEffects />
        </SiteEffectsSlot>
      </body>
    </html>
  );
}
