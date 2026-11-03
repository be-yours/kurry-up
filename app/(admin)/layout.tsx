"use client"

import { resolveBrandName } from "@/lib/cms/brand-name"
import "@/lib/cms/init"
import { useEffect } from "react"
import { api } from "@/convex/_generated/api"
import { AdminAuthSync } from "@/components/admin/AdminAuthSync"
import { useCmsPage } from "@/lib/cms/useCmsPage"
import {
  AuthGuard,
  AdminTheme,
  AppSidebar,
  AdminHeader,
  SidebarProvider,
  SidebarInset,
  StoreSelector,
  SidebarUserMenu,
  StoreGuard,
  useAdminApiStore,
  useAdminStoreId,
  OnboardingTourProvider,
  ReplayTourButton,
} from "@be-yours/admin"

function AdminLayoutInner({ children }: { children: React.ReactNode }) {
  // The branding shown in the admin follows the establishment being
  // administered, not the one a customer tab happens to be browsing.
  const adminStoreId = useAdminStoreId()
  const cms = useCmsPage("storefront-layout", { storeId: adminStoreId })
  const logoUrl = cms.block("branding").field("logo").mediaUrl
  /* The same chain the storefront header uses (#613), so the sidebar and the
     public site cannot disagree about whose restaurant this is. No store name
     here: the sidebar sits beside a `StoreSelector` that already names the
     establishment, and this is the CMS brand. `undefined` rather than `""`
     when nothing resolves, because the sidebar draws its own default for an
     absent name and an empty string is not absent. */
  const brandName =
    resolveBrandName({
      branding: cms.block("branding").field("brandName").text,
      legacyHeader: cms.block("header").field("brandName").text,
    }) || undefined

  return (
    <SidebarProvider>
      {/*
        The establishment's own palette, on the dashboard. Mounted here rather
        than in the root layout because it needs `useAdminStore`, which only
        answers inside the admin tree — and because these are the pages whose
        tokens `buildBrandingCss` derives. See the component's own note for why
        it passes no `scopes` where the storefront must.
      */}
      <AdminTheme />
      <AppSidebar
        userFooter={
          <>
            <ReplayTourButton />
            <SidebarUserMenu />
          </>
        }
        logoUrl={logoUrl}
        brandName={brandName}
      />
      <SidebarInset>
        <AdminHeader storeSelector={<StoreSelector />} />
        {/*
          A div, not a <main>: `SidebarInset` already renders the page's `main`
          landmark, and nesting a second one inside it is invalid HTML — a page
          has exactly one. Assistive technology was announcing two, and
          Playwright's `getByRole("main")` resolved to both, which is how it
          surfaced.
        */}
        {/*
          `overflow-x-clip`, not `hidden`: `hidden` on one axis makes the other `auto`, which turns
          this block into a scroll container that never scrolls — and a `position: sticky` bar
          inside it (the settings screen's section bar) then sticks to nothing. `clip` keeps a
          wide child from pushing the page sideways without creating one.
        */}
        <div className="flex-1 px-6 py-5 lg:px-8 min-w-0 overflow-x-clip" data-tour="main-content">
          <div className="mx-auto max-w-[1600px]">
            <StoreGuard>{children}</StoreGuard>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  useEffect(() => {
    useAdminApiStore.getState().setApi(api as unknown as Record<string, unknown>)
  }, [])

  return (
    <>
      <AdminAuthSync />
      <AuthGuard>
        <OnboardingTourProvider>
          <AdminLayoutInner>{children}</AdminLayoutInner>
        </OnboardingTourProvider>
      </AuthGuard>
    </>
  )
}
