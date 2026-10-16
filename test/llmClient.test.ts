/**
 * Unit tests for language-aware LLM plumbing (Milestone M0.1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCodeFromMarkdown,
  fenceAliasesForLanguage,
  canonicalFenceForLanguage,
  loadFixtureMockTransforms,
  LlmClient,
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

describe('fixture mock transforms', () => {
  it('loads mock transforms from .bkb-mocks.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bkb-mocks-'));
    try {
      writeFileSync(
        join(dir, '.bkb-mocks.json'),
        JSON.stringify({
          'src/foo.ts:MIGRATE': { code: 'export const foo = 1;\n', summary: 'fixture' },
        }),
      );

      const loaded = loadFixtureMockTransforms(dir);
      assert.equal(loaded['src/foo.ts:MIGRATE'].code, 'export const foo = 1;\n');

      const client = new LlmClient({ provider: 'mock', repoPath: dir });
      const resp = await client.generateTransform({
        targetPath: 'src/foo.ts',
        phase: 'MIGRATE',
        fullSource: 'module.exports = 1;\n',
        guidance: '',
        calleeSignatures: [],
        callerSnippets: [],
      });
      assert.equal(resp.code, 'export const foo = 1;\n');
      assert.equal(resp.summary, 'fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty object when no fixture file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bkb-mocks-'));
    try {
      assert.deepEqual(loadFixtureMockTransforms(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('opencode provider configuration', () => {
  it('defaults to deepseek-v4.1-flash-free when provider is opencode', () => {
    const client = new LlmClient({ provider: 'opencode' });
    assert.equal(client.provider, 'opencode');
    assert.equal(client.model, 'deepseek-v4.1-flash-free');
  });

  it('respects custom model when provider is opencode', () => {
    const client = new LlmClient({ provider: 'opencode', model: 'deepseek-v4-pro' });
    assert.equal(client.provider, 'opencode');
    assert.equal(client.model, 'deepseek-v4-pro');
  });
});
