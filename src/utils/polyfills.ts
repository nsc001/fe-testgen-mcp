/**
 * Polyfills for Node.js 18 compatibility
 * 
 * Provides File API polyfill for Node.js 18, which is required by undici 7.x
 * The File API is natively available in Node.js 20+
 * 
 * IMPORTANT: This must be loaded BEFORE any modules that use undici (like fastmcp, openai, etc.)
 */

// Only polyfill if File is not already available (Node.js 18)
if (typeof globalThis.File === 'undefined') {
  // Node.js 18 has Blob but not File
  // Create a minimal File implementation compatible with undici's expectations
  
  class FilePolyfill extends Blob {
    public readonly name: string;
    public readonly lastModified: number;
    
    constructor(
      fileBits: any[],
      fileName: string,
      options?: { lastModified?: number; type?: string }
    ) {
      super(fileBits, options);
      this.name = fileName;
      this.lastModified = options?.lastModified ?? Date.now();
    }
    
    // For compatibility with some type checks
    get [Symbol.toStringTag]() {
      return 'File';
    }
  }
  
  // Assign to globalThis to make it available globally
  (globalThis as any).File = FilePolyfill;
  
  // Log that polyfill was applied (only in development)
  if (process.env.NODE_ENV === 'development') {
    console.log('[polyfills] File API polyfill applied for Node.js 18');
  }
}

// Export empty object to make this a valid module
export {};

