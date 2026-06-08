// Transcoder — the standardized high-level facade implementing ITranscoder.
// Absorbs the per-asset-type orchestration that used to live in
// ProcessingPage.vue: it classifies the branch, computes the ffmpeg options via
// the pure args helpers, drives the core VideoProcessor/ImageProcessor, and emits
// a typed progress/log event stream. No Vue/Vuex/S3 — purely media in → media out.

import {
  VideoProcessor,
  ImageProcessor,
  getVideoMetadata as coreGetVideoMetadata,
  getImageSize as coreGetImageSize,
  detectGifTransparency as coreDetectGifTransparency,
  checkFFmpegSupport,
  setFfmpegBaseURL,
  addFfmpegLogListener,
  terminateFfmpeg,
  fileSystem,
  pathUtils,
} from '../core/index';
import { EventBus } from '../events/EventBus';
import {
  resize,
  buildSizeStrings,
  buildShortestString,
  buildStreamSelect,
  buildFrameRateString,
  buildDurationString,
  buildGifOutputOptions,
  buildColourSequenceOutputOptions,
  buildAlphaSequenceOutputOptions,
  buildVideoOutputOptions,
  type BranchArgs,
} from './args';
import { classifyAnimation } from './branches';
import type {
  AnimationInput,
  Dimensions,
  ITranscoder,
  ProcessImageOptions,
  TranscoderConfig,
  TranscoderEvents,
  TranscodeSettings,
  VideoMeta,
} from '../types';

const frameNum = (i: number) => String(i + 1).padStart(5, '0');

/** Thrown when a transcode is aborted via cancel(). */
export class CancelledError extends Error {
  constructor() { super('Transcode cancelled'); this.name = 'CancelledError'; }
}

export class Transcoder implements ITranscoder {
  readonly events = new EventBus<TranscoderEvents>();

  private settings: TranscodeSettings | null = null;
  private workingDir: string = fileSystem.workingDir;
  private currentStage = 'idle';
  private cancelled = false;

  constructor(config?: TranscoderConfig) {
    // Surface FFmpeg's log lines as `log` events (drives the harness console).
    addFfmpegLogListener((message: string) => {
      this.events.emit('log', { stage: this.currentStage, message });
    });
    if (config) this.configure(config);
  }

  configure(cfg: TranscoderConfig): void {
    this.settings = cfg.transcodeSettings;
    if (cfg.workingDir) this.workingDir = cfg.workingDir;
    setFfmpegBaseURL(cfg.ffmpegBaseURL ?? '/ffmpeg');
  }

  checkSupport(): { supported: boolean; reason?: string; browser?: string } {
    return checkFFmpegSupport();
  }

  getVideoMetadata(file: Blob | File): Promise<VideoMeta> {
    return coreGetVideoMetadata(file);
  }

  getImageSize(file: Blob | File): Promise<Dimensions> {
    return coreGetImageSize(file);
  }

  detectGifTransparency(input: Blob | File | string): Promise<boolean> {
    return coreDetectGifTransparency(input);
  }

  async processImage(opts: ProcessImageOptions): Promise<{ width: number; height: number; path: string }> {
    const { input, filename, dir: optDir, ...imageOptions } = opts;
    const dir = optDir ?? this.workingDir;
    // ImageProcessor is an untyped JS primitive — treat loosely at the boundary.
    const proc: any = new ImageProcessor(input, {
      ...imageOptions,
      output: { dir, filename },
    });
    const { width, height } = await proc.convert();
    return { width, height, path: pathUtils.join(dir, filename) };
  }

  /** Abort the in-flight transcode (terminates the FFmpeg worker + stops loops). */
  cancel(): void {
    this.cancelled = true;
    terminateFfmpeg();
    this.events.emit('cancelled', { stage: this.currentStage });
  }

  async transcodeAnimation(input: AnimationInput): Promise<{ animationPath: string }> {
    const settings = this.requireSettings();
    this.cancelled = false;
    const dir = input.dir ?? this.workingDir;
    const branch = classifyAnimation(input);

    // Derived options shared across branches.
    const cap = input.hasAlpha ? settings.maxVideoDimensions.alpha : settings.maxVideoDimensions.noAlpha;
    const target = resize({ w: input.width, h: input.height }, cap);
    const sizes = buildSizeStrings(target);
    const shortest = buildShortestString(input.duration, input.audioDuration ?? 0);
    const streams = buildStreamSelect(input.hasAudio, input.audioPath);
    const durationString = buildDurationString(settings.maxAnimationDuration);
    const frameRate = buildFrameRateString(input.isGif, input.gifFramerate ?? '');
    const branchArgs: BranchArgs = {
      streams, sizes, shortest, durationString, bitrate: settings.maxBitrate, hasAudio: input.hasAudio && !!input.audioPath,
    };

    try {
      let animationPath: string;
      switch (branch) {
        case 'video':
          animationPath = await this.runVideo(input, dir, sizes, branchArgs);
          break;
        case 'gifOpaque':
          animationPath = await this.runGif(input, dir, sizes, branchArgs);
          break;
        case 'gifAlpha': {
          const rawFrames = await this.preProcessGif(input.paths[0], input.outputBasename, dir);
          animationPath = await this.runSequence(rawFrames, input, dir, target, frameRate, branchArgs, true);
          break;
        }
        case 'sequence':
          animationPath = await this.runSequence(input.paths, input, dir, target, frameRate, branchArgs, input.hasAlpha);
          break;
      }
      this.events.emit('stageComplete', { stage: branch });
      return { animationPath: animationPath! };
    } catch (error) {
      // A cancel() terminates the worker mid-exec → the convert() rejects; surface
      // that as a cancellation (the `cancelled` event was already emitted) rather
      // than an error.
      if (this.cancelled) throw new CancelledError();
      const err = error instanceof Error ? error : new Error(String(error));
      this.events.emit('error', { error: err });
      throw err;
    }
  }

  // ---- internal branch runners ---------------------------------------------

  /** Plain video → mp4 (transcodeAnimation). */
  private async runVideo(input: AnimationInput, dir: string, _sizes: unknown, a: BranchArgs): Promise<string> {
    this.startStage('video');
    const inputFiles: Array<{ file: string; inputOptions?: string[] }> = [{ file: input.paths[0] }];
    if (input.audioPath) inputFiles.push({ file: input.audioPath });
    return this.runVideoProcessor(inputFiles, {
      output: { dir, filename: `${input.outputBasename}.mp4`, outputOptions: buildVideoOutputOptions(a) },
    });
  }

  /** Opaque gif → mp4 (transcodeGif). */
  private async runGif(input: AnimationInput, dir: string, sizes: ReturnType<typeof buildSizeStrings>, a: BranchArgs): Promise<string> {
    this.startStage('gifOpaque');
    const inputFiles: Array<{ file: string }> = [{ file: input.paths[0] }];
    if (input.audioPath) inputFiles.push({ file: input.audioPath });
    return this.runVideoProcessor(inputFiles, {
      resize: { sizeString: sizes.sizeString },
      output: { dir, filename: `${input.outputBasename}.mp4`, outputOptions: buildGifOutputOptions(a) },
    });
  }

  /** Extract a gif's frames to RGBA PNGs (preProcessGif). Returns frame paths. */
  private async preProcessGif(gifPath: string, basename: string, dir: string): Promise<string[]> {
    this.startStage('preProcessGif');
    const frames = (await this.runVideoProcessor(
      [{ file: gifPath }],
      { preProcessGif: true, output: { dir, filename: `${basename}-raw-%05d.png`, outputOptions: [] } },
    )) as unknown as string[];
    const gifFrames = Array.isArray(frames) ? [...frames] : [];
    gifFrames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (gifFrames.length === 0) {
      throw new Error('Failed to extract frames from GIF. The file may be corrupt or in an unsupported format.');
    }
    return gifFrames;
  }

  /**
   * Image-sequence → mp4. Processes each frame to a colour PNG (and an alpha PNG
   * when hasAlpha), then transcodes the colour-only or colour|alpha-hstack video.
   */
  private async runSequence(
    framePaths: string[],
    input: AnimationInput,
    dir: string,
    target: { w: number; h: number },
    frameRate: string,
    a: BranchArgs,
    hasAlpha: boolean,
  ): Promise<string> {
    this.startStage('sequence');
    const base = input.outputBasename;
    const targetSize = { w: target.w, h: target.h };

    for (let i = 0; i < framePaths.length; i++) {
      if (this.cancelled) throw new CancelledError();
      const colourName = `${base}-colour-${frameNum(i)}.png`;
      const jobs = [this.processImage({ input: framePaths[i], transform: 'premultiply', format: 'png', targetSize, filename: colourName, dir })];
      if (hasAlpha) {
        const alphaName = `${base}-alpha-${frameNum(i)}.png`;
        jobs.push(this.processImage({ input: framePaths[i], transform: 'extractAlpha', format: 'png', targetSize, filename: alphaName, dir }));
      }
      await Promise.all(jobs);
      this.events.emit('progress', { stage: 'sequence', percent: Math.round((i / framePaths.length) * 100) });
    }
    this.events.emit('progress', { stage: 'sequence', percent: 100 });

    const colourPattern = pathUtils.join(dir, `${base}-colour-%05d.png`);

    if (hasAlpha) {
      const alphaPattern = pathUtils.join(dir, `${base}-alpha-%05d.png`);
      const inputFiles: Array<{ file: string; inputOptions?: string[] }> = [
        { file: colourPattern, inputOptions: [frameRate] },
        { file: alphaPattern, inputOptions: [frameRate] },
      ];
      if (input.audioPath) inputFiles.push({ file: input.audioPath });
      return this.runVideoProcessor(inputFiles, {
        output: { dir, filename: `${base}.mp4`, outputOptions: buildAlphaSequenceOutputOptions(a) },
      });
    }

    const inputFiles: Array<{ file: string }> = [{ file: colourPattern }];
    if (input.audioPath) inputFiles.push({ file: input.audioPath });
    return this.runVideoProcessor(inputFiles, {
      resize: { sizeString: buildSizeStrings(target).sizeString },
      output: { dir, filename: `${base}.mp4`, outputOptions: buildColourSequenceOutputOptions(a) },
    });
  }

  // ---- core driver ----------------------------------------------------------

  /**
   * Create a VideoProcessor, wire progress → events, run convert(), return output.
   * VideoProcessor is an untyped JS primitive; convert() returns an output path
   * (string) or, for sequence extraction (preProcessGif), an array of paths.
   */
  private async runVideoProcessor(
    inputFiles: Array<{ file: string | Blob | File; inputOptions?: string[] }>,
    options: Record<string, unknown>,
  ): Promise<any> {
    const stage = this.currentStage;
    const vp: any = new VideoProcessor(inputFiles, options);
    vp.onProgress = (p: { percent: number }) => {
      const percent = Math.round(p.percent);
      if (percent >= 0 && percent <= 100) this.events.emit('progress', { stage, percent });
    };
    return vp.convert();
  }

  private startStage(stage: string): void {
    this.currentStage = stage;
    this.events.emit('start', { stage });
  }

  private requireSettings(): TranscodeSettings {
    if (!this.settings) {
      throw new Error('Transcoder not configured — call configure({ transcodeSettings }) first.');
    }
    return this.settings;
  }
}

export default Transcoder;
