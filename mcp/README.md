# @eyejack/transcoder-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents use the **[EyeJack Transcoder](https://transcoder.eyejack.io)** — convert video, GIFs, and image sequences into compact, **WebGL-ready H.264/MP4**, including **transparent (alpha) video**.

The transcoder is browser-only (FFmpeg WASM + WebGL), so this server drives it in a **local headless browser** pointed at `transcoder.eyejack.io`. Your file is read locally, processed locally in the headless browser, and written back to disk — **it is never uploaded**; only the page's code is fetched.

## Install

```jsonc
// add to your MCP client config (Claude Desktop / Claude Code / Cursor / …)
{
  "mcpServers": {
    "eyejack-transcoder": {
      "command": "npx",
      "args": ["-y", "@eyejack/transcoder-mcp"]
    }
  }
}
```

One-time, install the headless browser the server drives:

```bash
npx playwright install chromium
```

## Tools

- **`transcode`** — `{ input, output?, type?, hasAlpha?, audio?, maxBitrate?, maxDurationSeconds? }`. `input` is a local file path or http(s) URL (video / GIF / image). Writes the MP4 (default: OS temp dir) and returns `{ outputPath, kind, width, height, alpha, codec, durationSeconds, hasAudio, bytes }`. Transparency is auto-detected; alpha output is packed colour|alpha side-by-side (width = 2 × height).
- **`transcode_sequence`** — `{ inputs: string[], output?, hasAlpha?, maxBitrate? }`. Ordered frame paths/URLs → MP4.
- **`probe`** — `{ input }` → `{ format, streams }` (codec / resolution / fps / audio), no transcode.

## Configuration (env)

- `TRANSCODER_URL` — the transcoder page to drive (default `https://transcoder.eyejack.io`). Point at a local/self-hosted copy for fully-offline operation; the tool contract is unchanged.
- `TRANSCODER_MCP_HEADFUL=1` — show the browser window (debugging).
- `TRANSCODER_MCP_READY_TIMEOUT_MS` — how long to wait for the page's window API (default `60000`).

## Notes

- Jobs run **one at a time** (the FFmpeg WASM pipeline isn't concurrency-safe).
- Large/long inputs take time — transcoding runs in WASM.
- Prefer passing **file paths / URLs**; output is written to disk and the path returned, rather than streaming large base64 through MCP.

Source (MIT): https://github.com/julapy/eyejack-transcoder · library: [`@eyejack/transcoder`](https://www.npmjs.com/package/@eyejack/transcoder)
