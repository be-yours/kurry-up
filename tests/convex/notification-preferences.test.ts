// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The account "Préférences" tab was inert.
 *
 * The apply button carried no `onClick`. The customer moved the switches,
 * pressed "Appliquer les préférences", and nothing was sent anywhere — no
 * request, no error, no feedback. On the next visit the switches read back the
 * hard-coded initial state, so the choice had never existed.
 *
 * Nothing behind it existed either: `notificationPreferences` was absent from
 * the schema, from `updateProfile` and from `updateMyProfile`. These tests run
 * the real mutation against the real schema and read the row back, so they
 * assert what is in the database rather than what a spy was handed.
 *
 * What these tests cover, and what they no longer imply: the account screen
 * now offers the email channel only. The SMS switch was removed because the
 * engine sends no SMS — no provider, no sender, no job — so the preference was
 * collected and honoured by nothing. The mutation and the column are unchanged
 * and are what is asserted here: `sms` is still accepted, still stored, still
 * required as half of the pair, and the screen passes the stored value back
 * untouched rather than resetting a choice it no longer displays. A future SMS
 * channel inherits a contract that already works; none of these cases asserts
 * that a customer is offered the choice.
 */

import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import { api } from "../../convex/_generated/api"
import schema from "../../convex/schema"

const modules = import.meta.glob("../../convex/**/*.ts")

const DINER = { subject: "user:diner", issuer: "https://test", tokenIdentifier: "test|diner" }

function harness() {
  const t = convexTest(schema, modules)
  return { t, as: t.withIdentity(DINER) }
}

describe("notification preferences", () => {
  test("survive the round trip the apply button makes", async () => {
    const { as } = harness()

    await as.mutation(api.userProfiles.updateMyProfile, {
      notificationPreferences: { email: false, sms: true },
    })

    const profile = await as.query(api.userProfiles.getMyProfile, {})
    expect(profile?.notificationPreferences).toEqual({ email: false, sms: true })
  })

  test("are stored per person, not shared", async () => {
    const { t, as } = harness()
    const other = t.withIdentity({
      subject: "user:other",
      issuer: "https://test",
      tokenIdentifier: "test|other",
    })

    await as.mutation(api.userProfiles.updateMyProfile, {
      notificationPreferences: { email: false, sms: true },
    })
    await other.mutation(api.userProfiles.updateMyProfile, {
      notificationPreferences: { email: true, sms: false },
    })

    expect((await as.query(api.userProfiles.getMyProfile, {}))?.notificationPreferences).toEqual({
      email: false,
      sms: true,
    })
    expect((await other.query(api.userProfiles.getMyProfile, {}))?.notificationPreferences).toEqual({
      email: true,
      sms: false,
    })
  })

  test("can be turned off entirely, and stay off", async () => {
    // `{email:false, sms:false}` is a real choice, and the shape most likely to
    // be lost by a reader that treats falsy as "unset".
    const { as } = harness()

    await as.mutation(api.userProfiles.updateMyProfile, {
      notificationPreferences: { email: false, sms: false },
    })

    const profile = await as.query(api.userProfiles.getMyProfile, {})
    expect(profile?.notificationPreferences).toEqual({ email: false, sms: false })
  })

  test("are left alone by an update that does not mention them", async () => {
    const { as } = harness()

    await as.mutation(api.userProfiles.updateMyProfile, {
      notificationPreferences: { email: false, sms: true },
    })
    await as.mutation(api.userProfiles.updateMyProfile, { language: "en" })

    const profile = await as.query(api.userProfiles.getMyProfile, {})
    expect(profile?.notificationPreferences).toEqual({ email: false, sms: true })
    expect(profile?.language).toBe("en")
  })

  test("are absent, not false, on a profile that predates the field", async () => {
    // The account screen applies the defaults to this case. Absence must not be
    // read as a refusal of every channel, and must not be written back as one.
    const { as } = harness()

    await as.mutation(api.userProfiles.updateMyProfile, { language: "fr" })

    const profile = await as.query(api.userProfiles.getMyProfile, {})
    expect(profile?.notificationPreferences).toBeUndefined()
  })

  test("refuse a half-submitted pair", async () => {
    const { as } = harness()

    await expect(
      as.mutation(api.userProfiles.updateMyProfile, {
        // @ts-expect-error - the validator requires both channels together.
        notificationPreferences: { email: true },
      }),
    ).rejects.toThrow()
  })
})
