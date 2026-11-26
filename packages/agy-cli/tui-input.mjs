import fs from "node:fs/promises"
import path from "node:path"

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])
const ATTACH_TIMEOUT = 5_000

// AGY 1.5.18 asks the Wayland helper for available types and then reads the
// chosen type. The helper serves this turn's single staged image, not Wayland.
const WL_PASTE = `#!/bin/sh
set -eu
cd "$AGY_TUI_CLIPBOARD_DIR"
IFS= read -r mime < mime
case "$#:$1" in
  1:--list-types) printf '%s\\n' "$mime" ;;
  2:--type) [ "$2" = "$mime" ] && exec /bin/cat image ;;
  *) exit 1 ;;
esac
`

function inputError(message, statusCode = 400) {
  return Object.assign(new Error(`agy bridge: ${message}`), { statusCode })
}

export function parseTuiInput(prompt, parts) {
  const images = []
  if (parts !== undefined) {
    if (!Array.isArray(parts)) throw inputError("invalid TUI input parts")
    const text = []
    for (const part of parts) {
      if (part?.type === "text" && typeof part.text === "string") {
        if (images.length && part.text.trim()) throw inputError("TUI input must put text before images")
        text.push(part.text)
        continue
      }
      if (part?.type !== "image") throw inputError("invalid TUI input part")
      const { data, mimeType } = part
      // AGY transcodes GIF to the first frame. Only accept the media types
      // the native TUI sends without changing the supplied image.
      if (!IMAGE_TYPES.has(mimeType)) throw inputError("TUI images must be PNG, JPEG or WebP")
      if (typeof data !== "string" || !data || data.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(data.replace(/={1,2}$/, ""))) {
        throw inputError("invalid base64 TUI image data")
      }
      images.push({ data, mimeType })
    }
    prompt = text.join("")
  }
  if (typeof prompt !== "string") throw inputError("TUI mode requires a text prompt")
  const expectedPrompt = prompt.replace(/\r\n?/g, "\n").trim()
  // Only literal text enters the editor. Never submit keys or native commands.
  if (!expectedPrompt || /^[!/]/.test(expectedPrompt) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(expectedPrompt)) {
    throw inputError("the prompt is not supported as literal TUI input")
  }
  return { expectedPrompt, images }
}

async function clipboard(root, env) {
  const bin = path.join(root, "clipboard-bin")
  const dir = path.join(root, "clipboard-data")
  const runtime = path.join(root, "clipboard-runtime")
  for (const folder of [bin, dir, runtime]) await fs.mkdir(folder, { mode: 0o700 })
  await fs.writeFile(path.join(bin, "wl-paste"), WL_PASTE, { mode: 0o700 })
  // decision: shadow xclip; not just unset DISPLAY because AGY 1.5.18
  // still invokes xclip when the private Wayland helper fails.
  await fs.symlink("/bin/false", path.join(bin, "xclip"))
  const local = {
    ...env,
    PATH: `${bin}:${env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    AGY_TUI_CLIPBOARD_DIR: dir,
    XDG_RUNTIME_DIR: runtime,
    WAYLAND_DISPLAY: "agy-private-clipboard",
  }
  delete local.DISPLAY
  delete local.WAYLAND_SOCKET
  return { env: local, dir }
}

async function attach(stdin, pause, getScreen, count) {
  stdin.write("\x16") // Ctrl+V requests a native media paste, not bracketed text.
  const deadline = performance.now() + ATTACH_TIMEOUT
  // The collapsed media section rewrites the complete count even when only
  // its number changes. User text is pasted later and cannot mimic this line.
  const rendered = new RegExp(`▸ 📎 ${count} media attached(?: \\([^\\r\\n]*\\))? +\\(ctrl\\+o to expand\\)`)
  do {
    await pause(35)
    const screen = getScreen()
    if (rendered.test(screen)) return
    if (screen.includes("No image or video found in the clipboard")) break
  } while (performance.now() < deadline)
  throw inputError("the native TUI did not accept an image attachment", 502)
}

// Call with an already-private turn root and the environment destined for
// the PTY. The runner owns text validation, readiness, and cleanup of root.
// After readiness it calls paste once, with its abort/deadline-aware pause
// and a getter for the rolling raw PTY output. paste also submits the turn.
export async function prepareTuiInput(root, { prompt, parts, env }) {
  const { expectedPrompt, images } = parseTuiInput(prompt, parts)
  const clip = images.length ? await clipboard(root, env) : null
  return {
    env: clip?.env ?? env,
    expectedPrompt,
    imageCount: images.length,
    async paste(stdin, pause, getScreen) {
      for (const [i, { data, mimeType }] of images.entries()) {
        await fs.writeFile(path.join(clip.dir, "image"), data, { encoding: "base64", mode: 0o600 })
        await fs.writeFile(path.join(clip.dir, "mime"), `${mimeType}\n`, { mode: 0o600 })
        await attach(stdin, pause, getScreen, i + 1)
      }
      stdin.write(`\x1b[200~${expectedPrompt}\x1b[201~`)
      await pause(35)
      stdin.write("\r")
    },
  }
}
