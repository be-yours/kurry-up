export { useCmsPage } from "./useCmsPage"
export type { CmsFieldAccessor, CmsBlockAccessor, UseCmsPageResult } from "./useCmsPage"

// Server-side helper — import from "@/lib/cms/server" directly in Server Components
// (not re-exported here to avoid "server-only" import in client bundles)
