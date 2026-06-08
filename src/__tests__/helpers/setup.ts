// Tier A (unit) test setup — jsdom. The pure pipeline tests (args/branches/
// imageModes) don't touch FFmpeg, but if a unit test ever instantiates the
// VideoProcessor path we stub the WASM runtime so getFFmpeg() short-circuits
// instead of trying to load the 32MB core.
import { vi } from 'vitest';

// Pretend the page is cross-origin isolated (FFmpeg's SharedArrayBuffer gate).
if (!('crossOriginIsolated' in globalThis)) {
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
}

// Minimal mock FFmpeg: records exec() args, returns canned bytes from readFile().
class MockFFmpeg {
  public calls: string[][] = [];
  private handlers: Record<string, Array<(e: unknown) => void>> = {};
  on(evt: string, cb: (e: unknown) => void) { (this.handlers[evt] ??= []).push(cb); }
  off() { /* noop */ }
  async load() { /* noop */ }
  async writeFile() { /* noop */ }
  async readFile() { return new Uint8Array([0, 0, 0, 0]); }
  async deleteFile() { /* noop */ }
  async listDir() { return []; }
  async exec(args: string[]) { this.calls.push(args); }
  terminate() { /* noop */ }
}

(globalThis as unknown as { FFmpegWASM?: unknown }).FFmpegWASM = { FFmpeg: MockFFmpeg };

// Some environments lack ImageData; the imageMode tests pass a plain {data} object,
// so no global is required. This file mainly guarantees the ffmpeg gate is mocked.
export {};
