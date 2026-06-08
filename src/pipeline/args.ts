// Pure ffmpeg-argument + size-string builders, lifted verbatim from
// ProcessingPage.vue (computed size strings + check* helpers + per-branch option
// arrays). Kept side-effect-free so Tier A unit tests can pin the exact output.

import type { Size } from '../types';

/**
 * Fit {w,h} within target, preserving aspect, never enlarging; round DOWN to even
 * dimensions (H.264 requires divisible-by-2). Mirrors ProcessingPage.resize().
 */
export function resize(input: Size, target: Size): Size {
  let output: Size;
  if (input.w <= target.w && input.h <= target.h) {
    output = { w: input.w, h: input.h };
  } else {
    const scale = Math.min(target.w / input.w, target.h / input.h);
    output = { w: input.w * scale, h: input.h * scale };
  }
  output.w = Math.floor(output.w / 2) * 2;
  output.h = Math.floor(output.h / 2) * 2;
  return output;
}

export interface SizeStrings {
  /** 'WxH' — the VideoProcessor `resize.sizeString`. */
  sizeString: string;
  /** 'scale=w=2W:h=H' — side-by-side colour|alpha hstack target. */
  sizeStringAlpha: string;
  /** 'W:H' — used in -vf scale='W:H',setsar=1/1. */
  sizeStringSar: string;
}

export function buildSizeStrings(target: Size): SizeStrings {
  return {
    sizeString: `${target.w}x${target.h}`,
    sizeStringAlpha: `scale=w=${target.w * 2}:h=${target.h}`,
    sizeStringSar: `${target.w}:${target.h}`,
  };
}

/** '-shortest' when audio outlasts the animation, else '-framerate 25'. */
export function buildShortestString(animDuration: number, audioDuration: number): string {
  return audioDuration > animDuration ? '-shortest' : '-framerate 25';
}

export interface StreamSelect { animation: string; audio: string; }

/** Stream mapping: explicit maps when an audio track is present, else framerate stubs. */
export function buildStreamSelect(hasAudio: boolean, audioPath?: string): StreamSelect {
  if (hasAudio && audioPath !== undefined && audioPath !== '') {
    return { animation: '-map 0:v', audio: '-map 1:a' };
  }
  return { animation: '-framerate 25', audio: '-framerate 25' };
}

/** GIF input framerate option (alpha-sequence input option); '-stream_loop 0' for non-gif. */
export function buildFrameRateString(isGif: boolean, gifFramerate: number | string): string {
  if (isGif) {
    return gifFramerate !== '' && gifFramerate !== undefined && gifFramerate !== null
      ? `-r ${String(gifFramerate)}`
      : '-r 25';
  }
  return '-stream_loop 0';
}

/** '-t N' max-duration cap. */
export function buildDurationString(maxAnimationDuration: number): string {
  return `-t ${maxAnimationDuration}`;
}

/** ['-b:v X','-maxrate X','-bufsize X']. */
export function bitrateTriple(bitrate: string): string[] {
  return [`-b:v ${bitrate}`, `-maxrate ${bitrate}`, `-bufsize ${bitrate}`];
}

// ---------------------------------------------------------------------------
// Per-branch output-option arrays. Each mirrors the corresponding transcode*
// method in ProcessingPage.vue EXACTLY (Tier A tests assert these).

export interface BranchArgs {
  streams: StreamSelect;
  sizes: SizeStrings;
  shortest: string;
  durationString: string;
  bitrate: string;
  hasAudio: boolean;
}

/** transcodeGif (opaque gif) output options. */
export function buildGifOutputOptions(a: BranchArgs): string[] {
  const opts = [
    a.streams.animation,
    '-pix_fmt yuv420p',
    a.shortest,
    ...bitrateTriple(a.bitrate),
  ];
  if (a.hasAudio) opts.push(a.streams.audio);
  return opts;
}

/** transcodeImageSequence (colour-only) output options. */
export function buildColourSequenceOutputOptions(a: BranchArgs): string[] {
  const opts = [
    '-pix_fmt yuv420p',
    a.durationString,
    ...bitrateTriple(a.bitrate),
  ];
  if (a.hasAudio) opts.push(a.shortest);
  return opts;
}

/** transcodeImageSequenceAlpha (colour|alpha side-by-side) output options. */
export function buildAlphaSequenceOutputOptions(a: BranchArgs): string[] {
  const opts = [
    '-pix_fmt yuv420p',
    `-filter_complex hstack,${a.sizes.sizeStringAlpha}`,
    a.durationString,
    ...bitrateTriple(a.bitrate),
  ];
  if (a.hasAudio) opts.push(a.shortest);
  return opts;
}

/** transcodeAnimation (plain video) output options. */
export function buildVideoOutputOptions(a: BranchArgs): string[] {
  const opts = [
    a.streams.animation,
    '-pix_fmt yuv420p',
    `-vf scale='${a.sizes.sizeStringSar}',setsar=1/1`,
    a.shortest,
    a.durationString,
    ...bitrateTriple(a.bitrate),
  ];
  if (a.hasAudio) opts.push(a.streams.audio);
  return opts;
}
