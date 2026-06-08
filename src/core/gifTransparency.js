/**
 * Transparency detection — extracted from web's `shims/sharp.js`.
 *
 * Determines whether an image (notably a GIF) carries transparency. The pipeline
 * uses this to decide between the opaque transcode path and the alpha
 * (colour|alpha side-by-side) path. The web `sharp` shim re-wraps `isOpaque`
 * into the `sharp(input).stats() → { isOpaque }` shape its call sites expect.
 */

import { fileSystem } from './FileSystem';

/**
 * Check if a GIF has transparency by parsing its binary data. GIF transparency
 * is flagged by a Graphic Control Extension (0x21 0xF9) with bit 0 of the packed
 * byte set. Returns null if the input is not a parseable GIF (caller falls back).
 * @param {Blob} blob
 * @returns {Promise<boolean|null>}
 */
export async function checkGifTransparency(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // GIF signature (GIF87a / GIF89a).
    const signature = String.fromCharCode(...bytes.slice(0, 6));
    if (!signature.startsWith('GIF')) {
      return null; // Not a GIF.
    }
    // Only GIF89a supports transparency.
    if (signature !== 'GIF89a') {
      return false;
    }
    // Search for Graphic Control Extension blocks (0x21 0xF9).
    for (let i = 0; i < bytes.length - 8; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xF9) {
        const packedByte = bytes[i + 3];
        const hasTransparency = (packedByte & 0x01) === 1;
        if (hasTransparency) {
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    console.warn('[transcoder] Error parsing GIF for transparency:', err);
    return null;
  }
}

async function loadBlobAndFilename(input) {
  let blob;
  let filename = 'unknown';

  if (input instanceof Blob || input instanceof File) {
    blob = input;
    filename = input.name || 'uploaded file';
  } else if (typeof input === 'string') {
    filename = input;
    blob = await fileSystem.readFile(input); // virtual FS
    if (!blob) {
      const resp = await fetch(input); // fallback to network
      blob = await resp.blob();
    }
  } else {
    throw new Error('transcoder: unsupported input type for transparency detection');
  }

  return { blob, filename };
}

async function isOpaqueFromBitmap(bitmap) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);

  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the image is fully opaque (no transparency).
 * @param {Blob|File|string} input
 * @returns {Promise<boolean>}
 */
export async function isOpaque(input) {
  const { blob, filename } = await loadBlobAndFilename(input);

  // For GIFs, prefer binary parsing — createImageBitmap doesn't reliably preserve
  // GIF transparency across browsers.
  const isGif = filename.toLowerCase().endsWith('.gif') || blob.type === 'image/gif';
  if (isGif) {
    const gifHasTransparency = await checkGifTransparency(blob);
    if (gifHasTransparency !== null) {
      return !gifHasTransparency;
    }
    // else fall through to the bitmap check.
  }

  const bitmap = await createImageBitmap(blob);
  return isOpaqueFromBitmap(bitmap);
}

/**
 * Whether the image carries transparency (the inverse of isOpaque).
 * @param {Blob|File|string} input
 * @returns {Promise<boolean>}
 */
export async function detectGifTransparency(input) {
  return !(await isOpaque(input));
}
