import { createEmailRouteHandler } from "@be-yours/core"

// EMAIL_API_SECRET is the dedicated credential for this route; BETTER_AUTH_SECRET
// is a transitional fallback so deployments that predate the split keep sending.
// Whichever is used, convex/auth.ts must present the SAME one — they are two
// halves of one handshake, in two different runtimes.
//
// `||`, NOT `??`. `.env.example` ships the key as a bare `EMAIL_API_SECRET=`, and
// the setup wizard copies it into `.env.local` as it stands: an empty string,
// which `??` keeps. The route then authenticated against `""`, refused every
// request with « Email route not configured », and no password-reset or
// verification mail could leave — on a site whose BETTER_AUTH_SECRET was set
// and fine. Blank means unset here, as it does to anyone reading the file.
//
// No `!` here on purpose: an absent secret must reach the handler's own guard,
// which refuses every request, rather than being asserted away.
const { POST } = createEmailRouteHandler({
  secret: process.env.EMAIL_API_SECRET || process.env.BETTER_AUTH_SECRET || "",
  linkOrigin: process.env.SITE_URL,
})

export { POST }
