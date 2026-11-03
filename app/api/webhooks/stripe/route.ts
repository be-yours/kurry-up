import { NextResponse } from "next/server"

/**
 * Stripe webhooks are now handled by the Convex HTTP endpoint at /webhooks/stripe.
 * Configure your Stripe webhook URL to point to your CONVEX_SITE_URL/webhooks/stripe.
 * This Next.js route is kept as a fallback that returns a redirect hint.
 */
export async function POST() {
  return NextResponse.json(
    { error: "Stripe webhooks are handled by Convex. Update your webhook URL to CONVEX_SITE_URL/webhooks/stripe" },
    { status: 410 }
  )
}
