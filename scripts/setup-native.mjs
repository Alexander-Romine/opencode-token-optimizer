#!/usr/bin/env node
/**
 * Ensures native/token-optimizer.node exists. Runs as `postinstall`, so a plain
 * `npm install` is enough to set the plugin up. Never fails the install:
 *
 *   1. addon already built        -> done
 *   2. cargo runnable             -> build from source (scripts/build-native.ps1
 *                                    on Windows, cargo + copy elsewhere)
 *   3. prebuilt for this platform -> copy from prebuilt/<platform>-<arch>/
 *   4. otherwise                  -> warn; the plugin runs on the JS fallback
 *
 * Set TOKEN_OPTIMIZER_SKIP_NATIVE=1 to skip (used by install.ps1 -SkipNative).
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const addon = path.join(root, "native", "token-optimizer.node")

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

try {
  if (process.env.TOKEN_OPTIMIZER_SKIP_NATIVE === "1") {
    say("native setup skipped (TOKEN_OPTIMIZER_SKIP_NATIVE=1)")
    process.exit(0)
  }
  if (existsSync(addon)) {
    say("native addon already present")
    process.exit(0)
  }
  if (cargoWorks() && buildFromSource()) {
    say("native addon built from source")
    process.exit(0)
  }
  if (copyPrebuilt()) process.exit(0)

  say("WARNING: no Rust toolchain and no prebuilt for this platform -")
  say("         the plugin will run on the JS fallback (same results, ~3x slower).")
  process.exit(0) // never break `npm install` over this
} catch (error) {
  say(`WARNING: native setup failed (${error.message}) - using the JS fallback.`)
  process.exit(0)
}
