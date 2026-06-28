import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Page } from 'playwright';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

const mimeFor = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

export interface FileDescriptor { name: string; type: string; b64: string }

export interface ProbeStream {
  codec_type: 'video' | 'audio';
  codec?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  pixelFormat?: string;
  [k: string]: unknown;
}
export interface TranscodeResult {
  kind: 'video' | 'image';
  path: string;
  ext: string;
  bytes: number;
  b64: string | null;
  streams: ProbeStream[];
  format: { duration?: number; size?: number; bitrateKbps?: number; [k: string]: unknown };
}

// Resolve an input spec (local file path or http(s) URL) to bytes for injection.
export async function resolveInput(spec: string): Promise<FileDescriptor> {
  if (/^https?:\/\//i.test(spec)) {
    const res = await fetch(spec);
    if (!res.ok) throw new Error(`Failed to fetch ${spec}: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = basename(new URL(spec).pathname) || 'input';
    const type = res.headers.get('content-type')?.split(';')[0]?.trim() || mimeFor(name);
    return { name, type, b64: buf.toString('base64') };
  }
  const buf = await readFile(spec);
  const name = basename(spec);
  return { name, type: mimeFor(name), b64: buf.toString('base64') };
}

export interface TranscodeParams {
  inputs: FileDescriptor[];
  audio?: FileDescriptor;
  opts: { type?: string; hasAlpha?: boolean };
  settings?: Record<string, unknown>;
  sequence: boolean;
}

// Runs INSIDE the page. Rebuilds File objects from base64 (exactly what a user
// upload produces), optionally tunes settings, transcodes, probes, and returns
// the output bytes as base64. Mirrors the proven transcoder-testing RUN path.
const PAGE_TRANSCODE = async (p: TranscodeParams): Promise<TranscodeResult> => {
  const w = window as unknown as Record<string, any>;
  const log: string[] = w.__transcodeLog || [];
  log.length = 0;
  const toFile = (d: FileDescriptor): File => {
    const bin = atob(d.b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new File([a], d.name, { type: d.type });
  };
  const args = p.inputs.map(toFile);
  const opts: Record<string, unknown> = { ...p.opts };
  if (p.audio) opts.audio = toFile(p.audio);
  if (p.settings) w.transcoder.configure({ transcodeSettings: p.settings });
  const out = p.sequence ? await w.transcodeSequence(args, opts) : await w.transcodeFile(args[0], opts);
  const probe = await w.probeMedia(out.path);
  const blob: Blob | undefined = await w.fileSystem.readFile(out.path);
  let b64: string | null = null;
  let bytes = 0;
  if (blob) {
    bytes = blob.size;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) {
      s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)) as unknown as number[]);
    }
    b64 = btoa(s);
  }
  const ext = (out.path.split('.').pop() || (out.kind === 'video' ? 'mp4' : 'png')).toLowerCase();
  return { kind: out.kind, path: out.path, ext, bytes, b64, streams: probe.streams, format: probe.format };
};

const PAGE_PROBE = async (p: { input: FileDescriptor }): Promise<{ streams: ProbeStream[]; format: Record<string, unknown> }> => {
  const w = window as unknown as Record<string, any>;
  const d = p.input;
  const bin = atob(d.b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  const file = new File([a], d.name, { type: d.type });
  const probe = await w.probeMedia(file);
  return { streams: probe.streams, format: probe.format };
};

export function runTranscode(page: Page, params: TranscodeParams): Promise<TranscodeResult> {
  return page.evaluate(PAGE_TRANSCODE, params);
}

export function runProbe(page: Page, input: FileDescriptor): Promise<{ streams: ProbeStream[]; format: Record<string, unknown> }> {
  return page.evaluate(PAGE_PROBE, { input });
}
