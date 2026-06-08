import { describe, it, expect } from 'vitest';
import { classifyAnimation } from '../pipeline/branches';

describe('classifyAnimation', () => {
  it('image sequence wins regardless of other flags', () => {
    expect(classifyAnimation({ isSequence: true, isGif: false, hasAlpha: false })).toBe('sequence');
    expect(classifyAnimation({ isSequence: true, isGif: true, hasAlpha: true })).toBe('sequence');
  });
  it('gif splits on alpha', () => {
    expect(classifyAnimation({ isSequence: false, isGif: true, hasAlpha: true })).toBe('gifAlpha');
    expect(classifyAnimation({ isSequence: false, isGif: true, hasAlpha: false })).toBe('gifOpaque');
  });
  it('otherwise plain video', () => {
    expect(classifyAnimation({ isSequence: false, isGif: false, hasAlpha: false })).toBe('video');
    expect(classifyAnimation({ isSequence: false, isGif: false, hasAlpha: true })).toBe('video');
  });
});
