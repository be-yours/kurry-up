import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Scheduled work for a restaurant deployment.
 *
 * A scheduled job runs with NO user identity, so everything referenced here
 * must be `internal.*`. Reaching for `api.*` calls a function that will either
 * refuse the sweep — if it is guarded — or is public and should not be; the
 * nightly menu push already died that way once. `tests/convex/scheduled-paths`
 * asserts the rule against the source.
 */
const crons = cronJobs();

// Expire invitations past their seven days, clear their tokens, and delete the
// ones nobody ever accepted after thirty more. 4am UTC: outside service, and
// away from the 3am hour the commercial site already uses.
crons.cron(
  "sweep stale invitations",
  "0 4 * * *",
  internal.teamMembers.sweepInvitations,
  {},
);

// Start the campaigns whose scheduled time has arrived. `schedule` wrote a
// status and a date, the wizard offered a picker, and nothing ever read either:
// a scheduled campaign sat at `scheduled` for good and the only way to send was
// the manual menu item. Every minute, because a campaign timed for 18:00 that
// goes out at 18:05 is a different promise than the owner made.
crons.interval(
  "dispatch scheduled campaigns",
  { minutes: 1 },
  internal.emailCampaigns.dispatchScheduled,
  {},
);

// Start the win-back for customers who have gone quiet. Daily at 9am UTC: a
// "you have not been in a while" landing at 4am reads as a machine, and the
// sweep is cheap — it only walks stores that actually have such an automation.
crons.cron(
  "win back lapsed customers",
  "0 9 * * *",
  internal.emailAutomationActions.sweepInactive,
  {},
);

// Drop the provider webhook deliveries whose 30-day replay window has closed.
// The table is a deduplication window, not an audit log: nothing retries a
// webhook for anywhere near that long, and without a sweep it only grows.
// 5am UTC, between the invitation sweep and the win-back, so the three nightly
// jobs do not land on the same minute.
crons.cron(
  "sweep expired payment events",
  "0 5 * * *",
  internal.paymentEvents.sweepExpired,
  {},
);

// Ask Stripe about the checkouts that never came back paid.
//
// Every other path that marks an order paid is a message we have to RECEIVE:
// the guest landing on the confirmation page, or a webhook delivery. A customer
// who pays and closes the tab sends neither, and if the delivery is lost too the
// charge sits in Stripe behind an order at "pending" — money taken, kitchen
// blind, and nothing anywhere that would ever notice.
//
// Every fifteen minutes rather than nightly: the gap between the charge and the
// kitchen seeing the order is the whole cost of the defect, and a customer who
// paid at 19:40 cannot wait until 5am. The sweep reads one index range and does
// nothing at all when it is empty, which is almost always.
crons.interval(
  "reconcile pending stripe checkouts",
  { minutes: 15 },
  internal.stripe.reconcilePendingCheckouts,
  {},
);

// The same sweep for the other two card providers (#431.2).
//
// Neither had one, and neither had a webhook either — so a diner who paid with
// SumUp or approved with PayPal and closed the tab before the redirect
// completed left the charge with the provider, the order at `pending` and the
// kitchen blind. Permanently, not for fifteen minutes: no path in the product
// ever asked again.
//
// Both return `{ examined: 0 }` immediately on a deployment that does not take
// that provider, which is most of them — the cost of registering them here is a
// connection lookup every quarter of an hour.
//
// The PayPal one also CAPTURES. An approval is not a payment: left uncaptured
// it expires, and the restaurant is paid nothing for a meal it has cooked.
crons.interval(
  "reconcile pending sumup checkouts",
  { minutes: 15 },
  internal.sumup.reconcilePending,
  {},
);

crons.interval(
  "reconcile pending paypal orders",
  { minutes: 15 },
  internal.paypal.reconcilePendingOrders,
  {},
);

// Delete kitchen tickets finished more than 30 days ago. The KDS reads are
// bounded now, but a bound on the read only moves the problem: the table still
// grows without limit and the completed history becomes unreadable. 2:30am UTC
// — clear of the invitation sweep at 4am, and outside service everywhere.
// The job reschedules itself a minute later while there is more to delete.
crons.cron(
  "purge expired kitchen tickets",
  "30 2 * * *",
  internal.kitchenTickets.purgeExpiredTickets,
  {},
);

// Carry away the personal data that has outlived the retention window — the
// diner's, not the establishment's. 3:15am UTC: clear of the kitchen-ticket
// purge at 2:30 and the invitation sweep at 4:00, so the three destructive
// nightly jobs never share a minute or a transaction budget.
//
// An order past the window is ANONYMISED, never deleted: it is the
// establishment's accounting record and art. L123-22 of the Code de commerce
// wants ten years of it. A game play, a contact message and a saved address
// are deleted outright — none of them is one. The window itself lives in
// `globalSettings.dataRetention` and defaults to the CNIL's three years.
// Fold the storefront's raw audience hits into the daily counters the
// « Fréquentation » screen reads, then delete what was folded. Every fifteen
// minutes rather than nightly: the raw table is append-only and one row per
// page view, so leaving a day's worth of it lying about is both the largest
// table on the deployment and the only one holding a timestamp fine enough to
// be worth keeping short. The job reschedules itself a minute later while
// there is more.
crons.interval(
  "roll up audience hits",
  { minutes: 15 },
  internal.audience.rollupPending,
  {},
);

// Retention for both audience tables. The raw hits at 48 hours — the floor
// under a rollup that died halfway, which is what `audienceHits.by_at` exists
// for — and the daily counters at the window in
// `globalSettings.dataRetention.audienceDays`, defaulting to the CNIL's
// 25-month ceiling. Neither table holds personal data, so this is a condition
// of the consent exemption « Fréquentation » relies on rather than an
// art. 5.1.e obligation; `dataRetention.enabled: false` pauses it all the same.
// 2:45am UTC — between the kitchen-ticket purge at 2:30 and the customer-data
// purge at 3:15, so the destructive nightly jobs never share a minute or a
// transaction budget.
crons.cron(
  "sweep expired audience data",
  "45 2 * * *",
  internal.audience.sweepExpiredAudience,
  {},
);

crons.cron(
  "purge expired customer data",
  "15 3 * * *",
  internal.privacy.sweepExpiredCustomerData,
  {},
);

// The nightly backup. Every table the export carries, written to the client's
// own S3 bucket under `backups/`, kept 30 days by a lifecycle rule.
//
// `grep backup` in this file returned nothing until now, and `exportBackup`'s
// only caller was a button that downloaded a Blob to whatever laptop the
// administrator was sitting at — while the maintenance fee was sold on
// « Sauvegardes automatiques quotidiennes de vos données et contenus » (#366).
//
// 1:30am UTC, and the hour is chosen rather than free: it is before the three
// destructive nightly jobs (kitchen tickets at 2:30, customer data at 3:15,
// invitations at 4:00), so a copy exists of what they are about to carry away.
// A backup taken after the purge cannot restore what the purge removed.
crons.cron(
  "nightly backup",
  "30 1 * * *",
  internal.systemBackupOffsite.runNightlyBackup,
  {},
);

// Queue the articles an Auto Blog subscription is due. Hourly, because
// `preferredHour` is an hour: the planner asks each configuration whether this
// is its hour in its own timezone, and writes a queue row if it is. It calls
// no paid API — a sweep that finds nothing costs one indexed read.
crons.cron(
  "plan auto blog jobs",
  "0 * * * *",
  internal.blogAutoPlanner.planAutoBlogJobs,
  {},
);

// Generate what the planner queued. Every 10 minutes rather than hourly: an
// article scheduled for 09:00 that appears at 09:55 is not the promise the
// owner configured, and a generation that fails still has its retries inside
// the hour. The spec asks for 5-15 minutes (tasks/auto-blog-spec.md §4.2).
crons.interval(
  "execute auto blog queue",
  { minutes: 10 },
  internal.blogAutoGenerate.executeAutoBlogQueue,
  {},
);

// Ask Stripe whether this deployment's key still works, and record the answer.
// The checkout's card tile is armed from that verdict, so a key revoked or
// rolled takes the tile down rather than sending every diner into the redacted
// error #374 removed (#411).
//
// HOURLY, and that is about RECOVERY rather than detection. Detection is
// cheap: the first checkout attempt after a key goes bad reports it for free.
// Recovery is not — once the verdict disarms the tile no diner can reach the
// checkout, so the checkout cannot be what discovers the key has been put
// right, and this is the only writer left. Nightly meant an operator who fixed
// a key at 09:00 had no card payments until the next small hours. One Stripe
// call an hour is nothing; a day without cards is not.
crons.interval(
  "verify the Stripe key",
  { hours: 1 },
  internal.stripe.verifyStripeKey,
  {},
);

// A platform order whose kitchen ticket was never created has no slip on the
// pass: no screen, no printer, and the accept button unreachable because it
// acts on a ticket. The food is never cooked and nobody is told.
//
// The Uber Eats and Deliveroo webhooks now repair this themselves when the
// platform redelivers, which is the fast path and usually enough. This is the
// backstop for when it is not — a platform that retries once and gives up, a
// failure that outlives the retry window — and until it existed, NONE of the
// eleven other jobs looked for a ticketless order at all.
//
// Every fifteen minutes, because the unit of harm is one service. Hourly would
// mean an order taken at 19:05 waiting until 20:00 for a slip, which for a
// dinner service is the same as never.
crons.interval(
  "give ticketless platform orders a slip",
  { minutes: 15 },
  internal.orders.sweepTicketlessPlatformOrders,
  {},
);

// Re-push the stock state of every Deliveroo store. Deliveroo resets items marked
// `unavailable` back to `available` when a site opens, so a dish the kitchen had
// run out of was orderable again each morning, until the next menu upload. Hourly
// because the opening time is the site's own and moves per establishment and per
// day; a store with no stock-tracked product costs one empty action and no call.
crons.interval(
  "reconcile deliveroo item availability",
  { hours: 1 },
  internal.deliverooMenuSync.reconcileAvailability,
  {},
);

// Close the table requests nobody answered before their time came. A `pending`
// booking whose start has passed holds capacity for a party that was never
// confirmed and sits in the day book as a question nobody can still answer.
// Quarter-hourly, like the other sweeps: the unit of harm is one service, and
// the sweep reads one index range, empty on most runs.
crons.interval(
  "expire unanswered reservation requests",
  { minutes: 15 },
  internal.reservations.expireUnanswered,
  {},
);

// Let the group requests nobody answered go, and tell their guests. A request holds
// capacity for the review window the owner set (`reservationGroupPolicy.reviewHours`),
// so ten minutes is an imprecision of minutes on a window of hours; the sweep reads one
// indexed range, empty on most runs, and reschedules itself while a backlog remains.
crons.interval(
  "lapse group requests",
  { minutes: 10 },
  internal.reservationGroups.expireReviews,
  {},
);

// Tell the guests who asked to be told that seats came back at a sold-out event. Five
// minutes: seats come back one cancellation at a time, and a guest told an hour later has
// usually lost them. One mail per entry, claimed before it is scheduled.
crons.interval(
  "mail experience seat alerts",
  { minutes: 5 },
  internal.reservationExperiences.mailSeatAlerts,
  {},
);

// Resume the cancellations of events whose chain of batches died: a batch that fails ends the
// chain, and the tickets it had not reached would stay confirmed and unrefunded. The sweep reads
// one indexed range (empty on most runs) and only takes an event whose last batch is five minutes old.
crons.interval(
  "resume event cancellations",
  { minutes: 10 },
  internal.reservationExperiences.resumeCancellations,
  {},
);

// Release the tables of bookings whose guest never paid. A booking that owes a
// deposit or a card guarantee is held for the time the owner set
// (`reservationPaymentPolicy.holdMinutes`, five minutes to an hour). Every two
// minutes, because a hold of five minutes that is released at the next quarter hour
// is a hold of fifteen — and the sweep reads one index range, empty on most runs.
// Before a booking is expired, its open payment pages are read back: a guest who paid
// in the last seconds settles it instead of losing it.
crons.interval(
  "release unpaid reservation holds",
  { minutes: 2 },
  internal.reservationPaymentActions.sweepHolds,
  {},
);

// Ask the providers about every payment still open and every refund still
// unconfirmed. SumUp and PayPal have no webhook here, so for them this is the
// confirmation of a guest who paid and did not come back; for Stripe it is the net
// under a lost webhook, a fee whose answer was lost and a refund that timed out.
crons.interval(
  "reconcile reservation payments",
  { minutes: 10 },
  internal.reservationPaymentActions.reconcile,
  {},
);

// Remind the guests of confirmed bookings, for the establishments that chose to
// (`reservationSettings.reminderHoursBefore`; none by default). Quarter-hourly:
// the reminder is set in hours and a run that comes a little late must not lose
// it, so each run looks at the few hours whose reminder moment is now.
crons.interval(
  "remind guests of their reservation",
  { minutes: 15 },
  internal.reservations.sendDueReminders,
  {},
);

// Let the waitlist offers nobody took lapse, and offer their tables to the next in
// line. Five minutes, because the offer is held for a quarter of an hour by default:
// the hold ends on its own at its time, and this is only how the NEXT guest finds
// out a table is theirs.
crons.interval(
  "lapse waitlist offers",
  { minutes: 5 },
  internal.reservationWaitlist.expireOffers,
  {},
);

// Erase the free-text request of the bookings whose sitting ended a few days ago.
// That field is where allergies are typed — health data, of use to the kitchen for
// the service and to nobody after it. Daily: the index only holds the rows that
// are due.
crons.cron(
  "purge reservation guest notes",
  "45 3 * * *",
  internal.reservationGuests.purgeGuestNotes,
  {},
);

// Recompute the statistics days that a booking path marked. Every minute, because the
// screen reads rollup rows and a figure should not be old: the sweep reads one indexed
// range, empty on most runs, and reschedules itself while marked days remain.
crons.interval(
  "refresh reservation statistics",
  { minutes: 1 },
  internal.reservationStats.sweepDirty,
  {},
);

// Re-mark the last two weeks of every book and drop the statistics rows too old to be of
// use, so a booking path that forgot to mark its day is repaired within a day.
crons.cron(
  "repair reservation statistics",
  "20 3 * * *",
  internal.reservationStats.repair,
  {},
);

// Thank the guests of sittings completed a few hours ago, for the establishments that
// turned the e-mail on (`reservationAutomations.postVisitEnabled`; none by default).
// Quarter-hourly: the delay is set in hours and a run that comes late must not lose it.
crons.interval(
  "thank guests after their visit",
  { minutes: 15 },
  internal.reservationFeedback.sendDue,
  {},
);

// Send the daily report of the book to the establishments that asked for one, at the
// wall-clock time each chose in its own zone. Quarter-hourly, like the reminder: the
// time is a wall-clock time, and a run that comes late must not lose the day's report.
crons.interval(
  "send the daily reservation report",
  { minutes: 15 },
  internal.reservationAutomations.sendDue,
  {},
);

// E-mail the alerts of the book to the establishments that turned alert e-mails on.
crons.interval(
  "e-mail reservation alerts",
  { minutes: 15 },
  internal.reservationAlerts.sendDue,
  {},
);

// Drop the marks of alerts whose cause is over (read or e-mailed).
crons.cron(
  "prune reservation alert marks",
  "30 3 * * *",
  internal.reservationAlerts.prune,
  {},
);

export default crons;
