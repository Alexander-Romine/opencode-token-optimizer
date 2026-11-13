#!/usr/bin/env node
/**
 * Ensures native/token-optimizer.node and dist/gui-experimental.cjs exist.
 * Runs as `postinstall`, so a plain `npm install` is enough to set the plugin
 * up. Never fails the install:
 *
 * Native addon:
 *   1. addon already built        -> done
 *   2. cargo runnable             -> build from source (scripts/build-native.ps1
 *                                    on Windows, cargo + copy elsewhere)
 *   3. prebuilt for this platform -> copy from prebuilt/<platform>-<arch>/
 *   4. otherwise                  -> warn; the plugin runs on the JS fallback
 *
 * GUI bundle (Desktop `/tokens`):
 *   1. bundle already built       -> done
 *   2. vite available             -> `vite build`
 *   3. otherwise                  -> warn; TUI `/tokens` still works
 *
 * Set TOKEN_OPTIMIZER_SKIP_NATIVE=1 to skip the native step (install.ps1
 * -SkipNative). TOKEN_OPTIMIZER_SKIP_GUI=1 skips the GUI bundle step.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const addon = path.join(root, "native", "token-optimizer.node")
const guiBundle = path.join(root, "dist", "gui-experimental.cjs")

const say = (msg) => console.log(`[token-optimizer] ${msg}`)

function cargoWorks() {
  const probe = spawnSync("cargo", ["--version"], { stdio: "ignore", windowsHide: true })
  return probe.status === 0
}

function buildFromSource() {
  if (process.platform === "win32") {
    const run = spawnSync(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "build-native.ps1")],
      { stdio: "inherit", windowsHide: true },
    )
    return run.status === 0 && existsSync(addon)
  }

  const target = process.env.TOKEN_OPTIMIZER_TARGET || process.env.CARGO_TARGET_DIR
  const env = { ...process.env }
  if (target) env.CARGO_TARGET_DIR = target

  const build = spawnSync(
    "cargo",
    ["build", "--release", "--manifest-path", path.join(root, "native", "Cargo.toml")],
    { stdio: "inherit", env },
  )
  if (build.status !== 0) return false

  const dir = target || path.join(root, "native", "target", "release")
  const artifact =
    process.platform === "darwin"
      ? path.join(dir, "libtoken_optimizer_native.dylib")
      : path.join(dir, "libtoken_optimizer_native.so")
  if (!existsSync(artifact)) return false

  mkdirSync(path.dirname(addon), { recursive: true })
  copyFileSync(artifact, addon)
  return true
}

function copyPrebuilt() {
  const prebuilt = path.join(root, "prebuilt", `${process.platform}-${process.arch}`, "token-optimizer.node")
  if (!existsSync(prebuilt)) return false
  mkdirSync(path.dirname(addon), { recursive: true })
  copyFileSync(prebuilt, addon)
  say(`copied prebuilt addon (${process.platform}-${process.arch})`)
  return true
}

function setupNative() {
  if (process.env.TOKEN_OPTIMIZER_SKIP_NATIVE === "1") {
    say("native setup skipped (TOKEN_OPTIMIZER_SKIP_NATIVE=1)")
    return
  }
  if (existsSync(addon)) {
    say("native addon already present")
    return
  }
  if (cargoWorks() && buildFromSource()) {
    say("native addon built from source")
    return
  }
  if (copyPrebuilt()) return

  say("WARNING: no Rust toolchain and no prebuilt for this platform -")
  say("         the plugin will run on the JS fallback (same results, ~3x slower).")
}

function setupGui() {
  if (process.env.TOKEN_OPTIMIZER_SKIP_GUI === "1") {
    say("GUI bundle step skipped (TOKEN_OPTIMIZER_SKIP_GUI=1)")
    return
  }
  if (existsSync(guiBundle)) {
    say("GUI bundle already present")
    return
  }
  // vite is a devDependency; only present in a dev clone, not a prod install.
  const viteBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite")
  if (!existsSync(viteBin)) {
    say("WARNING: GUI bundle missing and vite not installed -")
    say("         Desktop /tokens will be unavailable (TUI /tokens still works).")
    say("         Run `npm install --include=dev` then `npm run build:gui` to fix.")
    return
  }
  const run = spawnSync(viteBin, ["build"], { cwd: root, stdio: "inherit", windowsHide: true })
  if (run.status === 0 && existsSync(guiBundle)) {
    say("GUI bundle built")
  } else {
    say("WARNING: GUI bundle build failed - Desktop /tokens will be unavailable.")
  }
}

try {
  setupNative()
  setupGui()
} catch (error) {
  say(`WARNING: setup failed (${error.message}) - the plugin still loads.`)
  process.exit(0) // never break `npm install` over this
}
