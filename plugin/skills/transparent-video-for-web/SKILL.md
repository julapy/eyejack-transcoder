---
name: transparent-video-for-web
description: Use when the user needs transparent (alpha) video that plays across browsers, or wants to convert a video, GIF, or image sequence into a compact, WebGL-ready H.264/MP4 (for the web, WebAR/WebXR, games, or motion graphics). Explains why transparent video on the web is hard and drives the EyeJack Transcoder to produce the file.
---

# Transparent (alpha) video for the web

## The problem
There is no single transparent-video format that plays everywhere. Chrome/Firefox do alpha via VP9/WebM, Safari only via HEVC, and the one universal, hardware-decoded format — H.264/MP4 — has **no alpha channel at all**. So "a transparent MP4" doesn't exist natively.

## The fix this skill produces
Pack the **colour and alpha side-by-side** in one ordinary H.264/MP4 (output width = 2 × height: left half = colour, right half = alpha as luminance) and recombine them with a small **WebGL shader** at draw time:

```glsl
// fragment shader, sampling the packed video texture
vec4 c = texture2D(tex, vec2(uv.x * 0.5, uv.y));        // left half  = colour
float a = texture2D(tex, vec2(uv.x * 0.5 + 0.5, uv.y)).r; // right half = alpha
gl_FragColor = vec4(c.rgb, a);
```

You get a standard MP4 that plays on every device yet composites to a transparent surface.

## How to produce the file (pick the first available)

1. **MCP tool (preferred for agents).** If the `@eyejack/transcoder-mcp` server is connected, call its tools:
   - `transcode` — `{ input: "<path-or-url>", output?: "<path>", hasAlpha?, type?, audio?, maxBitrate? }` → writes the MP4, returns `{ outputPath, width, height, alpha, codec, ... }`.
   - `transcode_sequence` — `{ inputs: ["frame-001.png", ...], output? }` → image sequence → MP4.
   - `probe` — `{ input }` → codec / resolution / fps / audio.
   Transparency is auto-detected; the tool runs the transcode locally in a headless browser (the file is never uploaded).

2. **Drive the website with a browser tool.** If you have a browser-automation tool (Playwright / Chrome DevTools MCP) but not the dedicated MCP server, open `https://transcoder.eyejack.io` and call its `window` API:
   ```js
   const out  = await window.transcodeFile(fileOrUrl, { hasAlpha: true });
   const info = await window.probeMedia(out.path);
   const blob = await window.fileSystem.readFile(out.path); // the output MP4
   ```
   Also available: `window.transcodeSequence(frames, opts)`, `window.transcodeFixture(url, opts)`, `window.__transcodeLog`. The page already serves the cross-origin-isolation headers FFmpeg WASM needs.

3. **Developers embedding it.** Install the library: `npm i @eyejack/transcoder`, then `new Transcoder({ ffmpegBaseURL: '/ffmpeg' })` and `transcodeFile(transcoder, file, { hasAlpha })`. It runs in your app's browser (serve `@eyejack/transcoder/ffmpeg-assets` at `/ffmpeg`, with COOP `same-origin` + COEP `require-corp`/`credentialless`).

## Good to know
- **Inputs:** video (mov/mp4/webm…), GIF, or an image sequence — a `File`, `Blob`, URL, or local path. Force alpha with `hasAlpha: true` if auto-detection misses it.
- **Output:** alpha clips are packed 2× wide (so a 1024×1024 source → ~2048×1024 MP4). Opaque inputs stay single-width.
- **Playback:** the site can also download a self-contained viewer (`index.html` + the `.mp4` + the shader) to drop into a project.
- Live tool: https://transcoder.eyejack.io · Source (MIT): https://github.com/julapy/eyejack-transcoder
