import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * `create-site.mjs` is the one-shot delivery path — `beyours create` pipes it
 * straight from the boilerplate. It clones, then hands the configuration to
 * `init.mjs`, and every option the handover needs has to survive that hop.
 *
 * The licence pair did not: `init.mjs` accepted `--license-key` and
 * `--license-api`, `create-site.mjs` never forwarded them, and the sentinel of
 * a site created the documented way carried no key. `pnpm update:engine` then
 * asked nothing — the third row of the table in
 * `tasks/license-key-registration-runbook.md`, the state no enforcement
 * setting can refuse. This runs the real script against a throwaway
 * boilerplate and reads the sentinel it leaves.
 */

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(SCRIPTS, "..")

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })

/** The smallest tree init.mjs will accept: its inputs, and one template. */
function makeBoilerplate(dir) {
  fs.mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true })
  fs.mkdirSync(path.join(dir, "site"), { recursive: true })
  // The neutral template is what init.mjs applies when none is asked for,
  // and `listTemplates` only lists a directory that carries a template.json.
  fs.cpSync(path.join(ROOT, "templates", "default"), path.join(dir, "templates", "default"), {
    recursive: true,
  })
  for (const file of ["create-site.mjs", "init.mjs", "apply-template.mjs", "add-mobile.mjs"]) {
    fs.copyFileSync(path.join(SCRIPTS, file), path.join(dir, "scripts", file))
  }
  fs.copyFileSync(
    path.join(SCRIPTS, "lib", "design-brief.mjs"),
    path.join(dir, "scripts", "lib", "design-brief.mjs"),
  )
  // A catalogue template that is not the neutral one, so "applied as the
  // starting point" can be told apart from "nothing applied".
  const mini = path.join(dir, "templates", "mini")
  fs.mkdirSync(mini, { recursive: true })
  fs.writeFileSync(
    path.join(mini, "template.json"),
    JSON.stringify({
      slug: "mini",
      label: "Mini",
      description: "A fixture template.",
      // The catalogue sells five templates under a name that is not their
      // directory's; this is one of them.
      aliases: ["mini-sold"],
    }),
  )
  fs.writeFileSync(path.join(mini, "theme.css"), "/* mini */\n")
  fs.writeFileSync(path.join(mini, "fonts.ts"), "export const fonts = { mini: true }\n")
  fs.writeFileSync(path.join(mini, "layout.ts"), "export const siteLayout = { mini: true }\n")
  fs.copyFileSync(path.join(ROOT, "site.config.ts"), path.join(dir, "site.config.ts"))
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "9.9.9" }))
  fs.writeFileSync(path.join(dir, ".env.example"), "BETTER_AUTH_SECRET=\nENCRYPTION_KEY=\n")
  fs.writeFileSync(path.join(dir, "site", "theme.css"), "/* default */\n")
  fs.writeFileSync(path.join(dir, "site", "fonts.ts"), "export const fonts = {}\n")
  fs.writeFileSync(path.join(dir, "site", "layout.ts"), "export const siteLayout = {}\n")
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture", "--no-verify")
}

describe("create-site.mjs", () => {
  let work
  let boilerplate

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "create-site-"))
    boilerplate = path.join(work, "boilerplate")
    fs.mkdirSync(boilerplate)
    makeBoilerplate(boilerplate)
  })

  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  const create = (name, extra) =>
    spawnSync(
      "node",
      [
        path.join(boilerplate, "scripts", "create-site.mjs"),
        path.join(work, name),
        "--name",
        "Chez Test",
        "--template-url",
        boilerplate,
        "--skip-install",
        ...extra,
      ],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_AUTH_TOKEN: "",
          // The script's own `git commit` needs an identity, and a CI runner
          // has none configured: without these the first run on GitHub failed
          // with `fatal: empty ident name` and the assertion below printed the
          // whole wizard transcript as its reason.
          GIT_AUTHOR_NAME: "create-site test",
          GIT_AUTHOR_EMAIL: "create-site-test@example.invalid",
          GIT_COMMITTER_NAME: "create-site test",
          GIT_COMMITTER_EMAIL: "create-site-test@example.invalid",
        },
      },
    )

  it("forwards the licence pair into the sentinel", () => {
    const result = create("with-key", [
      "--license-key",
      "bys_0123456789abcdef0123456789abcdef",
      "--license-api",
      "https://famous-wildcat-229.convex.site",
    ])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const sentinel = JSON.parse(
      fs.readFileSync(path.join(work, "with-key", ".beindigital-site.json"), "utf8"),
    )
    expect(sentinel.name).toBe("Chez Test")
    expect(sentinel.licenseKey).toBe("bys_0123456789abcdef0123456789abcdef")
    expect(sentinel.licenseApi).toBe("https://famous-wildcat-229.convex.site")
    expect(result.stdout).toContain("licence enregistrée")
    // The sentinel is committed: the key travels with the repository.
    expect(git(path.join(work, "with-key"), "status", "--porcelain").toString()).toBe("")
  })

  it("refuses half a pair before cloning anything", () => {
    // maintenance.mjs asks nothing when either field is missing, so a key
    // without its API would have been written, reported as registered, and
    // checked nothing.
    const result = create("half-key", ["--license-key", "bys_0123456789abcdef0123456789abcdef"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("vont ensemble")
    expect(fs.existsSync(path.join(work, "half-key"))).toBe(false)
  })

  it("says so, loudly, when a site is created without one", () => {
    const result = create("no-key", [])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const sentinel = JSON.parse(
      fs.readFileSync(path.join(work, "no-key", ".beindigital-site.json"), "utf8"),
    )
    expect(sentinel.licenseKey).toBeUndefined()
    expect(result.stdout).toContain("SANS clé de licence")
  })
  describe("from scratch", () => {
    const sentinelOf = (name) =>
      JSON.parse(fs.readFileSync(path.join(work, name, ".beindigital-site.json"), "utf8"))
    const siteFile = (name, file) => fs.readFileSync(path.join(work, name, "site", file), "utf8")

    it("applies no catalogue template with --blank, and records that", () => {
      const result = create("blank", ["--blank"])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      // `null` is "no template", which is not the template called `default`.
      expect(sentinelOf("blank").template).toBeNull()
      // The shipped neutral files are untouched, byte for byte.
      expect(siteFile("blank", "theme.css")).toBe("/* default */\n")
      expect(siteFile("blank", "layout.ts")).toBe("export const siteLayout = {}\n")
      expect(fs.existsSync(path.join(work, "blank", "site", "DESIGN_BRIEF.md"))).toBe(false)
      expect(result.stdout).toContain("à partir de zéro")
      expect(result.stdout).toContain("pnpm design:check")
    })

    it("writes the brief into the client zone and commits it with the site", () => {
      const prompt = "Bistrot lyonnais, bois et cuivre\n\n- titres en serif\n- photos plein cadre"
      const result = create("brief", ["--blank", "--design-prompt", prompt])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const brief = siteFile("brief", "DESIGN_BRIEF.md")
      // Verbatim, inside a blockquote, so a list typed by the client cannot
      // reshape the document around it.
      expect(brief).toContain("> Bistrot lyonnais, bois et cuivre\n>\n> - titres en serif\n> - photos plein cadre")
      expect(brief).toContain("No catalogue template was applied")
      expect(brief).toContain("pnpm design:check")
      expect(sentinelOf("brief").designBrief).toBe("site/DESIGN_BRIEF.md")
      expect(git(path.join(work, "brief"), "status", "--porcelain").toString()).toBe("")
    })

    it("reads a brief with no template to adapt as a site from scratch", () => {
      const result = create("prompt-only", ["--design-prompt", "Épuré, très blanc"])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(sentinelOf("prompt-only").template).toBeNull()
      expect(siteFile("prompt-only", "DESIGN_BRIEF.md")).toContain("> Épuré, très blanc")
    })

    it("reads --design-prompt-file against the directory the command was typed in", () => {
      // init.mjs runs inside the clone; a relative path read there would point
      // at the new site. The command ran from `work`, where this file is.
      fs.writeFileSync(path.join(work, "brief.txt"), "Néon et béton\r\nambiance nocturne\r\n")
      const result = create("from-file", ["--blank", "--design-prompt-file", "brief.txt"])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      // Windows line endings are folded, not carried into the document.
      expect(siteFile("from-file", "DESIGN_BRIEF.md")).toContain("> Néon et béton\n> ambiance nocturne\n")
    })

    it("keeps a named template as the starting point and says so in the brief", () => {
      const result = create("template-and-brief", ["--template", "mini", "--design-prompt", "Plus sombre"])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(sentinelOf("template-and-brief").template).toBe("mini")
      expect(siteFile("template-and-brief", "theme.css")).toBe("/* mini */\n")
      expect(siteFile("template-and-brief", "DESIGN_BRIEF.md")).toContain("`mini` was applied")
    })

    it("does not change what a site created with no flag gets", () => {
      const result = create("no-flag", [])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(sentinelOf("no-flag").template).toBe("default")
      expect(sentinelOf("no-flag").designBrief).toBeUndefined()
    })

    it.each([
      ["--blank with --template", ["--blank", "--template", "mini"], "s'excluent"],
      [
        "both a prompt and a prompt file",
        ["--design-prompt", "a", "--design-prompt-file", "brief.txt"],
        "s'excluent",
      ],
      ["a prompt file that is not there", ["--design-prompt-file", "missing.txt"], "introuvable"],
    ])("refuses %s before cloning anything", (label, extra, reason) => {
      const name = `refused-${label.replace(/\W+/g, "-")}`
      const result = create(name, extra)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(reason)
      expect(fs.existsSync(path.join(work, name))).toBe(false)
    })

    it("accepts --blank before the directory without taking the directory for its value", () => {
      // `--blank` is a flag. Left out of the list of flags that take no value,
      // the directory typed after it would be read as its argument and the
      // command would answer « Usage ».
      const result = spawnSync(
        "node",
        [
          path.join(boilerplate, "scripts", "create-site.mjs"),
          "--blank",
          path.join(work, "flag-first"),
          "--template-url",
          boilerplate,
          "--skip-install",
        ],
        { cwd: work, encoding: "utf8", env: { ...process.env, NODE_AUTH_TOKEN: "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } },
      )
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(fs.existsSync(path.join(work, "flag-first", ".beindigital-site.json"))).toBe(true)
    })

    it("offers the same choice in the wizard, as 0", () => {
      const site = path.join(work, "wizard")
      execFileSync("git", ["clone", "-q", boilerplate, site], { stdio: "ignore" })
      const result = spawnSync("node", ["scripts/init.mjs"], {
        cwd: site,
        encoding: "utf8",
        // name, description, locale, web/mobile, template, then the brief.
        input: "Chez Wizard\n\n\n1\n0\nRustique et chaleureux\n",
      })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("0) À partir de zéro")
      expect(sentinelOf("wizard").template).toBeNull()
      expect(siteFile("wizard", "DESIGN_BRIEF.md")).toContain("> Rustique et chaleureux")
    })
  })
  describe("--template", () => {
    const sentinelOf = (name) =>
      JSON.parse(fs.readFileSync(path.join(work, name, ".beindigital-site.json"), "utf8"))
    const siteFile = (name, file) => fs.readFileSync(path.join(work, name, "site", file), "utf8")

    it("accepts the name the catalogue sells a template under, and records its directory", () => {
      // `asiatique-izakaya` is what a buyer is shown; the directory is
      // `asiatique`. `template:apply` resolved it and this did not, so the
      // creation failed after the clone and the install had already run.
      const result = create("sold-name", ["--template", "mini-sold"])
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(sentinelOf("sold-name").template).toBe("mini")
      expect(siteFile("sold-name", "theme.css")).toBe("/* mini */\n")
    })

    it("still refuses a name nothing claims, and lists the sold names among the available ones", () => {
      const result = create("unknown-name", ["--template", "nonesuch"])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Template inconnu : "nonesuch"')
      expect(result.stderr).toContain("mini-sold")
    })

    it("takes a sold name typed in the wizard, not the neutral template it used to fall back to", () => {
      const site = path.join(work, "wizard-sold-name")
      execFileSync("git", ["clone", "-q", boilerplate, site], { stdio: "ignore" })
      const result = spawnSync("node", ["scripts/init.mjs"], {
        cwd: site,
        encoding: "utf8",
        // name, description, locale, web/mobile, template.
        input: "Chez Wizard\n\n\n1\nmini-sold\n",
      })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(sentinelOf("wizard-sold-name").template).toBe("mini")
      expect(siteFile("wizard-sold-name", "theme.css")).toBe("/* mini */\n")
    })
  })
})
