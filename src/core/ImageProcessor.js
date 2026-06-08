/**
 * Browser ImageProcessor using the Canvas API (no native sharp). Generic resize/
 * crop/pad/format with optional alpha transforms — no app-specific presets.
 */

import { fileSystem, pathUtils } from './FileSystem';

/**
 * Pure pixel transform, applied in place to an ImageData (returns it). Extracted
 * so the math is unit-testable without a real canvas (a plain { data } works).
 *   - 'extractAlpha': copy the alpha channel into RGB (grayscale alpha map), A=255.
 *   - 'premultiply' : premultiply RGB by alpha (flatten transparency to black), A=255.
 * Any other value is a no-op.
 * @param {('extractAlpha'|'premultiply'|null)} transform
 * @param {ImageData} imageData
 * @returns {ImageData}
 */
export function applyMode(transform, imageData) {
  const data = imageData.data;
  if (transform === 'extractAlpha') {
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      data[i] = alpha;     // R
      data[i + 1] = alpha; // G
      data[i + 2] = alpha; // B
      data[i + 3] = 255;   // A
    }
  } else if (transform === 'premultiply') {
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      data[i] = Math.round(data[i] * alpha);         // R
      data[i + 1] = Math.round(data[i + 1] * alpha); // G
      data[i + 2] = Math.round(data[i + 2] * alpha); // B
      data[i + 3] = 255;                             // A
    }
  }
  return imageData;
}

class ImageProcessor {
  /**
   * @param {Blob|File|string} inputFile - Image file or virtual-FS path
   * @param {Object} options
   * @param {{w:number,h:number}} options.targetSize - Max target dimensions
   * @param {boolean} [options.noEnlarge=true] - Never upscale beyond native size
   * @param {boolean} [options.square=false] - Crop to a square (native width)
   * @param {{w:number,h:number}|null} [options.aspect=null] - Pad canvas to this aspect, image centred
   * @param {string|null} [options.background=null] - Background fill colour
   * @param {('extractAlpha'|'premultiply'|null)} [options.transform=null] - Alpha pixel transform
   * @param {('png'|'jpeg')} [options.format='png'] - Output encoding
   * @param {number} [options.quality=0.92] - Output quality (jpeg/png)
   * @param {{dir:string,filename:string}} options.output - Output dir + filename
   */
  constructor(inputFile, options) {
    // Validate input file early
    if (!inputFile) {
      throw new Error('ImageProcessor: No input file provided. Please select an image first.');
    }
    if (typeof inputFile === 'string' && inputFile.trim() === '') {
      throw new Error('ImageProcessor: Empty file path provided. Please select an image first.');
    }
    
    this.inputFile = inputFile;
    this.options = options || this.defaultOptions();
    this.canvas = null;
    this.ctx = null;
  }

  defaultOptions() {
    return {
      targetSize: { w: 512, h: 512 },
      output: { dir: '', filename: '' }
    };
  }

  /**
   * Load image from Blob/File or path
   * @returns {Promise<ImageBitmap>}
   */
  async loadImage() {
    let blob;
    let filename = 'unknown';
    
    if (this.inputFile instanceof Blob || this.inputFile instanceof File) {
      blob = this.inputFile;
      filename = this.inputFile.name || 'uploaded file';
    } else if (typeof this.inputFile === 'string') {
      blob = await fileSystem.readFile(this.inputFile);
      filename = this.inputFile;
      if (!blob) {
        throw new Error(`Image not found: ${this.inputFile}`);
      }
    } else {
      throw new Error('Invalid input file type');
    }

    let img;
    try {
      img = await createImageBitmap(blob);
    } catch (err) {
      // Handle file permission errors (file moved/deleted/renamed after selection)
      if (err.name === 'NotReadableError' || 
          err.message?.includes('could not be read') ||
          err.message?.includes('not be decoded') ||
          err.name === 'InvalidStateError') {
        // Extract just the filename from the path
        const displayName = typeof filename === 'string' ? filename.split('/').pop() : 'file';
        // Check if this is a File object (reference to disk) vs a Blob (in-memory)
        const isFileReference = blob instanceof File;
        if (isFileReference) {
          throw new Error(`The file "${displayName}" is no longer accessible.\nIt may have been moved, renamed, or deleted since it was selected.\nPlease select the file again.`);
        }
        throw new Error(`The image "${displayName}" could not be opened.\nIt may be corrupt, damaged, or in an unsupported format.`);
      }
      throw err;
    }
    
    // Validate image dimensions
    if (!img.width || !img.height || img.width === 0 || img.height === 0) {
      throw new Error(`Invalid image dimensions (${img.width}x${img.height}). The image may be corrupt or in an unsupported format.`);
    }
    
    return img;
  }

  /**
   * Get image metadata
   * @returns {Promise<{width: number, height: number}>}
   */
  async metadata() {
    const img = await this.loadImage();
    return {
      width: img.width,
      height: img.height
    };
  }

  /**
   * Calculate resize dimensions maintaining aspect ratio
   */
  calculateResizeDimensions(srcWidth, srcHeight, targetWidth, targetHeight, fit = 'inside') {
    const srcRatio = srcWidth / srcHeight;
    const targetRatio = targetWidth / targetHeight;

    let newWidth, newHeight;

    if (fit === 'inside') {
      if (srcRatio > targetRatio) {
        newWidth = Math.min(srcWidth, targetWidth);
        newHeight = newWidth / srcRatio;
      } else {
        newHeight = Math.min(srcHeight, targetHeight);
        newWidth = newHeight * srcRatio;
      }
    } else if (fit === 'cover') {
      if (srcRatio > targetRatio) {
        newHeight = targetHeight;
        newWidth = newHeight * srcRatio;
      } else {
        newWidth = targetWidth;
        newHeight = newWidth / srcRatio;
      }
    } else if (fit === 'contain') {
      if (srcRatio > targetRatio) {
        newWidth = targetWidth;
        newHeight = newWidth / srcRatio;
      } else {
        newHeight = targetHeight;
        newWidth = newHeight * srcRatio;
      }
    }

    return {
      width: Math.round(newWidth),
      height: Math.round(newHeight)
    };
  }

  /**
   * Compute the canvas layout (sizes + draw rect) for the configured options.
   * Three strategies — aspect-pad, square-crop, or fit-inside (default) — each a
   * generic operation. Returns the canvas + draw geometry + background.
   */
  _computeLayout(img) {
    const { w: targetW, h: targetH } = this.options.targetSize;
    const { aspect = null, square = false, noEnlarge = true, background = null } = this.options;

    if (aspect) {
      // Pad canvas to `aspect`, image centred at native size.
      let canvasWidth, canvasHeight;
      if (img.width / aspect.w >= img.height / aspect.h) {
        canvasWidth = img.width;
        canvasHeight = Math.floor((img.width / aspect.w) * aspect.h);
      } else {
        canvasHeight = img.height;
        canvasWidth = Math.floor((img.height / aspect.h) * aspect.w);
      }
      return {
        canvasWidth, canvasHeight,
        drawWidth: img.width, drawHeight: img.height,
        drawX: (canvasWidth - img.width) / 2, drawY: (canvasHeight - img.height) / 2,
        background,
      };
    }

    if (square && img.height > img.width) {
      // Portrait → crop to a square of the native width (shift up). Landscape
      // images fall through to fit-inside (a square crop would distort them).
      return {
        canvasWidth: img.width, canvasHeight: img.width,
        drawWidth: img.width, drawHeight: img.width,
        drawX: 0, drawY: -(img.height - img.width) / 2,
        background,
      };
    }

    // Fit inside the target, preserving aspect; never enlarge.
    const dims = this.calculateResizeDimensions(img.width, img.height, targetW, targetH, 'inside');
    const native = noEnlarge && img.width <= targetW && img.height <= targetH;
    const w = native ? img.width : dims.width;
    const h = native ? img.height : dims.height;
    return { canvasWidth: w, canvasHeight: h, drawWidth: w, drawHeight: h, drawX: 0, drawY: 0, background };
  }

  /** Set up the canvas + draw + optional alpha transform per the generic options. */
  async setup() {
    if (!this.options.targetSize) {
      throw new Error('ImageProcessor: options.targetSize is required.');
    }

    const img = await this.loadImage();
    const { canvasWidth, canvasHeight, drawWidth, drawHeight, drawX, drawY, background } = this._computeLayout(img);

    if (!canvasWidth || !canvasHeight || canvasWidth <= 0 || canvasHeight <= 0) {
      throw new Error(`Invalid canvas dimensions (${canvasWidth}x${canvasHeight}). Source image may be corrupt.`);
    }

    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    } else {
      this.canvas = document.createElement('canvas');
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
    }
    this.ctx = this.canvas.getContext('2d');

    if (background) {
      this.ctx.fillStyle = background;
      this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    }

    this.ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

    // Optional alpha pixel transform (extract / premultiply) via the pure helper.
    if (this.options.transform === 'extractAlpha' || this.options.transform === 'premultiply') {
      const imageData = this.ctx.getImageData(0, 0, canvasWidth, canvasHeight);
      applyMode(this.options.transform, imageData);
      this.ctx.putImageData(imageData, 0, 0);
    }

    this._outputType = this.options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    this._quality = typeof this.options.quality === 'number' ? this.options.quality : 0.92;
  }

  /**
   * Convert and save the processed image
   * @returns {Promise<{width: number, height: number}>}
   */
  async convert() {
    await this.setup();

    let blob;
    if (this.canvas.convertToBlob) {
      // OffscreenCanvas
      blob = await this.canvas.convertToBlob({ 
        type: this._outputType, 
        quality: this._quality 
      });
    } else {
      // Regular canvas - use toBlob
      blob = await new Promise((resolve) => {
        this.canvas.toBlob(resolve, this._outputType, this._quality);
      });
    }

    // Save to file system
    const outputPath = pathUtils.join(
      this.options.output.dir,
      this.options.output.filename
    );
    await fileSystem.writeFile(outputPath, blob);

    return {
      width: this.canvas.width,
      height: this.canvas.height
    };
  }

  /**
   * Start processing (alias for convert for API compatibility)
   */
  async start() {
    return this.convert();
  }
}

/**
 * Get image dimensions from a file
 * @param {Blob|File} file 
 * @returns {Promise<{width: number, height: number}>}
 */
export async function getImageSize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

export default ImageProcessor;
