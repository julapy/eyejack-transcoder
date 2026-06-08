import { describe, it, expect } from 'vitest';
import { applyMode } from '../core/ImageProcessor';

// applyMode only reads imageData.data, so a plain { data } object suffices — no canvas.
const make = (px: number[]) => ({ data: new Uint8ClampedArray(px) });

describe('applyMode extractAlpha (alpha → grayscale, opaque out)', () => {
  it('copies the alpha channel into RGB and sets A=255', () => {
    const img = make([
      10, 20, 30, 128,   // mid alpha → grey 128
      255, 255, 255, 0,  // transparent → black
      99, 99, 99, 255,   // opaque → white
    ]);
    applyMode('extractAlpha', img as unknown as ImageData);
    expect(Array.from(img.data)).toEqual([
      128, 128, 128, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
  });
});

describe('applyMode premultiply (premultiply RGB by alpha, flatten to black)', () => {
  it('premultiplies each channel and sets A=255', () => {
    const img = make([
      200, 100, 50, 128, // alpha≈0.502 → 100,50,25
      255, 255, 255, 0,  // transparent → black
      40, 80, 120, 255,  // opaque → unchanged
    ]);
    applyMode('premultiply', img as unknown as ImageData);
    expect(Array.from(img.data)).toEqual([
      100, 50, 25, 255,
      0, 0, 0, 255,
      40, 80, 120, 255,
    ]);
  });
});

describe('applyMode no transform', () => {
  it('is a no-op when transform is null', () => {
    const img = make([1, 2, 3, 4]);
    applyMode(null, img as unknown as ImageData);
    expect(Array.from(img.data)).toEqual([1, 2, 3, 4]);
  });
});
