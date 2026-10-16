/**
 * Unit tests for language-aware LLM plumbing (Milestone M0.1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCodeFromMarkdown,
  fenceAliasesForLanguage,
  canonicalFenceForLanguage,
} from '../src/runner/llmClient';

describe('extractCodeFromMarkdown', () => {
  it('extracts code from a TypeScript fence by default', () => {
    const raw = 'here you go\n```typescript\nexport const x = 1;\n```\ndone';
    assert.equal(extractCodeFromMarkdown(raw), 'export const x = 1;\n');
  });

  it('extracts code from a Python fence when language is python', () => {
    const raw = '```python\ndef handle():\n    return 1\n```';
    assert.equal(extractCodeFromMarkdown(raw, 'python'), 'def handle():\n    return 1\n');
  });

  it('does not match a Python fence when the language is TypeScript', () => {
    const raw = '```python\nprint(1)\n```';
    // Falls back to raw trimmed content since no TS fence is present.
    assert.equal(extractCodeFromMarkdown(raw, 'typescript'), raw.trim() + '\n');
  });

  it('returns raw trimmed content when no fence is present', () => {
    assert.equal(extractCodeFromMarkdown('  plain code  '), 'plain code\n');
  });
});

describe('fenceAliasesForLanguage', () => {
  it('maps python to python fences only', () => {
    assert.deepEqual(fenceAliasesForLanguage('python'), ['python', 'py']);
  });

  it('maps typescript to ts/js fences', () => {
    assert.deepEqual(fenceAliasesForLanguage('typescript'), ['typescript', 'ts', 'javascript', 'js']);
  });
});

describe('canonicalFenceForLanguage', () => {
  it('returns the canonical fence label', () => {
    assert.equal(canonicalFenceForLanguage('python'), 'python');
    assert.equal(canonicalFenceForLanguage('javascript'), 'javascript');
    assert.equal(canonicalFenceForLanguage('typescript'), 'typescript');
  });
});
