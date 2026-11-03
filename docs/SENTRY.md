# Sentry — error monitoring for this site

> **This site reports to its own Sentry project.** Its errors, its event quota
> and its retention belong to it, and follow it if it changes provider — like
> its Convex deployment, its S3 bucket and its Stripe account.

Nothing is shared with another restaurant, and nothing is shared with BeYours.

## Until you set the DSN, nothing is reported

With `NEXT_PUBLIC_SENTRY_DSN` empty, Sentry never initialises: no transport, no
data leaving the site, no cost. That is the state a freshly created site is in.

It also means a production error is seen by nobody. Do this before the first
real customer.

## Setup, once

1. **Create a Sentry project** under **your own** Sentry account
   ([sentry.io](https://sentry.io)). Platform **Next.js**. Name it after the
   restaurant.
2. **Copy the DSN** — it looks like
   `https://<key>@o123456.ingest.de.sentry.io/7891011`. Sentry shows it right
   after project creation, and later under *Settings → Projects → … → Client
   Keys (DSN)*.
3. **Put it in `.env.local`**, or answer the `Sentry (monitoring)` question in
   `pnpm env:setup`:

   ```
   NEXT_PUBLIC_SENTRY_DSN=https://…@….ingest.de.sentry.io/…
   ```

4. **Add it on the host too** (Vercel → Settings → Environment Variables).
   It is a `NEXT_PUBLIC_` variable, so it is baked in when the site is built:
   adding it after a deploy changes nothing until the next build.
5. **Redeploy, then check.** Break something on purpose — visit a page that
   fails, or use Sentry's own test button — and confirm the event lands in the
   project within a minute. `pnpm env:check` verifies the variables are
   consistent; it cannot tell you Sentry received anything.

## Readable stack traces (recommended)

Without source maps, a production error reads `a.b is not a function` at
`page-4f2c.js:1`. Three more variables fix that, read when the site is
**built** — all three or none:

```
SENTRY_ORG=<your org slug>
SENTRY_PROJECT=<your project slug>
SENTRY_AUTH_TOKEN=<org auth token with project:releases>
```

`SENTRY_AUTH_TOKEN` is a secret: set it on the host (or in CI), never in a
`NEXT_PUBLIC_` variable and never in git. Half of the three configured and the
site refuses to boot, naming what is missing — that is deliberate: half of it
uploads nothing while looking configured.

## Optional settings

| Variable | Effect |
| --- | --- |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | Names the environment. On Vercel this is automatic — preview deploys already file their errors away from production. |
| `NEXT_PUBLIC_SENTRY_RELEASE` | Pins the release. Defaults to the deployed commit. |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `0` to `1`, defaults to **0.1** in production. Performance tracing only — errors are always reported in full. At 1.0 a busy service spends the free-tier quota on traces, and Sentry then drops what follows. |

## What is not sent

A checkout carries customer names, addresses and phone numbers, and none of it
belongs in a monitoring tool. Three protections are always on and are not
configurable from here:

- **No IP address, no user identity** on any event.
- **Request headers are filtered to an allowlist** — `host`, `user-agent`,
  `accept`, `accept-language`, `content-type`, `content-length`. Everything
  else, `cookie` and `authorization` included, is dropped before the event
  leaves the server. Cookies are emptied separately.
- **Tokens in URLs are redacted** — `?token=`, `?code=`, `?secret=` and similar
  become `[Filtered]`, so a password-reset link or an order-tracking link never
  reaches the project intact.

Session Replay — which records the screen — is not enabled.
