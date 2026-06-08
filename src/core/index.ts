// Typed re-exports of the core primitives (ported verbatim as .js under allowJs).
// The pipeline + public contract import the primitives through here.

export {
  default as VideoProcessor,
  getVideoMetadata,
  getImageDimensions,
  checkFFmpegSupport,
  setFfmpegBaseURL,
  setVideoDefaults,
  addFfmpegLogListener,
  removeFfmpegLogListener,
  terminateFfmpeg,
} from './VideoProcessor';

export {
  default as ImageProcessor,
  getImageSize,
  applyMode,
} from './ImageProcessor';

export {
  default as FileSystemAdapter,
  fileSystem,
  pathUtils,
} from './FileSystem';

export {
  detectGifTransparency,
  isOpaque,
  checkGifTransparency,
} from './gifTransparency';
