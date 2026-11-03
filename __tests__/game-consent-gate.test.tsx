// @vitest-environment jsdom

/**
 * The game does not start until the diner has agreed to it (RGPD art. 7.1).
 *
 * `gamePlay.play` refuses without a consent version, and that refusal is the
 * one that counts — but a server that refuses a screen that never asked is a
 * broken game, not a compliant one. This renders the real welcome screen and
 * checks the two halves the server cannot see: that the box starts unticked,
 * and that nothing gets past it until it is ticked.
 */

import type React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WelcomeScreen } from "@be-yours/admin/game"
import { gameConsentNotice } from "@be-yours/admin/game"

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock("framer-motion", async () => {
  const react = await import("react")
  const passthrough = (tag: string) =>
    // Strip the animation props so jsdom renders plain elements.
    function Passthrough(props: Record<string, unknown>) {
      const {
        variants: _v,
        initial: _i,
        animate: _a,
        transition: _t,
        whileTap: _w,
        ...rest
      } = props
      const { children, ...attrs } = rest as { children?: React.ReactNode }
      return react.createElement(tag, attrs, children)
    }
  return {
    motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function render(
  consentAccepted: boolean,
  onConsentChange: (accepted: boolean) => void = () => {},
  onStart: () => void = () => {}
) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <WelcomeScreen
        title="Tentez votre chance !"
        gameType="wheel"
        prizes={[]}
        hasActions={false}
        consent={gameConsentNotice({ storeName: "Pizzeria Napoli", retentionDays: 1095 })}
        consentAccepted={consentAccepted}
        onConsentChange={onConsentChange}
        onStart={onStart}
      />
    )
  })
  return container!
}

describe("the consent gate on the game's welcome screen", () => {
  test("starts unticked, and says who is collecting what", () => {
    const dom = render(false)
    const box = dom.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(box, "the welcome screen has no consent checkbox").not.toBeNull()
    // A pre-ticked box is the textbook example of what art. 4.11 does not
    // count as consent.
    expect(box!.checked).toBe(false)
    expect(dom.textContent).toContain("Pizzeria Napoli")
    expect(dom.textContent).toContain("3 ans")
  })

  test("the play button is unusable until the box is ticked", () => {
    const dom = render(false)
    const button = dom.querySelector("button")
    expect(button!.hasAttribute("disabled")).toBe(true)
  })

  test("clicking through anyway starts nothing", () => {
    // The disabled attribute is presentation. This is the guard behind it: if
    // the styling ever drifts, the screen still must not start a play that the
    // server is about to refuse.
    const started: string[] = []
    const dom = render(false, () => {}, () => started.push("start"))
    act(() => {
      dom.querySelector("button")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      )
    })
    expect(started).toEqual([])
  })

  test("ticking it enables the play button", () => {
    const dom = render(true)
    expect(dom.querySelector("button")!.hasAttribute("disabled")).toBe(false)
    expect(dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(
      true
    )
  })

  test("the tick is reported up, not kept in the screen", () => {
    // The play mutation is fired from the flow, several screens later, so the
    // answer has to leave this component or it is lost by the time it matters.
    const changes: boolean[] = []
    const dom = render(false, (next) => {
      changes.push(next)
    })
    act(() => {
      const box = dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      box.click()
    })
    expect(changes).toEqual([true])
  })
})
