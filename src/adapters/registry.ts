/**
 * Layer 2 — Language Adapter Registry.
 * Allows engine to obtain an adapter dynamically by language identifier.
 */

import type { LanguageAdapter } from './types';
import { TypeScriptAdapter } from './typescriptAdapter';

class AdapterRegistry {
  private adapters = new Map<string, LanguageAdapter>();

  constructor() {
    this.register(new TypeScriptAdapter());
  }

  register(adapter: LanguageAdapter): void {
    this.adapters.set(adapter.language.toLowerCase(), adapter);
  }

  get(language: string): LanguageAdapter {
    const adapter = this.adapters.get(language.toLowerCase());
    if (!adapter) {
      throw new Error(`No language adapter registered for "${language}". Available: ${[...this.adapters.keys()].join(', ')}`);
    }
    return adapter;
  }
}

export const adapterRegistry = new AdapterRegistry();
