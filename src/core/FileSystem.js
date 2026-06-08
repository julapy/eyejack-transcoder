/**
 * Browser-compatible in-memory FileSystem adapter.
 * Replaces Node.js fs/fs-extra/path modules with browser APIs (Blob + Map),
 * plus optional IndexedDB persistence. Generic — no app-specific assumptions.
 */

import { get, set, del, keys } from 'idb-keyval';

const DEFAULT_WORKING_DIR = 'temp://media';

class FileSystemAdapter {
  constructor(workingDir = DEFAULT_WORKING_DIR) {
    // In-memory storage for temp files during a processing session.
    this.tempFiles = new Map();
    this.workingDir = workingDir;
  }

  /**
   * Get a temporary working directory path (virtual path for browser)
   */
  getWorkingDir() {
    return this.workingDir;
  }

  /**
   * Write a file to temp storage
   * @param {string} path - Virtual file path
   * @param {Blob|ArrayBuffer|string} data - File data
   */
  async writeFile(path, data) {
    let blob;
    if (data instanceof Blob) {
      blob = data;
    } else if (data instanceof ArrayBuffer) {
      blob = new Blob([data]);
    } else if (typeof data === 'string') {
      blob = new Blob([data], { type: 'text/plain' });
    } else {
      blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    }
    this.tempFiles.set(path, blob);
  }

  /**
   * Write file synchronously (for compatibility - actually async in browser)
   */
  writeFileSync(path, data) {
    this.writeFile(path, data);
  }

  /**
   * Read a file from temp storage
   * @param {string} path - Virtual file path
   * @returns {Promise<Blob>}
   */
  async readFile(path) {
    return this.tempFiles.get(path);
  }

  /**
   * Read file as ArrayBuffer
   * @param {string} path - Virtual file path
   * @returns {Promise<ArrayBuffer>}
   */
  async readFileAsArrayBuffer(path) {
    const blob = this.tempFiles.get(path);
    if (blob) {
      return blob.arrayBuffer();
    }
    return null;
  }

  /**
   * Read file as text
   * @param {string} path - Virtual file path
   * @returns {Promise<string>}
   */
  async readFileAsText(path) {
    const blob = this.tempFiles.get(path);
    if (blob) {
      return blob.text();
    }
    return null;
  }

  /**
   * Check if file exists in temp storage
   * @param {string} path - Virtual file path
   * @returns {boolean}
   */
  existsSync(path) {
    return this.tempFiles.has(path);
  }

  /**
   * Delete a file from temp storage
   * @param {string} path - Virtual file path
   */
  async unlink(path) {
    this.tempFiles.delete(path);
  }

  unlinkSync(path) {
    this.tempFiles.delete(path);
  }

  /**
   * Get file stats (size, etc.)
   * @param {string} path - Virtual file path
   * @returns {Object}
   */
  statSync(path) {
    const blob = this.tempFiles.get(path);
    if (blob) {
      return {
        size: blob.size,
        isFile: () => true,
        isDirectory: () => false,
      };
    }
    return null;
  }

  /**
   * List files in temp storage matching a prefix
   * @param {string} prefix - Path prefix to match
   * @returns {string[]}
   */
  readdirSync(prefix) {
    const files = [];
    for (const path of this.tempFiles.keys()) {
      if (path.startsWith(prefix)) {
        files.push(path.replace(prefix + '/', ''));
      }
    }
    return files;
  }

  /**
   * Copy file (in memory)
   * @param {string} src - Source path
   * @param {string} dest - Destination path
   */
  copyFileSync(src, dest) {
    const blob = this.tempFiles.get(src);
    if (blob) {
      this.tempFiles.set(dest, blob);
    }
  }

  /**
   * Clear all temp files
   */
  clearTemp() {
    this.tempFiles.clear();
  }

  /**
   * Store a File object from user input
   * @param {File} file - File from input element
   * @param {string} [customPath] - Optional custom path
   * @returns {string} The virtual path for this file
   */
  storeUserFile(file, customPath = null) {
    const path = customPath || `${this.workingDir}/${file.name}`;
    this.tempFiles.set(path, file);
    return path;
  }

  /**
   * Get blob URL for preview
   * @param {string} path - Virtual file path
   * @returns {string|null}
   */
  getBlobUrl(path) {
    const blob = this.tempFiles.get(path);
    if (blob) {
      return URL.createObjectURL(blob);
    }
    return null;
  }

  /**
   * Revoke a blob URL
   * @param {string} url - Blob URL to revoke
   */
  revokeBlobUrl(url) {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Download a file to user's computer
   * @param {Blob|string} data - File data or path to temp file
   * @param {string} filename - Download filename
   */
  async downloadFile(data, filename) {
    let blob;
    if (typeof data === 'string') {
      blob = this.tempFiles.get(data);
    } else {
      blob = data;
    }
    
    if (!blob) {
      throw new Error('No data to download');
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Save to IndexedDB for persistence across sessions
   * @param {string} key - Storage key
   * @param {*} value - Value to store
   */
  async persistToIDB(key, value) {
    await set(key, value);
  }

  /**
   * Load from IndexedDB
   * @param {string} key - Storage key
   * @returns {Promise<*>}
   */
  async loadFromIDB(key) {
    return get(key);
  }

  /**
   * Delete from IndexedDB
   * @param {string} key - Storage key
   */
  async deleteFromIDB(key) {
    await del(key);
  }

  /**
   * List all keys in IndexedDB
   * @returns {Promise<string[]>}
   */
  async listIDBKeys() {
    return keys();
  }
}

// Path utilities (browser-compatible replacements for Node.js path module)
export const pathUtils = {
  basename(filepath, ext = '') {
    if (!filepath || typeof filepath !== 'string') {
      console.warn('[pathUtils.basename] Invalid filepath:', filepath);
      return '';
    }
    const parts = filepath.split('/');
    let name = parts[parts.length - 1] || parts[parts.length - 2] || '';
    if (ext && name.endsWith(ext)) {
      name = name.slice(0, -ext.length);
    }
    return name;
  },

  dirname(filepath) {
    if (!filepath || typeof filepath !== 'string') {
      console.warn('[pathUtils.dirname] Invalid filepath:', filepath);
      return '';
    }
    const parts = filepath.split('/');
    parts.pop();
    return parts.join('/') || '/';
  },

  extname(filepath) {
    if (!filepath || typeof filepath !== 'string') {
      console.warn('[pathUtils.extname] Invalid filepath:', filepath);
      return '';
    }
    const basename = pathUtils.basename(filepath);
    const dotIndex = basename.lastIndexOf('.');
    if (dotIndex <= 0) return '';
    return basename.slice(dotIndex);
  },

  join(...parts) {
    // Filter out null/undefined/empty parts
    const validParts = parts.filter(p => p != null && p !== '');
    const joined = validParts.join('/');
    // Replace multiple slashes but preserve protocol slashes (e.g., temp://, https://)
    // First preserve :// sequences, then normalize other multiple slashes
    return joined
      .replace(/:\/\//g, ':<PROTO_SLASH>')  // Temporarily protect protocol slashes
      .replace(/\/+/g, '/')                  // Normalize multiple slashes to single
      .replace(/<PROTO_SLASH>/g, '//');      // Restore protocol slashes
  },

  normalize(filepath) {
    if (!filepath || typeof filepath !== 'string') {
      return '';
    }
    // Replace multiple slashes but preserve protocol slashes (e.g., temp://, https://)
    return filepath
      .replace(/:\/\//g, ':<PROTO_SLASH>')  // Temporarily protect protocol slashes
      .replace(/\/+/g, '/')                  // Normalize multiple slashes to single
      .replace(/<PROTO_SLASH>/g, '//');      // Restore protocol slashes
  },
};

// Singleton instance
export const fileSystem = new FileSystemAdapter();

export default FileSystemAdapter;
