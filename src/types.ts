// Public types + the ITranscoder contract — the surface web/ depends on.

import type { EventBus } from './events/EventBus';

export interface Size { w: number; h: number; }
export interface Dimensions { width: number; height: number; }

/** Generic alpha pixel transform applied after drawing. */
export type ImageTransform = 'extractAlpha' | 'premultiply';

/** Generic image-processing options (no app-specific presets). */
export interface ImageOptions {
  targetSize: Size;
  /** Never upscale beyond native size (default true). */
  noEnlarge?: boolean;
  /** Crop portrait images to a square of their native width (else fit-inside). */
  square?: boolean;
  /** Pad the canvas to this aspect ratio, image centred at native size. */
  aspect?: Size | null;
  /** Background fill colour (e.g. '#ffffff'); null = transparent. */
  background?: string | null;
  /** Optional alpha pixel transform. */
  transform?: ImageTransform | null;
  /** Output encoding (default 'png'). */
  format?: 'png' | 'jpeg';
  /** Output quality 0–1 (default 0.92). */
  quality?: number;
}

/** Transcode tuning — mirrors the values the web store's transcodeSettings holds. */
export interface TranscodeSettings {
  /** Video bitrate string, e.g. '8M' (applied as -b:v / -maxrate / -bufsize). */
  maxBitrate: string;
  /** Max output duration in seconds (applied as -t N). */
  maxAnimationDuration: number;
  /** Max output dimensions; alpha videos are packed side-by-side so use the alpha cap. */
  maxVideoDimensions: { alpha: Size; noAlpha: Size };
}

export interface TranscoderConfig {
  /** Base URL serving the FFmpeg core assets. Default '/ffmpeg' (same-origin). */
  ffmpegBaseURL?: string;
  transcodeSettings: TranscodeSettings;
  /** Virtual FS working dir. Default fileSystem.workingDir. */
  workingDir?: string;
}

/** Everything needed to run the animation pipeline. */
export interface AnimationInput {
  /** Base name for output files (e.g. '<id>' → '<id>.mp4', '<id>-colour-00001.png'). */
  outputBasename: string;
  /** Virtual FS path(s): a single video/gif, or the frames of an image sequence. */
  paths: string[];
  isSequence: boolean;
  isGif: boolean;
  hasAlpha: boolean;
  width: number;
  height: number;
  /** Animation duration in seconds. */
  duration: number;
  hasAudio: boolean;
  /** GIF source framerate ('' to default to 25). */
  gifFramerate?: number | string;
  /** Optional audio track (virtual FS path) + its duration. */
  audioPath?: string;
  audioDuration?: number;
  /** Output dir; defaults to the configured workingDir. */
  dir?: string;
}

export interface ProcessImageOptions extends ImageOptions {
  input: Blob | File | string;
  filename: string;
  dir?: string;
}

export interface VideoMeta extends Dimensions {
  duration: number;
  hasAudio: boolean;
}

/** Typed event stream emitted by the Transcoder. */
export interface TranscoderEvents {
  start: { stage: string };
  progress: { stage: string; percent: number };
  log: { stage: string; message: string };
  stageComplete: { stage: string };
  cancelled: { stage: string };
  error: { error: Error };
}

export type AnimationBranch = 'sequence' | 'gifAlpha' | 'gifOpaque' | 'video';

/** The standardized transcoding API web/ consumes. */
export interface ITranscoder {
  readonly events: EventBus<TranscoderEvents>;
  configure(cfg: TranscoderConfig): void;
  checkSupport(): { supported: boolean; reason?: string; browser?: string };

  getVideoMetadata(file: Blob | File): Promise<VideoMeta>;
  getImageSize(file: Blob | File): Promise<Dimensions>;
  detectGifTransparency(input: Blob | File | string): Promise<boolean>;

  processImage(opts: ProcessImageOptions): Promise<{ width: number; height: number; path: string }>;

  /** Full animation pipeline: classifies the branch, computes options, runs it. */
  transcodeAnimation(input: AnimationInput): Promise<{ animationPath: string }>;

  /**
   * Abort the in-flight transcode: terminates the FFmpeg worker (the running
   * convert() rejects with a cancellation error) and stops any frame loop.
   * Emits a `cancelled` event. The WASM core reloads on the next transcode.
   */
  cancel(): void;
}
