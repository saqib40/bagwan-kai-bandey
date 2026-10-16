/**
 * Layer 2 — Language Adapter Registry (`src/adapters/registry.ts`).
 *
 * Allows engine and external users to obtain, register, and dynamically inject
 * language adapters at runtime.
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LanguageAdapter } from './types';
import { TypeScriptAdapter } from './typescriptAdapter';
import { PythonAdapter } from './pythonAdapter';

export class AdapterRegistry {
  private adapters = new Map<string, LanguageAdapter>();

  constructor() {
    this.register(new TypeScriptAdapter());
    this.register(new PythonAdapter());
  }

  /**
   * Registers a LanguageAdapter instance.
   */
  register(adapter: LanguageAdapter): void {
    if (!adapter.language) {
      throw new Error('Adapter must have a non-empty `language` identifier.');
    }
    this.adapters.set(adapter.language.toLowerCase(), adapter);
  }

  /**
   * Checks if an adapter is registered for a given language.
   */
  has(language: string): boolean {
    return this.adapters.has(language.toLowerCase());
  }

  /**
   * Returns a list of all registered language identifiers.
   */
  list(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Obtains the registered adapter for a language.
   */
  get(language: string): LanguageAdapter {
    const adapter = this.adapters.get(language.toLowerCase());
    if (!adapter) {
      throw new Error(
        `No language adapter registered for "${language}". Available: ${[...this.adapters.keys()].join(', ')}. ` +
        `Register one using adapterRegistry.register() or provide --adapter <path>.`,
      );
    }
    return adapter;
  }

  /**
   * Dynamically imports an adapter from a module path (relative or absolute file path or package name)
   * and registers it.
   */
  async registerFromPath(modulePathOrFile: string): Promise<LanguageAdapter> {
    const absPath = existsSync(modulePathOrFile)
      ? resolve(modulePathOrFile)
      : modulePathOrFile;

    const importUrl = existsSync(absPath)
      ? pathToFileURL(absPath).href
      : modulePathOrFile;

    try {
      const mod = await import(importUrl);
      // Look for default export, named export matching Adapter, or first class instance/constructor
      let AdapterClass = mod.default ?? mod.Adapter;
      if (!AdapterClass) {
        for (const val of Object.values(mod)) {
          if (typeof val === 'function' && val.prototype && 'language' in val.prototype) {
            AdapterClass = val;
            break;
          }
        }
      }

      let adapterInstance: LanguageAdapter;
      if (typeof AdapterClass === 'function') {
        adapterInstance = new (AdapterClass as any)();
      } else if (typeof mod.default === 'object' && mod.default && 'language' in mod.default) {
        adapterInstance = mod.default as LanguageAdapter;
      } else {
        throw new Error(`Module "${modulePathOrFile}" does not export a valid LanguageAdapter class or instance.`);
      }

      this.register(adapterInstance);
      return adapterInstance;
    } catch (err: unknown) {
      throw new Error(`Failed to load adapter from "${modulePathOrFile}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Automatically discovers and registers all adapters in a given directory (defaults to `./adapters`).
   */
  async discoverAdapters(dirPath = resolve(process.cwd(), 'adapters')): Promise<number> {
    if (!existsSync(dirPath)) return 0;

    let count = 0;
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      if ((entry.endsWith('Adapter.ts') || entry.endsWith('Adapter.js')) && !entry.endsWith('.d.ts')) {
        const full = resolve(dirPath, entry);
        try {
          await this.registerFromPath(full);
          count++;
        } catch (err) {
          console.error(`[bkb] Warning: Failed to auto-register adapter from ${entry}:`, err);
        }
      }
    }
    return count;
  }
}

export const adapterRegistry = new AdapterRegistry();
