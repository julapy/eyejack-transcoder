// Public browser-runtime helpers — a thin convenience layer over the Transcoder
// facade for the common "give me a File/Blob/URL, get an output" flow: resolve an
// input into the virtual FS, detect its type, build the AnimationInput, run the
// facade. Used by the standalone harness, the React harness, the e2e tests, and
// external consumers — one identical code path for all of them.

import { fileSystem, getImageSize, getVideoMetadata, detectGifTransparency, VideoProcessor } from '../core/index';
import type { AnimationInput, ImageOptions, ITranscoder } from '../types';

/** Rich media info parsed from an ffmpeg `-i` probe (+ the raw log). */
export interface MediaStream {
  codec_type: 'video' | 'audio';
  codec?: string;
  pixelFormat?: string;
  width?: number;
  height?: number;
  duration?: number;
  r_frame_rate?: string;
  sampleRate?: number;
  channels?: string;
}
export interface MediaInfo {
  format: { duration: number; size: number; bitrateKbps: number };
  streams: MediaStream[];
  raw: string;
}

/**
 * Probe a media file's full info (codec/resolution/fps/audio/bitrate + the raw
 * ffmpeg log). Works for video / gif / image. Requires a cross-origin-isolated
 * context (loads FFmpeg WASM).
 */
export async function probeMedia(input: FileInput): Promise<MediaInfo> {
  const { path } = await resolveToPath(input);
  const vp = new VideoProcessor([{ file: path }], {}) as unknown as { getFileData(): Promise<MediaInfo> };
  return vp.getFileData();
}

export type RunType = 'auto' | 'video' | 'gif' | 'image' | 'sequence';
export type FileInput = File | Blob | string;

export interface TranscodeFileOpts {
  type?: RunType;
  hasAlpha?: boolean;
  /** Optional audio track to mux into the output (video/gif/sequence). */
  audio?: FileInput;
  /** Generic image options for the image path (resize/format/etc.). */
  image?: Partial<ImageOptions>;
  outputBasename?: string;
}
export interface TranscodeResult { path: string; kind: 'video' | 'image' }

/** Resolve an audio track to a virtual-FS path + its duration (for stream sync). */
async function resolveAudio(audio: FileInput): Promise<{ path: string; duration: number }> {
  const { path, blob } = await resolveToPath(audio);
  let duration = 0;
  try { duration = (await getVideoMetadata(blob as File)).duration || 0; } catch { /* ignore */ }
  return { path, duration };
}

export const newBasename = (): string =>
  `media-${globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)}`;

export function detectType(name: string, blobType: string): 'video' | 'gif' | 'image' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.gif') || blobType === 'image/gif') return 'gif';
  if (/\.(mp4|mov|webm|mkv|m4v)$/.test(lower) || blobType.startsWith('video/')) return 'video';
  return 'image';
}

/** Resolve a File/Blob/URL/virtual-path to a virtual-FS path (writing if needed). */
export async function resolveToPath(input: FileInput): Promise<{ path: string; name: string; blob: Blob }> {
  if (typeof input === 'string') {
    const existing = await fileSystem.readFile(input);
    if (existing) return { path: input, name: input.split('/').pop() || input, blob: existing };
    const resp = await fetch(input);
    const blob = await resp.blob();
    const name = (input.split('/').pop() || 'fetched').split('?')[0];
    const path = fileSystem.storeUserFile(new File([blob], name), `${fileSystem.workingDir}/${name}`);
    return { path, name, blob };
  }
  const name = input instanceof File ? input.name : 'upload';
  const file = input instanceof File ? input : new File([input], name);
  const path = fileSystem.storeUserFile(file);
  return { path, name, blob: file };
}

/** Transcode a single file (video / gif / image) via the given transcoder. */
export async function transcodeFile(
  transcoder: ITranscoder,
  input: FileInput,
  opts: TranscodeFileOpts = {},
): Promise<TranscodeResult> {
  const basename = opts.outputBasename ?? newBasename();
  const { path, name, blob } = await resolveToPath(input);
  const type = opts.type && opts.type !== 'auto' ? opts.type : detectType(name, blob.type);

  if (type === 'image') {
    const { width, height } = await getImageSize(blob);
    const image = opts.image ?? {};
    const ext = image.format === 'jpeg' ? 'jpg' : 'png';
    const result = await transcoder.processImage({
      input: path, targetSize: { w: width, h: height }, ...image, filename: `${basename}-image.${ext}`,
    });
    return { path: result.path, kind: 'image' };
  }

  // Optional external audio track to mux in (maps -map 0:v / -map 1:a).
  const audio = opts.audio ? await resolveAudio(opts.audio) : null;

  if (type === 'gif') {
    const hasAlpha = opts.hasAlpha ?? await detectGifTransparency(path);
    const { width, height } = await getImageSize(blob);
    const anim: AnimationInput = {
      outputBasename: basename, paths: [path], isSequence: false, isGif: true, hasAlpha,
      width, height, duration: 0, hasAudio: !!audio, gifFramerate: '',
      audioPath: audio?.path, audioDuration: audio?.duration,
    };
    const { animationPath } = await transcoder.transcodeAnimation(anim);
    return { path: animationPath, kind: 'video' };
  }

  const meta = await transcoder.getVideoMetadata(blob);
  const anim: AnimationInput = {
    outputBasename: basename, paths: [path], isSequence: false, isGif: false, hasAlpha: false,
    width: meta.width, height: meta.height, duration: meta.duration,
    hasAudio: audio ? true : meta.hasAudio,
    audioPath: audio?.path, audioDuration: audio?.duration,
  };
  const { animationPath } = await transcoder.transcodeAnimation(anim);
  return { path: animationPath, kind: 'video' };
}

/** Transcode an image sequence (multiple frame files) → mp4. */
export async function transcodeSequence(
  transcoder: ITranscoder,
  inputs: FileInput[],
  opts: TranscodeFileOpts = {},
): Promise<TranscodeResult> {
  const basename = opts.outputBasename ?? newBasename();
  const resolved = await Promise.all(inputs.map(resolveToPath));
  resolved.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const paths = resolved.map((r) => r.path);
  const { width, height } = await getImageSize(resolved[0].blob);
  const hasAlpha = opts.hasAlpha ?? await detectGifTransparency(resolved[0].path);
  const audio = opts.audio ? await resolveAudio(opts.audio) : null;
  const anim: AnimationInput = {
    outputBasename: basename, paths, isSequence: true, isGif: false, hasAlpha,
    width, height, duration: 0, hasAudio: !!audio,
    audioPath: audio?.path, audioDuration: audio?.duration,
  };
  const { animationPath } = await transcoder.transcodeAnimation(anim);
  return { path: animationPath, kind: 'video' };
}
