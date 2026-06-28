# Publishing & listing checklist

Steps that need your accounts/auth (npm, GitHub, the MCP registry). Run them from the
OSS repo (`julapy/eyejack-transcoder`) after committing the new files.

## 1. Publish the npm packages

```bash
# library (already publish-ready: public scope, files scoped, prepublishOnly builds dist)
cd <repo-root> && npm publish        # @eyejack/transcoder

# MCP server (self-contained — installs its own deps)
cd mcp && npm install && npm run build && npm publish   # @eyejack/transcoder-mcp
```

Both use `"publishConfig": { "access": "public" }` (scoped packages are restricted by
default). You must be a member of the `@eyejack` npm org.

## 2. List on the official MCP registry

The package already declares `"mcpName": "io.github.julapy/eyejack-transcoder"` and ships
a `server.json`. Verify/refresh the schema and publish with the registry CLI:

```bash
cd mcp
mcp-publisher init        # regenerates/validates server.json against the current schema
mcp-publisher login github
mcp-publisher publish
```

(Confirm the `$schema` date in `server.json` matches what `mcp-publisher init` emits.)
Once published it gets auto-indexed by Glama (glama.ai/mcp), mcp.so, Smithery, PulseMCP.

## 3. Install as a Claude Code plugin (no npm needed for the skill)

This repo is a marketplace (`.claude-plugin/marketplace.json`) bundling a plugin that
includes the `transparent-video-for-web` skill **and** the MCP server:

```
/plugin marketplace add julapy/eyejack-transcoder
/plugin install eyejack-transcoder@eyejack-transcoder
```

## 4. Curated lists (PRs)

- **awesome-mcp-servers** (github.com/punkpeye/awesome-mcp-servers), under a media/video section:
  > **[EyeJack Transcoder](https://github.com/julapy/eyejack-transcoder)** (`@eyejack/transcoder-mcp`) — convert video, GIFs, and image sequences into WebGL-ready H.264/MP4, including transparent (alpha) video. Runs locally via a headless browser; files never uploaded.
- **awesome-WebAR** (github.com/tobiasbueschel/awesome-WebAR), under tools:
  > **[EyeJack Transcoder](https://transcoder.eyejack.io)** — browser/CLI/MCP tool that produces alpha video (colour+alpha packed MP4 + WebGL shader) for WebAR/WebXR. Open-source (`@eyejack/transcoder`).

## 5. GitHub topics

Add to the repo: `mcp`, `model-context-protocol`, `ai-agents`, `ffmpeg-wasm`, `webar`,
`alpha-video`, `transparent-video`, `webgl`, `video-transcoding`.
