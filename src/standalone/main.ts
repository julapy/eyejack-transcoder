// Standalone harness bootstrap. Builds the GUI AND exposes the same operations on
// `window` so agents (Preview/Chrome MCP) and e2e tests drive the identical
// pipeline a human clicks through:
//   window.transcoder            — the configured ITranscoder facade
//   window.transcodeFile(f,opts) — resolve a File/Blob/URL/virtual-path → output
//   window.transcodeSequence(fs) — image-sequence frames → output
//   window.transcodeFixture(url) — fetch a fixture URL then transcodeFile
//   window.probeMedia(input)     — probe codec/resolution/fps/audio of a file/blob/URL/virtual path
//   window.__transcodeLog        — array of every event/log line (for inspection)

import { Transcoder } from '../pipeline/Transcoder';
import { fileSystem } from '../core/index';
import { buildUI } from './ui';
import { transcodeFile, transcodeSequence, probeMedia, type TranscodeFileOpts } from '../runtime/index';

const transcoder = new Transcoder({
  ffmpegBaseURL: '/ffmpeg',
  transcodeSettings: {
    maxBitrate: '8M',
    maxAnimationDuration: 30,
    maxVideoDimensions: { alpha: { w: 1024, h: 1024 }, noAlpha: { w: 1920, h: 1920 } },
  },
});

const transcodeLog: string[] = [];

// ---- UI wiring ------------------------------------------------------------

const root = document.getElementById('app')!;
const ui = buildUI(root);

transcoder.events.onAny((name, payload) => {
  let line: string;
  if (name === 'log') line = `  ${(payload as { message: string }).message}`;
  else line = `[${name}] ${JSON.stringify(payload)}`;
  transcodeLog.push(line);
  ui.appendLog(line);
  if (name === 'progress') ui.setProgress((payload as { percent: number }).percent);
});

ui.onStart(async (files: File[]) => {
  ui.clearLog();
  transcodeLog.length = 0;
  ui.setProgress(0);
  ui.setStatus('Starting…');
  const t0 = performance.now();
  try {
    // Type + alpha are auto-detected; multiple files → image sequence.
    const fileOpts: TranscodeFileOpts = { type: 'auto' };
    const result = files.length > 1
      ? await transcodeSequence(transcoder, files, fileOpts)
      : await transcodeFile(transcoder, files[0], fileOpts);
    ui.setProgress(100);
    ui.setStatus(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s → ${result.path}`);
    const url = fileSystem.getBlobUrl(result.path);
    if (url) ui.showOutput(url, result.kind, result.path.split('/').pop() || 'output');
  } catch (e) {
    ui.setStatus(e instanceof Error ? e.message : String(e), true);
  }
});

// ---- window API (agents + e2e tests) --------------------------------------

const api = {
  transcoder,
  transcodeFile: (input: File | Blob | string, opts?: TranscodeFileOpts) => transcodeFile(transcoder, input, opts),
  transcodeSequence: (inputs: Array<File | Blob | string>, opts?: TranscodeFileOpts) => transcodeSequence(transcoder, inputs, opts),
  transcodeFixture: (url: string, opts?: TranscodeFileOpts) => transcodeFile(transcoder, url, opts),
  probeMedia,
  fileSystem,
  __transcodeLog: transcodeLog,
};
Object.assign(window as unknown as Record<string, unknown>, api);

console.log('[transcoder] Standalone harness ready. window.transcoder / window.transcodeFile available.');
