// Pure branch classification for the animation pipeline.

import type { AnimationBranch } from '../types';

export interface BranchFlags {
  isSequence: boolean;
  isGif: boolean;
  hasAlpha: boolean;
}

/**
 * Pick the animation pipeline branch:
 *   isSequence            → 'sequence'  (per-frame image processing → mp4)
 *   isGif &&  hasAlpha    → 'gifAlpha'  (extract frames → alpha sequence → mp4)
 *   isGif && !hasAlpha    → 'gifOpaque' (direct gif → mp4)
 *   otherwise             → 'video'     (plain video → mp4)
 * Note: a sequence's own hasAlpha is resolved later (frame extension + flag);
 * classification only needs to route sequence vs gif vs video here.
 */
export function classifyAnimation(flags: BranchFlags): AnimationBranch {
  if (flags.isSequence) return 'sequence';
  if (flags.isGif) return flags.hasAlpha ? 'gifAlpha' : 'gifOpaque';
  return 'video';
}
