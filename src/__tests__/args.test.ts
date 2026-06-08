import { describe, it, expect } from 'vitest';
import {
  resize,
  buildSizeStrings,
  buildShortestString,
  buildStreamSelect,
  buildFrameRateString,
  buildDurationString,
  bitrateTriple,
  buildGifOutputOptions,
  buildColourSequenceOutputOptions,
  buildAlphaSequenceOutputOptions,
  buildVideoOutputOptions,
  type BranchArgs,
} from '../pipeline/args';

describe('resize', () => {
  it('does not enlarge a small input (but still rounds to even)', () => {
    expect(resize({ w: 100, h: 100 }, { w: 1024, h: 1024 })).toEqual({ w: 100, h: 100 });
    expect(resize({ w: 101, h: 101 }, { w: 1024, h: 1024 })).toEqual({ w: 100, h: 100 });
  });
  it('fits within the cap preserving aspect, rounded down to even', () => {
    expect(resize({ w: 2000, h: 2000 }, { w: 1024, h: 1024 })).toEqual({ w: 1024, h: 1024 });
    expect(resize({ w: 1920, h: 1080 }, { w: 1280, h: 1280 })).toEqual({ w: 1280, h: 720 });
    // non-even result rounds down
    expect(resize({ w: 1000, h: 333 }, { w: 500, h: 500 })).toEqual({ w: 500, h: 166 });
  });
});

describe('buildSizeStrings', () => {
  it('produces WxH, alpha hstack target (2W), and W:H', () => {
    expect(buildSizeStrings({ w: 512, h: 512 })).toEqual({
      sizeString: '512x512',
      sizeStringAlpha: 'scale=w=1024:h=512',
      sizeStringSar: '512:512',
    });
  });
});

describe('derived string helpers', () => {
  it('buildShortestString: -shortest only when audio outlasts the animation', () => {
    expect(buildShortestString(5, 10)).toBe('-shortest');
    expect(buildShortestString(10, 5)).toBe('-framerate 25');
    expect(buildShortestString(5, 5)).toBe('-framerate 25');
  });
  it('buildStreamSelect: explicit maps with audio, framerate stubs without', () => {
    expect(buildStreamSelect(true, 'a.mp3')).toEqual({ animation: '-map 0:v', audio: '-map 1:a' });
    expect(buildStreamSelect(true, '')).toEqual({ animation: '-framerate 25', audio: '-framerate 25' });
    expect(buildStreamSelect(false, 'a.mp3')).toEqual({ animation: '-framerate 25', audio: '-framerate 25' });
  });
  it('buildFrameRateString: gif uses -r, else -stream_loop 0', () => {
    expect(buildFrameRateString(true, 12)).toBe('-r 12');
    expect(buildFrameRateString(true, '')).toBe('-r 25');
    expect(buildFrameRateString(false, 30)).toBe('-stream_loop 0');
  });
  it('buildDurationString + bitrateTriple', () => {
    expect(buildDurationString(30)).toBe('-t 30');
    expect(bitrateTriple('8M')).toEqual(['-b:v 8M', '-maxrate 8M', '-bufsize 8M']);
  });
});

// Shared BranchArgs builder for the per-branch option tests.
function args(over: Partial<BranchArgs> = {}): BranchArgs {
  return {
    streams: { animation: '-framerate 25', audio: '-framerate 25' },
    sizes: buildSizeStrings({ w: 512, h: 512 }),
    shortest: '-framerate 25',
    durationString: '-t 30',
    bitrate: '8M',
    hasAudio: false,
    ...over,
  };
}

describe('per-branch output options (ProcessingPage parity)', () => {
  it('gif (opaque) — streamAnimation, yuv420p, shortest, bitrate triple', () => {
    expect(buildGifOutputOptions(args())).toEqual([
      '-framerate 25', '-pix_fmt yuv420p', '-framerate 25',
      '-b:v 8M', '-maxrate 8M', '-bufsize 8M',
    ]);
  });

  it('gif with audio — appends the audio map', () => {
    const a = args({ hasAudio: true, streams: { animation: '-map 0:v', audio: '-map 1:a' }, shortest: '-shortest' });
    expect(buildGifOutputOptions(a)).toEqual([
      '-map 0:v', '-pix_fmt yuv420p', '-shortest',
      '-b:v 8M', '-maxrate 8M', '-bufsize 8M', '-map 1:a',
    ]);
  });

  it('colour-only sequence — no stream maps; audio appends shortest', () => {
    expect(buildColourSequenceOutputOptions(args())).toEqual([
      '-pix_fmt yuv420p', '-t 30', '-b:v 8M', '-maxrate 8M', '-bufsize 8M',
    ]);
    expect(buildColourSequenceOutputOptions(args({ hasAudio: true, shortest: '-shortest' }))).toEqual([
      '-pix_fmt yuv420p', '-t 30', '-b:v 8M', '-maxrate 8M', '-bufsize 8M', '-shortest',
    ]);
  });

  it('alpha sequence — filter_complex hstack with the 2W scale target', () => {
    expect(buildAlphaSequenceOutputOptions(args())).toEqual([
      '-pix_fmt yuv420p',
      '-filter_complex hstack,scale=w=1024:h=512',
      '-t 30', '-b:v 8M', '-maxrate 8M', '-bufsize 8M',
    ]);
  });

  it('plain video — setsar with the W:H scale, shortest + duration + bitrate', () => {
    const a = args({ shortest: '-shortest' });
    expect(buildVideoOutputOptions(a)).toEqual([
      '-framerate 25', '-pix_fmt yuv420p', "-vf scale='512:512',setsar=1/1",
      '-shortest', '-t 30', '-b:v 8M', '-maxrate 8M', '-bufsize 8M',
    ]);
  });

  it('plain video with audio — maps 0:v / 1:a around the options', () => {
    const a = args({ hasAudio: true, streams: { animation: '-map 0:v', audio: '-map 1:a' }, shortest: '-shortest' });
    expect(buildVideoOutputOptions(a)).toEqual([
      '-map 0:v', '-pix_fmt yuv420p', "-vf scale='512:512',setsar=1/1",
      '-shortest', '-t 30', '-b:v 8M', '-maxrate 8M', '-bufsize 8M', '-map 1:a',
    ]);
  });
});
