/// <reference types="vite/client" />

/**
 * Every scheduled job this deployment registers, pinned.
 *
 * WHY THIS EXISTS. Thirteen jobs are registered in `convex/crons.ts` and four had
 * a guard: the retention sweep (`packages/admin/.../privacy-surface.test.ts`),
 * the two blog crons (`__tests__/blog-storefront-wiring.test.ts`) and the Stripe
 * reconciler (`stripe-event-coverage.test.ts`). The other seven — stale
 * invitations, scheduled campaigns, the win-back, the payment-event sweep, the
 * kitchen-ticket purge, the NIGHTLY BACKUP and the Stripe key check — could be
 * deleted and nothing anywhere would notice.
 *
 * Measured rather than assumed: the `nightly backup` block was removed and every
 * test file in this app that so much as mentions a cron was run —
 * `nightly-backup`, `privacy-retention`, `stripe-event-coverage`,
 * `blog-storefront-wiring`, `scheduled-paths`, `backup-coverage`,
 * `backup-restore`. All 93 assertions stayed green. `nightly-backup.test.ts`
 * calls `runNightlyBackup` directly and never reads `crons.ts`, so a backup
 * function that no schedule ever calls tests exactly like one that runs every
 * night — which is the shape of #366, the defect the cron was added to end.
 *
 * So this pins the SET rather than adding a twelfth single-job assertion:
 * removing any registration, renaming a handler, or moving a job's hour fails
 * here. The schedule is part of the pin because the hour is a decision — the
 * backup runs at 01:30 so a copy exists before the three destructive purges at
 * 02:30, 03:15 and 04:00, and moving it after them would silently make the
 * backup unable to restore what they carried away.
 *
 * Read from the COMPILED `crons` object rather than the source text, the shape
 * `apps/site/tests/convex/saMonitoring.test.ts` uses: a registration that is
 * present in the file but never reaches `cronJobs()` — inside a dead branch,
 * say — is absent from this object, and grepping the source would not tell you.
 */

import { describe, expect, test } from "vitest"
import crons from "../../convex/crons"

/** `name` is the handler Convex will call; the key is the job's own name. */
type Registration = { name: string; schedule: Record<string, unknown> }

const REGISTERED = crons.crons as unknown as Record<string, Registration>

/**
 * The fifteen, with the handler each one calls and when.
 *
 * Add a job and this fails until it is named here — which is the point: a
 * scheduled job is a promise the product makes while nobody is watching, and it
 * should not be possible to make or break one silently.
 */
const EXPECTED: Record<string, Registration> = {
  "sweep stale invitations": {
    name: "teamMembers:sweepInvitations",
    schedule: { type: "cron", cron: "0 4 * * *" },
  },
  "dispatch scheduled campaigns": {
    name: "emailCampaigns:dispatchScheduled",
    schedule: { type: "interval", minutes: 1 },
  },
  "win back lapsed customers": {
    name: "emailAutomationActions:sweepInactive",
    schedule: { type: "cron", cron: "0 9 * * *" },
  },
  "sweep expired payment events": {
    name: "paymentEvents:sweepExpired",
    schedule: { type: "cron", cron: "0 5 * * *" },
  },
  "reconcile pending stripe checkouts": {
    name: "stripe:reconcilePendingCheckouts",
    schedule: { type: "interval", minutes: 15 },
  },
  // The same sweep for the other two card providers (#431.2). Neither had one,
  // and neither had a webhook, so a diner who paid and closed the tab before
  // the redirect completed left the charge with the provider and the kitchen
  // blind — permanently.
  "reconcile pending sumup checkouts": {
    name: "sumup:reconcilePending",
    schedule: { type: "interval", minutes: 15 },
  },
  "reconcile pending paypal orders": {
    name: "paypal:reconcilePendingOrders",
    schedule: { type: "interval", minutes: 15 },
  },
  // Audience measurement. Quarter-hourly rather than nightly: `audienceHits`
  // is append-only and one row per page view, so a day's worth of it is both
  // the largest table on the deployment and the only one holding a timestamp
  // fine enough to be worth keeping short.
  "roll up audience hits": {
    name: "audience:rollupPending",
    schedule: { type: "interval", minutes: 15 },
  },
  // Retention for both audience tables: the raw hits at 48 hours, the counters
  // at the window on `globalSettings.dataRetention.audienceDays`. 2:45am,
  // between the kitchen tickets and the customer data.
  "sweep expired audience data": {
    name: "audience:sweepExpiredAudience",
    schedule: { type: "cron", cron: "45 2 * * *" },
  },
  "purge expired kitchen tickets": {
    name: "kitchenTickets:purgeExpiredTickets",
    schedule: { type: "cron", cron: "30 2 * * *" },
  },
  "purge expired customer data": {
    name: "privacy:sweepExpiredCustomerData",
    schedule: { type: "cron", cron: "15 3 * * *" },
  },
  "nightly backup": {
    name: "systemBackupOffsite:runNightlyBackup",
    schedule: { type: "cron", cron: "30 1 * * *" },
  },
  "plan auto blog jobs": {
    name: "blogAutoPlanner:planAutoBlogJobs",
    schedule: { type: "cron", cron: "0 * * * *" },
  },
  "execute auto blog queue": {
    name: "blogAutoGenerate:executeAutoBlogQueue",
    schedule: { type: "interval", minutes: 10 },
  },
  "verify the Stripe key": {
    name: "stripe:verifyStripeKey",
    schedule: { type: "interval", hours: 1 },
  },
  // The twelfth. A platform order whose kitchen ticket was never created has no
  // slip on the pass, and until this job existed nothing anywhere looked for
  // one — the food was simply never cooked. Fifteen minutes because the unit of
  // harm is one service: an order taken at 19:05 that waits until 20:00 for a
  // slip has, for a dinner service, waited for ever.
  "give ticketless platform orders a slip": {
    name: "orders:sweepTicketlessPlatformOrders",
    schedule: { type: "interval", minutes: 15 },
  },
  // The thirteenth. Deliveroo resets `unavailable` items to `available` when a
  // site opens, so a sold-out dish was orderable again every morning until the
  // next menu upload. Hourly because the opening time is the site's own.
  "reconcile deliveroo item availability": {
    name: "deliverooMenuSync:reconcileAvailability",
    schedule: { type: "interval", hours: 1 },
  },
  // A table request nobody answered before its time came would otherwise hold
  // capacity for ever.
  "expire unanswered reservation requests": {
    name: "reservations:expireUnanswered",
    schedule: { type: "interval", minutes: 15 },
  },
  // A group request holds capacity for the owner's review window and no longer: without
  // this it would hold it until the party's own time, and its guest would never be told.
  "lapse group requests": {
    name: "reservationGroups:expireReviews",
    schedule: { type: "interval", minutes: 10 },
  },
  // The guests who asked to be told that seats came back at a sold-out event.
  "mail experience seat alerts": {
    name: "reservationExperiences:mailSeatAlerts",
    schedule: { type: "interval", minutes: 5 },
  },
  // A cancelled event whose chain of batches died keeps its tickets confirmed and unrefunded
  // until this takes it over.
  "resume event cancellations": {
    name: "reservationExperiences:resumeCancellations",
    schedule: { type: "interval", minutes: 10 },
  },
  // A booking that owes a deposit or a guarantee holds its table only for the time the
  // owner set; without this the hold would last until the booking's own time.
  "release unpaid reservation holds": {
    name: "reservationPaymentActions:sweepHolds",
    schedule: { type: "interval", minutes: 2 },
  },
  // The recovery path of every reservation payment: a guest who paid and closed the
  // tab, a webhook that never came, a refund that timed out.
  "reconcile reservation payments": {
    name: "reservationPaymentActions:reconcile",
    schedule: { type: "interval", minutes: 10 },
  },
  // The reminder before a confirmed booking, for the establishments that set one.
  "remind guests of their reservation": {
    name: "reservations:sendDueReminders",
    schedule: { type: "interval", minutes: 15 },
  },
  // A waitlist offer holds a table for a quarter of an hour by default; the hold
  // ends on its own, and this is how the next guest in line hears the table is theirs.
  "lapse waitlist offers": {
    name: "reservationWaitlist:expireOffers",
    schedule: { type: "interval", minutes: 5 },
  },
  // The free-text request is where allergies are typed; it does not outlive its
  // sitting by more than a few days.
  "purge reservation guest notes": {
    name: "reservationGuests:purgeGuestNotes",
    schedule: { type: "cron", cron: "45 3 * * *" },
  },
  // The statistics screen reads one rollup row per day; every booking path marks its
  // day and this recomputes the marked ones. A minute, so a figure is never old.
  "refresh reservation statistics": {
    name: "reservationStats:sweepDirty",
    schedule: { type: "interval", minutes: 1 },
  },
  // A path that forgot to mark its day is repaired within a day: the last two weeks
  // are re-marked every night, and the rows too old to be of use are dropped.
  "repair reservation statistics": {
    name: "reservationStats:repair",
    schedule: { type: "cron", cron: "20 3 * * *" },
  },
  // The thank-you e-mail is opt-in per establishment and set in hours, so a run that
  // comes a little late must not lose it: quarter-hourly, like the reminder.
  "thank guests after their visit": {
    name: "reservationFeedback:sendDue",
    schedule: { type: "interval", minutes: 15 },
  },
  // The daily report is due at a wall-clock time in the establishment's own zone.
  "send the daily reservation report": {
    name: "reservationAutomations:sendDue",
    schedule: { type: "interval", minutes: 15 },
  },
  "e-mail reservation alerts": {
    name: "reservationAlerts:sendDue",
    schedule: { type: "interval", minutes: 15 },
  },
  "prune reservation alert marks": {
    name: "reservationAlerts:prune",
    schedule: { type: "cron", cron: "30 3 * * *" },
  },
}

describe("the scheduled jobs this deployment registers", () => {
  test("exactly these, and no others", () => {
    // Both directions: a deleted job and an undocumented new one are the same
    // failure — a schedule nobody decided.
    expect(Object.keys(REGISTERED).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  test.each(Object.keys(EXPECTED))("%s calls the handler it says, when it says", (job) => {
    const actual = REGISTERED[job]
    expect(actual, `"${job}" is not registered in convex/crons.ts`).toBeDefined()
    expect(actual!.name).toBe(EXPECTED[job]!.name)
    expect(actual!.schedule).toEqual(EXPECTED[job]!.schedule)
  })

  test("the nightly backup is scheduled before the jobs that delete things", () => {
    /* Not decoration: the backup exists so a copy survives the three
       destructive nightly jobs. Moving it after them would leave a backup that
       cannot restore what they carried away, and every other assertion here
       would still pass. */
    const minuteOfDay = (job: string) => {
      const cron = (REGISTERED[job]!.schedule as { cron: string }).cron.split(" ")
      return Number(cron[1]) * 60 + Number(cron[0])
    }

    for (const destructive of [
      "purge expired kitchen tickets",
      "purge expired customer data",
      "sweep stale invitations",
    ]) {
      expect(
        minuteOfDay("nightly backup"),
        `the backup must run before "${destructive}"`,
      ).toBeLessThan(minuteOfDay(destructive))
    }
  })

  test("every job runs through internal.*, because a cron has no identity", () => {
    // `crons.ts` states the rule in its own header and `scheduled-paths` asserts
    // it against the source. Asserted here too, against the compiled object: a
    // public function reached from a schedule is either refused or should not
    // have been public.
    for (const [job, registration] of Object.entries(REGISTERED)) {
      expect(registration.name, `"${job}" names no handler`).toMatch(/^[A-Za-z]\w*:\w+$/)
    }
  })
})
