/**
 * Builds the `./gui-experimental` bundle (src/gui.tsx -> dist/gui-experimental.cjs)
 * with the official preset: Solid JSX in, one CommonJS file out, app-provided
 * modules (effect, @opencode/*, solid-js, ...) kept external.
 */
import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({ plugins: [gui()] })
