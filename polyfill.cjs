/**
 * Polyfill for File API in Node.js 18
 * This file must be loaded BEFORE the main application to ensure File is available
 * before undici is imported.
 */

// Only polyfill if File is not already available (Node.js 18)
if (typeof globalThis.File === 'undefined') {
  // Node.js 18 has Blob but not File
  class FilePolyfill extends Blob {
    constructor(fileBits, fileName, options) {
      super(fileBits, options);
      this.name = fileName;
      this.lastModified = options?.lastModified ?? Date.now();
    }

    get [Symbol.toStringTag]() {
      return 'File';
    }
  }

  globalThis.File = FilePolyfill;

  if (process.env.NODE_ENV === 'development') {
    console.log('[polyfills] File API polyfill applied for Node.js 18');
  }
}
