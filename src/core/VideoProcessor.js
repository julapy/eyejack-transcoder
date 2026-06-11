/**
 * Browser VideoProcessor using FFmpeg WASM (@ffmpeg/ffmpeg).
 *
 * Uses dynamic script loading to bypass bundler module mangling, which breaks
 * FFmpeg's internal dynamic imports. Generic — takes input files + ffmpeg output
 * options and produces an output; output codec/fps/etc. are configurable defaults.
 */

import { fileSystem, pathUtils } from './FileSystem';

// Default output encoding settings (configurable via setVideoDefaults). H.264/MP4
// at 25fps is a sensible web-delivery default, not a hard requirement.
const videoDefaults = {
  fps: 25,
  codec: 'libx264',
  preset: 'veryfast',
  crf: 28,
};

/** Override the default output encoding settings (merged over the current ones). */
export function setVideoDefaults(partial) {
  Object.assign(videoDefaults, partial || {});
}

// Singleton FFmpeg instance (will be FFmpeg class from dynamically loaded script)
let FFmpegClass = null;
let ffmpegInstance = null;
let ffmpegLoaded = false;
let ffmpegLoadPromise = null;

// Base URL where the FFmpeg core assets (ffmpeg.js / ffmpeg-core.js / ffmpeg-core.wasm)
// are served. Defaults to '/ffmpeg' (same-origin). Override via setFfmpegBaseURL so any
// consumer (web app, dev harness, e2e test server) can point at its own asset location.
// Same-origin serving is required for cross-origin isolation (the worker + wasm).
let ffmpegBaseURL = '/ffmpeg';

export function setFfmpegBaseURL(url) {
  ffmpegBaseURL = url || '/ffmpeg';
}

function resolveFfmpegBaseURL() {
  // Resolve a relative base against the current origin; absolute URLs pass through.
  try {
    return new URL(ffmpegBaseURL, window.location.origin).href.replace(/\/$/, '');
  } catch {
    return ffmpegBaseURL.replace(/\/$/, '');
  }
}

// Optional listeners for FFmpeg's log lines — drive the standalone harness's
// on-screen log console + the Transcoder facade's `log` events. Console logging
// is preserved alongside.
const ffmpegLogListeners = new Set();

export function addFfmpegLogListener(cb) {
  ffmpegLogListeners.add(cb);
}

export function removeFfmpegLogListener(cb) {
  ffmpegLogListeners.delete(cb);
}

/**
 * Terminate the running FFmpeg worker — the only way to abort an in-flight
 * exec(). Any pending convert() rejects. The instance is reset so the next
 * transcode recreates it (the WASM core reloads on first use after this).
 */
export function terminateFfmpeg() {
  if (ffmpegInstance) {
    try { ffmpegInstance.terminate(); } catch (e) { /* ignore */ }
    ffmpegInstance = null;
    ffmpegLoaded = false;
  }
}

/**
 * Check if the browser supports SharedArrayBuffer (required for FFmpeg WASM)
 */
function checkCrossOriginIsolation() {
  // crossOriginIsolated is the standard way to check
  if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
    return true;
  }
  
  // Fallback: check if SharedArrayBuffer exists
  if (typeof SharedArrayBuffer !== 'undefined') {
    return true;
  }
  
  return false;
}

/**
 * Load a script from URL and return a promise
 */
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
    document.head.appendChild(script);
  });
}

/**
 * Load FFmpeg library from local files served by the dev server
 * This bypasses webpack's bundling which breaks FFmpeg's dynamic imports
 * and avoids CORS issues with workers
 */
async function loadFFmpegScript() {
  if (FFmpegClass) return FFmpegClass;
  
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  
  ffmpegLoadPromise = (async () => {
    // Check if already loaded (e.g., from a previous hot reload)
    if (window.FFmpegWASM && window.FFmpegWASM.FFmpeg) {
      FFmpegClass = window.FFmpegWASM.FFmpeg;
      return FFmpegClass;
    }
    
    // Load @ffmpeg/ffmpeg from the configured base (served same-origin so the
    // worker script is same-origin too).
    const baseURL = resolveFfmpegBaseURL();
    await loadScript(`${baseURL}/ffmpeg.js`);
    
    if (window.FFmpegWASM && window.FFmpegWASM.FFmpeg) {
      FFmpegClass = window.FFmpegWASM.FFmpeg;
      console.log('[FFmpeg] FFmpeg library loaded from local files');
      return FFmpegClass;
    } else {
      throw new Error('FFmpeg library loaded but FFmpegWASM.FFmpeg not found');
    }
  })();
  
  return ffmpegLoadPromise;
}

/**
 * Polyfill for @ffmpeg/util's fetchFile function
 * Converts various input types to Uint8Array for FFmpeg
 */
async function fetchFile(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  
  if (input instanceof Blob || input instanceof File) {
    try {
      const arrayBuffer = await input.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (err) {
      // Handle file access errors (file moved/renamed/deleted after selection)
      const filename = input instanceof File ? input.name : 'file';
      if (err.name === 'AbortError' || 
          err.name === 'NotReadableError' || 
          err.message?.includes('aborted') ||
          err.message?.includes('could not be read')) {
        throw new Error(`The file "${filename}" is no longer accessible.\nIt may have been moved, renamed, or deleted since it was selected.\nPlease select the file again.`);
      }
      throw err;
    }
  }
  
  if (typeof input === 'string') {
    // If it's a URL, fetch it
    if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('blob:')) {
      const response = await fetch(input);
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    }
    // Otherwise treat as text
    const encoder = new TextEncoder();
    return encoder.encode(input);
  }
  
  throw new Error(`Unsupported input type for fetchFile: ${typeof input}`);
}

/**
 * Get or create the FFmpeg instance
 */
async function getFFmpeg() {
  // Check if SharedArrayBuffer is available (required for FFmpeg WASM)
  if (!checkCrossOriginIsolation()) {
    const errorMsg = `SharedArrayBuffer is not available.

FFmpeg WASM requires Cross-Origin Isolation headers:
- Cross-Origin-Opener-Policy: same-origin
- Cross-Origin-Embedder-Policy: credentialless (or require-corp)

Current state: crossOriginIsolated = ${typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undefined'}

Please restart the dev server to apply header changes.`;
    
    console.error('[FFmpeg]', errorMsg);
    throw new Error(errorMsg);
  }
  
  // Load FFmpeg library from CDN if not already loaded
  const FFmpeg = await loadFFmpegScript();
  
  if (!ffmpegInstance) {
    ffmpegInstance = new FFmpeg();
    
    // Set up logging — console + any registered listeners (harness/events).
    ffmpegInstance.on('log', ({ message }) => {
      console.log('[FFmpeg]', message);
      for (const listener of ffmpegLogListeners) {
        try { listener(message); } catch (e) { /* ignore listener errors */ }
      }
    });
  }
  
  if (!ffmpegLoaded) {
    try {
      // Load FFmpeg core from the configured base (served same-origin to avoid CORS).
      const baseURL = resolveFfmpegBaseURL();

      console.log('[FFmpeg] Loading FFmpeg WASM core from local files...');
      console.log('[FFmpeg] crossOriginIsolated =', typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'undefined');
      
      await ffmpegInstance.load({
        coreURL: `${baseURL}/ffmpeg-core.js`,
        wasmURL: `${baseURL}/ffmpeg-core.wasm`,
      });
      
      ffmpegLoaded = true;
      console.log('[FFmpeg] FFmpeg WASM loaded successfully');
    } catch (error) {
      // Get detailed error information
      const errorDetails = error instanceof DOMException 
        ? `DOMException: ${error.name} - ${error.message}`
        : error?.message || error?.toString() || String(error);
      console.error('[FFmpeg] Failed to load FFmpeg WASM:', errorDetails);
      console.error('[FFmpeg] Full error object:', error);
      // Reset instance so we can retry
      ffmpegInstance = null;
      throw new Error(`FFmpeg load failed: ${errorDetails}`);
    }
  }
  
  return ffmpegInstance;
}

class VideoProcessor {
  /**
   * @param {Array<{file: Blob|File|string, inputOptions?: string[]}>} inputFiles
   * @param {Object} options
   */
  constructor(inputFiles, options) {
    this.inputFiles = inputFiles;
    this.options = options;
    this.onStart = null;
    this.onProgress = null;
    this.onError = null;
    this.onEnd = null;
    this.cancelled = false;
  }

  /**
   * Set up progress tracking
   */
  async setup() {
    const ffmpeg = await getFFmpeg();
    
    ffmpeg.on('progress', ({ progress, time }) => {
      if (typeof this.onProgress === 'function') {
        this.onProgress({
          percent: Math.round(progress * 100),
          timemark: time,
        });
      }
    });
  }

  /**
   * Check if a file path contains an FFmpeg sequence pattern like %05d
   * @param {string} filePath 
   * @returns {{isSequence: boolean, pattern: string|null, padding: number|null}}
   */
  detectSequencePattern(filePath) {
    const match = filePath.match(/%0?(\d+)d/);
    if (match) {
      return {
        isSequence: true,
        pattern: match[0],
        padding: parseInt(match[1], 10)
      };
    }
    return { isSequence: false, pattern: null, padding: null };
  }

  /**
   * Find all files in the virtual filesystem matching a sequence pattern
   * @param {string} pathWithPattern - Path like "temp://media/file-%05d.png"
   * @returns {Array<{path: string, index: number}>} Sorted array of matching files
   */
  findSequenceFiles(pathWithPattern) {
    const { pattern, padding } = this.detectSequencePattern(pathWithPattern);
    if (!pattern) return [];

    // Create regex to match files: replace %05d with (\d{5}) etc
    const regexPattern = pathWithPattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex chars
      .replace(/%0?(\d+)d/, '(\\d+)'); // Replace pattern with capture group
    
    const regex = new RegExp(regexPattern);
    const matchingFiles = [];

    // Get all files from the virtual filesystem
    const allPaths = Array.from(fileSystem.tempFiles.keys());
    
    for (const path of allPaths) {
      const match = path.match(regex);
      if (match) {
        matchingFiles.push({
          path: path,
          index: parseInt(match[1], 10)
        });
      }
    }

    // Sort by index
    matchingFiles.sort((a, b) => a.index - b.index);
    return matchingFiles;
  }

  /**
   * Convert video/image sequence to output format
   * @returns {Promise<Blob>} Output video as Blob
   */
  async convert() {
    await this.setup();
    const ffmpeg = await getFFmpeg();
    
    if (typeof this.onStart === 'function') {
      this.onStart('FFmpeg WASM processing started');
    }

    // Track which input names are sequences (for FFmpeg args)
    const inputNameMap = [];

    try {
      // Write input files to FFmpeg virtual filesystem
      for (let i = 0; i < this.inputFiles.length; i++) {
        const item = this.inputFiles[i];
        
        if (item.file instanceof Blob || item.file instanceof File) {
          const inputData = await fetchFile(item.file);
          const inputName = `input${i}${pathUtils.extname(item.file?.name || item.file || '.mp4')}`;
          await ffmpeg.writeFile(inputName, inputData);
          inputNameMap.push({ name: inputName, isSequence: false });
        } else if (typeof item.file === 'string') {
          // Check if this is an image sequence pattern
          const seqInfo = this.detectSequencePattern(item.file);
          
          if (seqInfo.isSequence) {
            // Find all matching files and write them to FFmpeg FS
            const sequenceFiles = this.findSequenceFiles(item.file);
            
            if (sequenceFiles.length === 0) {
              throw new Error(`No files found matching pattern: ${item.file}`);
            }
            
            console.log(`[VideoProcessor] Found ${sequenceFiles.length} files for sequence pattern`);
            console.log(`[VideoProcessor] First file index: ${sequenceFiles[0].index}, Last: ${sequenceFiles[sequenceFiles.length-1].index}`);
            
            // Write each file to FFmpeg's virtual FS with proper numbering
            const ext = pathUtils.extname(item.file);
            const startNumber = sequenceFiles[0].index; // Get the starting index
            
            for (const seqFile of sequenceFiles) {
              const blob = await fileSystem.readFile(seqFile.path);
              if (blob) {
                const inputData = await fetchFile(blob);
                // Use FFmpeg-compatible naming: input0_00001.png, input0_00002.png, etc.
                const paddedNum = String(seqFile.index).padStart(seqInfo.padding, '0');
                const ffmpegFileName = `input${i}_${paddedNum}${ext}`;
                await ffmpeg.writeFile(ffmpegFileName, inputData);
              }
            }
            
            // For FFmpeg args, use the pattern format
            const inputPattern = `input${i}_%0${seqInfo.padding}d${ext}`;
            inputNameMap.push({ 
              name: inputPattern, 
              isSequence: true, 
              count: sequenceFiles.length,
              startNumber: startNumber // Store the start number for FFmpeg args
            });
          } else {
            // Regular single file
            const blob = await fileSystem.readFile(item.file);
            if (blob) {
              const inputData = await fetchFile(blob);
              const inputName = `input${i}${pathUtils.extname(item.file || '.mp4')}`;
              await ffmpeg.writeFile(inputName, inputData);
              inputNameMap.push({ name: inputName, isSequence: false });
            } else {
              throw new Error(`File not found: ${item.file}`);
            }
          }
        }
      }

      // Build FFmpeg command arguments
      const args = [];
      
      // Add input files
      for (let i = 0; i < this.inputFiles.length; i++) {
        const item = this.inputFiles[i];
        const inputInfo = inputNameMap[i];
        
        // Add input options (like framerate) before the -i
        if (item.inputOptions) {
          for (const opt of item.inputOptions) {
            if (opt && opt.trim()) {
              args.push(...opt.trim().split(' '));
            }
          }
        }
        
        // For image sequences, add -start_number before -i
        if (inputInfo.isSequence && inputInfo.startNumber !== undefined) {
          args.push('-start_number', String(inputInfo.startNumber));
        }
        
        args.push('-i', inputInfo.name);
      }

      // Check if outputOptions contains -filter_complex (used for alpha video hstack)
      // We can't use -vf and -filter_complex together
      const hasFilterComplex = this.options.output?.outputOptions?.some(opt => 
        opt && opt.includes('-filter_complex')
      );
      
      // Add video filter for scaling (only if not using filter_complex)
      // H.264 (libx264) requires dimensions to be divisible by 2
      let hasValidResize = false;
      if (!hasFilterComplex && this.options.resize && this.options.resize.sizeString) {
        const parts = this.options.resize.sizeString.split('x');
        if (parts.length === 2) {
          const w = parseInt(parts[0], 10);
          const h = parseInt(parts[1], 10);
          // Only use resize if we have valid positive dimensions
          if (w > 0 && h > 0 && !isNaN(w) && !isNaN(h)) {
            // Scale to target size, ensuring dimensions are divisible by 2
            const evenW = Math.floor(w / 2) * 2;
            const evenH = Math.floor(h / 2) * 2;
            args.push('-vf', `scale=${evenW}:${evenH}`);
            hasValidResize = true;
          }
        }
      }
      
      if (!hasFilterComplex && !hasValidResize && !this.options.preProcessGif) {
        // No valid resize specified, but H.264 needs dimensions divisible by 2
        // Use scale filter to round down to nearest even number
        args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      }

      // Add output options
      if (this.options.output?.outputOptions) {
        for (const opt of this.options.output.outputOptions) {
          if (opt && opt.trim()) {
            args.push(...opt.trim().split(' '));
          }
        }
      }

      // Add standard output-encoding options if not preprocessing gif (these use
      // the configurable defaults; override via setVideoDefaults).
      if (!this.options.preProcessGif) {
        args.push('-r', String(videoDefaults.fps));
        args.push('-c:v', videoDefaults.codec);
        // Preset: ultrafast > superfast > veryfast > faster > fast > medium (default).
        // CRF: 0 (lossless) to 51 (worst); 23 is default, 28 is good for web.
        args.push('-preset', videoDefaults.preset);
        // CRF = constant-quality rate control (size driven by quality; the -b:v/
        // -maxrate options act only as a ceiling). Set crf to null/'' to disable
        // it and let -b:v be the real bitrate TARGET (predictable output size).
        if (videoDefaults.crf !== null && videoDefaults.crf !== undefined && videoDefaults.crf !== '') {
          args.push('-crf', String(videoDefaults.crf));
        }
      } else {
        // When extracting GIF frames to PNG, use RGBA pixel format to preserve transparency
        args.push('-pix_fmt', 'rgba');
      }

      // Output filename
      const outputFilename = this.options.output?.filename || 'output.mp4';
      
      // Check if output is a sequence pattern (for GIF extraction)
      const outputSeqInfo = this.detectSequencePattern(outputFilename);
      
      args.push(outputFilename);

      console.log('[VideoProcessor] FFmpeg args:', args);

      // Execute FFmpeg
      try {
        await ffmpeg.exec(args);
      } catch (execError) {
        // cancel() terminates the worker mid-exec, which surfaces here as an
        // exec failure. That's an expected user action, not an error — re-throw
        // the standard cancellation sentinel quietly (no console noise) so
        // callers and the app's global handlers treat it as a clean cancel.
        if (this.cancelled) {
          throw new Error('cancelled!');
        }
        console.error('[VideoProcessor] FFmpeg exec failed:', execError);
        throw new Error(`FFmpeg execution failed: ${execError?.message || execError || 'Unknown error'}`);
      }

      let outputPath;
      
      if (outputSeqInfo.isSequence) {
        // Output is a sequence of files (e.g., GIF extraction)
        // Read all output files from FFmpeg FS and store them in our virtual FS
        console.log('[VideoProcessor] Output is a sequence, reading multiple files...');
        console.log('[VideoProcessor] Output pattern:', outputFilename, 'Padding:', outputSeqInfo.padding);
        
        // List files in FFmpeg FS that match the pattern
        const outputDir = this.options.output?.dir || '';
        let frameIndex = 1;
        let framesFound = 0;
        const maxFrames = 10000; // Safety limit
        const extractedFramePaths = []; // Track actual frame paths
        
        // Also try starting from 0 (some FFmpeg versions start at 0)
        const startIndices = [1, 0];
        
        for (const startIdx of startIndices) {
          if (framesFound > 0) break; // Already found frames
          
          frameIndex = startIdx;
          while (frameIndex <= maxFrames) {
            const paddedNum = String(frameIndex).padStart(outputSeqInfo.padding, '0');
            const frameFilename = outputFilename.replace(outputSeqInfo.pattern, paddedNum);
            
            try {
              const data = await ffmpeg.readFile(frameFilename);
              
              if (framesFound === 0) {
                console.log(`[VideoProcessor] Found first frame at index ${frameIndex}: ${frameFilename}`);
              }
              
              const frameBlob = new Blob([data.buffer], { type: 'image/png' });
              
              // Store in our virtual file system
              const framePath = pathUtils.join(outputDir, frameFilename);
              await fileSystem.writeFile(framePath, frameBlob);
              extractedFramePaths.push(framePath); // Track the path
              
              // Clean up from FFmpeg FS
              await ffmpeg.deleteFile(frameFilename);
              
              framesFound++;
              frameIndex++;
            } catch (e) {
              if (framesFound === 0 && frameIndex === startIdx) {
                console.log(`[VideoProcessor] No frame found at index ${frameIndex}, trying next start index...`);
              }
              // No more frames found at this index
              break;
            }
          }
        }
        
        if (framesFound === 0) {
          console.error('[VideoProcessor] No frames extracted from sequence!');
          // Try to list all files in FFmpeg FS to debug
          try {
            const ffmpegFiles = await ffmpeg.listDir('/');
            console.log('[VideoProcessor] Files in FFmpeg FS root:', ffmpegFiles);
          } catch (e) {
            console.log('[VideoProcessor] Could not list FFmpeg FS');
          }
          throw new Error('FFmpeg produced no output frames');
        }
        
        console.log(`[VideoProcessor] Extracted ${framesFound} frames from sequence`);
        // Return the array of actual frame paths for sequences
        outputPath = extractedFramePaths;
      } else {
        // Single output file
        let data;
        try {
          data = await ffmpeg.readFile(outputFilename);
        } catch (readError) {
          console.error('[VideoProcessor] Failed to read output file:', readError);
          throw new Error(`Video transcoding failed. FFmpeg could not create the output file. Please check if your video format is supported.`);
        }
        
        // Check if output file is empty (FFmpeg failed silently)
        if (!data || data.length === 0) {
          console.error('[VideoProcessor] FFmpeg produced empty output file');
          throw new Error(`Video transcoding failed. The output file is empty. This may be caused by an unsupported video format or codec issue.`);
        }
        
        const outputBlob = new Blob([data.buffer], { 
          type: outputFilename.endsWith('.mp4') ? 'video/mp4' : 'image/png' 
        });
        
        // Verify blob size as additional check
        if (outputBlob.size === 0) {
          console.error('[VideoProcessor] Output blob has zero size');
          throw new Error(`Video transcoding failed. Please try a different video format or resolution.`);
        }

        // Store in our file system
        outputPath = pathUtils.join(
          this.options.output?.dir || '',
          outputFilename
        );
        await fileSystem.writeFile(outputPath, outputBlob);
        
        // Cleanup output from FFmpeg filesystem
        try {
          await ffmpeg.deleteFile(outputFilename);
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      // Cleanup input files from FFmpeg filesystem
      for (let i = 0; i < inputNameMap.length; i++) {
        const inputInfo = inputNameMap[i];
        try {
          if (inputInfo.isSequence) {
            // Delete all sequence files
            const ext = pathUtils.extname(inputInfo.name);
            const seqInfo = this.detectSequencePattern(inputInfo.name);
            for (let j = 1; j <= inputInfo.count; j++) {
              const paddedNum = String(j).padStart(seqInfo.padding, '0');
              const fileName = `input${i}_${paddedNum}${ext}`;
              try {
                await ffmpeg.deleteFile(fileName);
              } catch (e) {
                // Ignore individual file cleanup errors
              }
            }
          } else {
            await ffmpeg.deleteFile(inputInfo.name);
          }
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      return outputPath;

    } catch (error) {
      if (typeof this.onError === 'function') {
        this.onError(error);
      }
      throw error;
    }
  }

  /**
   * Get video file metadata using FFprobe functionality
   * Parses FFmpeg log output to extract dimensions, duration, etc.
   * @returns {Promise<Object>}
   */
  async getFileData() {
    const ffmpeg = await getFFmpeg();
    
    const item = this.inputFiles[0];
    let inputData;
    
    if (item.file instanceof Blob || item.file instanceof File) {
      inputData = await fetchFile(item.file);
    } else if (typeof item.file === 'string') {
      const blob = await fileSystem.readFile(item.file);
      if (blob) {
        inputData = await fetchFile(blob);
      }
    }

    if (!inputData) {
      throw new Error('No input file for getFileData');
    }

    // Capture FFmpeg log output
    let ffmpegLogs = '';
    const logHandler = ({ message }) => {
      ffmpegLogs += message + '\n';
    };
    ffmpeg.on('log', logHandler);

    // Write file to get info
    await ffmpeg.writeFile('probe_input', inputData);
    
    // Metadata-only probe (FFprobe isn't available in WASM): `-i` with no output
    // makes FFmpeg print the input's stream info and then exit with an error —
    // which we ignore. We deliberately do NOT decode (no `-f null -`), so probing
    // a long clip/GIF is fast and doesn't emit a flood of frame= log lines that
    // look like a transcode.
    try {
      await ffmpeg.exec(['-i', 'probe_input']);
    } catch (e) {
      // FFmpeg prints info to stderr even on "error" - that's expected
    }

    // Remove log handler
    ffmpeg.off('log', logHandler);

    // Parse FFmpeg output for metadata
    let duration = 0;
    let width = 0;
    let height = 0;
    let hasAudio = false;
    let codecdWidth = 0;
    let codedHeight = 0;

    // Parse duration: "Duration: 00:00:01.63"
    const durationMatch = ffmpegLogs.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (durationMatch) {
      duration = 
        parseInt(durationMatch[1]) * 3600 +
        parseInt(durationMatch[2]) * 60 +
        parseInt(durationMatch[3]) +
        parseInt(durationMatch[4]) / 100;
    }

    // Parse video stream: "Video: h264 ... 1090x1054" or "1920x1080"
    const videoStreamMatch = ffmpegLogs.match(/Stream.*Video:.*?,\s*\w+.*?,\s*(\d+)x(\d+)/);
    if (videoStreamMatch) {
      width = parseInt(videoStreamMatch[1]);
      height = parseInt(videoStreamMatch[2]);
      codecdWidth = width;
      codedHeight = height;
    }

    // Parse frame rate - look for patterns like "25 fps", "29.97 fps", "25 tbr", or "30/1"
    let frameRate = '25/1'; // Default frame rate
    
    // Try to match "X fps" or "X.XX fps" pattern
    const fpsMatch = ffmpegLogs.match(/(\d+(?:\.\d+)?)\s*fps/);
    if (fpsMatch) {
      const fps = parseFloat(fpsMatch[1]);
      // Convert to fraction format (e.g., "25/1" or "30000/1001" for 29.97)
      if (fps === Math.floor(fps)) {
        frameRate = `${fps}/1`;
      } else {
        // For non-integer fps, use a reasonable denominator
        frameRate = `${Math.round(fps * 1000)}/1000`;
      }
    } else {
      // Try to match "X tbr" pattern (time base rate)
      const tbrMatch = ffmpegLogs.match(/(\d+(?:\.\d+)?)\s*tbr/);
      if (tbrMatch) {
        const tbr = parseFloat(tbrMatch[1]);
        if (tbr === Math.floor(tbr)) {
          frameRate = `${tbr}/1`;
        } else {
          frameRate = `${Math.round(tbr * 1000)}/1000`;
        }
      }
    }

    // Check for audio stream
    hasAudio = /Stream.*Audio:/.test(ffmpegLogs);

    // Richer fields (best-effort parse of the ffmpeg -i log).
    // Video: "Stream #0:0: Video: h264 (High), yuv420p, 1920x1080 ..."
    const videoCodec = (ffmpegLogs.match(/Video:\s*([A-Za-z0-9_]+)/) || [])[1] || '';
    const pixelFormat = (ffmpegLogs.match(/Video:[^\n]*?,\s*([a-z0-9]+(?:\([^)]*\))?)\s*,\s*\d+x\d+/) || [])[1] || '';
    // Audio: "Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s"
    const audioCodec = (ffmpegLogs.match(/Audio:\s*([A-Za-z0-9_]+)/) || [])[1] || '';
    const sampleRate = parseInt((ffmpegLogs.match(/Audio:[^\n]*?,\s*(\d+)\s*Hz/) || [])[1] || '0', 10);
    const channels = (ffmpegLogs.match(/Audio:[^\n]*?Hz,\s*([A-Za-z0-9.]+)/) || [])[1] || '';
    // Overall container bitrate: "bitrate: 1234 kb/s"
    const bitrateKbps = parseInt((ffmpegLogs.match(/bitrate:\s*(\d+)\s*kb\/s/) || [])[1] || '0', 10);

    // Cleanup
    try {
      await ffmpeg.deleteFile('probe_input');
    } catch (e) {}

    const metadata = {
      format: {
        duration: duration,
        size: inputData.length,
        bitrateKbps: bitrateKbps,
      },
      streams: [
        {
          codec_type: 'video',
          codec: videoCodec,
          pixelFormat: pixelFormat,
          width: width,
          height: height,
          coded_width: codecdWidth,
          coded_height: codedHeight,
          duration: duration,
          r_frame_rate: frameRate,
        },
        {
          codec_type: 'audio',
          codec: audioCodec,
          sampleRate: sampleRate,
          channels: channels,
        }
      ],
      // The full ffmpeg -i log — every available detail, for a "raw" view.
      raw: ffmpegLogs,
    };

    // Filter out audio stream if not present
    if (!hasAudio) {
      metadata.streams = metadata.streams.filter(s => s.codec_type !== 'audio');
    }

    console.log('[VideoProcessor] Parsed metadata:', { duration, width, height, hasAudio, frameRate });
    console.log('[VideoProcessor] FFmpeg logs:', ffmpegLogs);

    return metadata;
  }

  /**
   * Create a thumbnail from the first frame of a video
   * @returns {Promise<string>} Path to thumbnail
   */
  async createAnimationThumbnail() {
    const ffmpeg = await getFFmpeg();
    
    const item = this.inputFiles[0];
    let inputData;
    
    if (item.file instanceof Blob || item.file instanceof File) {
      inputData = await fetchFile(item.file);
    } else if (typeof item.file === 'string') {
      const blob = await fileSystem.readFile(item.file);
      if (blob) {
        inputData = await fetchFile(blob);
      }
    }

    if (!inputData) {
      throw new Error('No input file for thumbnail');
    }

    await ffmpeg.writeFile('thumb_input', inputData);

    const outputFilename = this.options.output?.filename || 'thumbnail.jpg';

    await ffmpeg.exec([
      '-i', 'thumb_input',
      '-ss', '0',
      '-frames:v', '1',
      '-q:v', '2',
      outputFilename
    ]);

    const data = await ffmpeg.readFile(outputFilename);
    const outputBlob = new Blob([data.buffer], { type: 'image/jpeg' });

    const outputPath = pathUtils.join(
      this.options.output?.dir || '',
      outputFilename
    );
    await fileSystem.writeFile(outputPath, outputBlob);

    // Cleanup
    try {
      await ffmpeg.deleteFile('thumb_input');
      await ffmpeg.deleteFile(outputFilename);
    } catch (e) {}

    return outputPath;
  }

  /**
   * Remove event listeners
   */
  removeListeners() {
    this.onStart = null;
    this.onProgress = null;
    this.onError = null;
    this.onEnd = null;
  }

  /**
   * Cancel processing by terminating the FFmpeg worker
   * Note: This destroys the FFmpeg instance, requiring a reload for next use
   */
  cancel() {
    this.cancelled = true;
    console.log('[VideoProcessor] Cancelling FFmpeg processing...');
    
    // Terminate the FFmpeg worker - this is the only way to stop it
    if (ffmpegInstance) {
      try {
        ffmpegInstance.terminate();
        console.log('[VideoProcessor] FFmpeg worker terminated');
      } catch (e) {
        console.warn('[VideoProcessor] Error terminating FFmpeg:', e);
      }
      // Reset state so FFmpeg will be reloaded on next use
      ffmpegInstance = null;
      ffmpegLoaded = false;
    }
  }
}

/**
 * Get video metadata using HTML5 video element
 * More reliable than FFmpeg for browser use
 * @param {Blob|File} file 
 * @returns {Promise<{duration: number, width: number, height: number, hasAudio: boolean}>}
 */
export async function getVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    
    const url = URL.createObjectURL(file);
    video.src = url;

    video.onloadedmetadata = () => {
      // Check for audio tracks using Web Audio API or MediaElement
      let hasAudio = false;
      
      // Try to detect audio using the video element's audio tracks
      if (video.audioTracks && video.audioTracks.length > 0) {
        hasAudio = true;
      } else if (video.mozHasAudio !== undefined) {
        // Firefox-specific
        hasAudio = video.mozHasAudio;
      } else if (video.webkitAudioDecodedByteCount !== undefined) {
        // Chrome-specific (requires some playback)
        // For metadata-only loading, we can't reliably detect this
        // Default to false, which is safe
        hasAudio = false;
      }
      
      const metadata = {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        hasAudio: hasAudio,
      };
      
      URL.revokeObjectURL(url);
      resolve(metadata);
    };

    video.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load video metadata: ' + (e.message || 'Unknown error')));
    };
  });
}

/**
 * Get image dimensions
 * @param {Blob|File} file 
 * @returns {Promise<{width: number, height: number}>}
 */
export async function getImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * Check if FFmpeg WASM will work in this browser
 * Returns an object with { supported: boolean, reason?: string }
 */
export function checkFFmpegSupport() {
  // Check if SharedArrayBuffer is available
  if (!checkCrossOriginIsolation()) {
    // Detect Safari
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    
    if (isSafari) {
      return {
        supported: false,
        reason: 'Safari does not support video transcoding.\nPlease use Chrome, Firefox, or Edge.',
        browser: 'Safari'
      };
    }
    
    return {
      supported: false,
      reason: 'This browser does not support video transcoding.\nPlease use Chrome, Firefox, or Edge.',
      browser: 'unknown'
    };
  }
  
  return { supported: true };
}

export default VideoProcessor;
