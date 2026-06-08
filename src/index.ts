// Standalone, framework-agnostic media transcoding for the browser:
// FFmpeg-WASM video (incl. colour|alpha side-by-side packing), Canvas image
// processing, an in-memory virtual filesystem, and image transparency detection.
// Public entry: the high-level Transcoder facade + ITranscoder contract + types,
// plus the lower-level primitives.

export const TRANSCODER_VERSION = '0.1.0';

// High-level facade + contract (what web/ + the harness consume).
export { Transcoder, default as TranscoderDefault } from './pipeline/Transcoder';
export { EventBus } from './events/EventBus';
export type {
  ITranscoder,
  TranscoderConfig,
  TranscoderEvents,
  TranscodeSettings,
  AnimationInput,
  AnimationBranch,
  ProcessImageOptions,
  ImageOptions,
  ImageTransform,
  Size,
  Dimensions,
  VideoMeta,
} from './types';

// Browser-runtime convenience helpers (resolve input → detect → transcode).
export {
  transcodeFile,
  transcodeSequence,
  detectType,
  resolveToPath,
  newBasename,
  probeMedia,
} from './runtime/index';
export type { RunType, FileInput, TranscodeFileOpts, TranscodeResult, MediaInfo, MediaStream } from './runtime/index';

// Pure arg/branch helpers (exported for testing + advanced consumers).
export * from './pipeline/args';
export { classifyAnimation } from './pipeline/branches';

// Lower-level primitives (back the web re-export shims; keep current call sites working).
export {
  VideoProcessor,
  getVideoMetadata,
  getImageDimensions,
  checkFFmpegSupport,
  setFfmpegBaseURL,
  setVideoDefaults,
  addFfmpegLogListener,
  removeFfmpegLogListener,
  terminateFfmpeg,
  ImageProcessor,
  getImageSize,
  applyMode,
  FileSystemAdapter,
  fileSystem,
  pathUtils,
  detectGifTransparency,
  isOpaque,
  checkGifTransparency,
} from './core/index';
