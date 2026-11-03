/**
 * Deliveroo menu webhooks are now handled by the Convex HTTP endpoint.
 * Configure Deliveroo to send webhooks to: {CONVEX_SITE_URL}/webhooks/deliveroo
 *
 * This route is kept as a fallback that returns 410 Gone.
 */
export async function POST() {
  return new Response(
    JSON.stringify({ error: "Moved to Convex HTTP endpoint: /webhooks/deliveroo" }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  )
}
