#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename, extname, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { withPage, closeBrowser, TRANSCODER_URL } from './browser.js';
import { resolveInput, runTranscode, runProbe, type FileDescriptor, type TranscodeResult } from './driver.js';

const stripExt = (name: string) => name.slice(0, name.length - extname(name).length) || name;

interface Summary {
  outputPath: string;
  kind: 'video' | 'image';
  bytes: number;
  width?: number;
  height?: number;
  alpha?: boolean;
  codec?: string;
  fps?: string;
  durationSeconds?: number;
  hasAudio: boolean;
}

async function writeOutput(result: TranscodeResult, inputs: FileDescriptor[], output?: string): Promise<Summary> {
  if (!result.b64) throw new Error('Transcode produced no output bytes.');
  const defaultName = `${stripExt(inputs[0]?.name ?? 'output')}.transcoded.${result.ext}`;
  const outputPath = output ? resolve(output) : join(tmpdir(), defaultName);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(result.b64, 'base64'));
  const v = result.streams.find((s) => s.codec_type === 'video');
  return {
    outputPath,
    kind: result.kind,
    bytes: result.bytes,
    width: v?.width,
    height: v?.height,
    alpha: v && v.width != null && v.height != null ? v.width === v.height * 2 : undefined,
    codec: v?.codec,
    fps: v?.r_frame_rate,
    durationSeconds: result.format?.duration,
    hasAudio: result.streams.some((s) => s.codec_type === 'audio'),
  };
}

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

function settingsFrom(a: { maxBitrate?: string; maxDurationSeconds?: number }): Record<string, unknown> | undefined {
  const s: Record<string, unknown> = {};
  if (a.maxBitrate) s.maxBitrate = a.maxBitrate;
  if (a.maxDurationSeconds) s.maxAnimationDuration = a.maxDurationSeconds;
  return Object.keys(s).length ? s : undefined;
}

const server = new McpServer({ name: 'eyejack-transcoder', version: '0.1.0' });

server.registerTool(
  'transcode',
  {
    title: 'Transcode media to WebGL-ready MP4',
    description:
      'Convert a video, GIF, or image into a compact, WebGL-ready H.264/MP4. Transparent inputs (e.g. a transparent GIF) become alpha video — colour and alpha packed side-by-side (output width = 2 × height), recombined with a WebGL shader at playback. Runs locally in a headless browser; the input file is never uploaded. Returns the path to the written output file.',
    inputSchema: {
      input: z.string().describe('Local file path or http(s) URL of the source media (video, GIF, or image).'),
      output: z.string().optional().describe('Path to write the output file. Defaults to a file in the OS temp dir.'),
      type: z.enum(['auto', 'video', 'gif', 'image', 'sequence']).optional().describe('Override input classification (default: auto-detected).'),
      hasAlpha: z.boolean().optional().describe('Force alpha handling on/off (default: transparency auto-detected).'),
      audio: z.string().optional().describe('Optional audio track (path or URL) to mux into the output.'),
      maxBitrate: z.string().optional().describe('Output bitrate ceiling, e.g. "8M".'),
      maxDurationSeconds: z.number().optional().describe('Trim the output to at most N seconds.'),
    },
  },
  async (a) => {
    try {
      const inputs = [await resolveInput(a.input)];
      const audio = a.audio ? await resolveInput(a.audio) : undefined;
      const result = await withPage((p) =>
        runTranscode(p, { inputs, audio, opts: { type: a.type ?? 'auto', hasAlpha: a.hasAlpha }, settings: settingsFrom(a), sequence: false }),
      );
      return ok(await writeOutput(result, inputs, a.output));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'transcode_sequence',
  {
    title: 'Transcode an image sequence to MP4',
    description:
      'Convert an ordered set of image frames (paths or URLs) into a WebGL-ready MP4. Transparent frames become alpha video. Returns the path to the written output file.',
    inputSchema: {
      inputs: z.array(z.string()).min(1).describe('Ordered list of frame file paths or URLs.'),
      output: z.string().optional().describe('Path to write the output file. Defaults to a file in the OS temp dir.'),
      hasAlpha: z.boolean().optional().describe('Force alpha handling on/off (default: auto-detected).'),
      maxBitrate: z.string().optional().describe('Output bitrate ceiling, e.g. "8M".'),
    },
  },
  async (a) => {
    try {
      const inputs = await Promise.all(a.inputs.map(resolveInput));
      const result = await withPage((p) =>
        runTranscode(p, { inputs, opts: { type: 'sequence', hasAlpha: a.hasAlpha }, settings: settingsFrom(a), sequence: true }),
      );
      return ok(await writeOutput(result, inputs, a.output));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'probe',
  {
    title: 'Probe media metadata',
    description: 'Return codec / resolution / fps / audio metadata for a media file (path or URL), without transcoding.',
    inputSchema: { input: z.string().describe('Local file path or http(s) URL of the media to inspect.') },
  },
  async (a) => {
    try {
      const input = await resolveInput(a.input);
      const probe = await withPage((p) => runProbe(p, input));
      return ok(probe);
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[transcoder-mcp] ready (driving ${TRANSCODER_URL})\n`);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}

main().catch((e) => {
  process.stderr.write(`[transcoder-mcp] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
