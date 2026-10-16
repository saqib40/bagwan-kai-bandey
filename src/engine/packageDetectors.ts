/**
 * Layer 1 — Package Detectors (`src/engine/packageDetectors.ts`).
 *
 * Evaluates declarative manifest preconditions (`pack.packageDetectors`) against
 * a target repository. Pure and side-effect free: never mutates the graph and
 * never writes to disk. Results are surfaced as diagnostics / gating advisories.
 *
 * Supported manifests (dispatched by basename):
 *  - `package.json`     → dependencies / devDependencies / peerDependencies / optionalDependencies
 *  - `pyproject.toml`   → PEP 621 `[project]` deps + Poetry dependency tables
 *  - `go.mod`           → `require` directives
 *  - anything else      → requirements.txt-style line list (e.g. `requirements.txt`)
 */

import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { PackageDetector } from '../adapters/types';

export interface PackageDetectorResult {
  /** Detector id from the pack. */
  id: string;
  /** Manifest path relative to the repo root. */
  file: string;
  /** Optional human description from the pack. */
  description?: string;
  /** Whether an unmet detector is a blocking precondition. */
  required: boolean;
  /** Whether the manifest file exists in the repository. */
  fileFound: boolean;
  /** Expected package names that were found. */
  present: string[];
  /** Expected package names that were not found. */
  missing: string[];
  /** True only when the manifest exists and every expected name is present. */
  satisfied: boolean;
}

interface Manifest {
  found: boolean;
  names: Set<string>;
  normalize: (name: string) => string;
}

const IDENTITY = (name: string): string => name.trim();

function normalizeJsName(name: string): string {
  return name.trim().toLowerCase();
}

/** PEP 503 normalization: lowercase and collapse runs of `-_.` to a single `-`. */
function normalizePyName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/** Removes extras (`pkg[extra]`) and version/url/marker specifiers from a requirement. */
function stripRequirementSpec(spec: string): string {
  return spec
    .trim()
    .replace(/\[[^\]]*\]/g, '')
    .split(/[<>=!~;@\s]/)[0]
    ?.trim() ?? '';
}

function isLikelyPackageToken(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function collectQuoted(text: string, out: Set<string>): void {
  const re = /["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = stripRequirementSpec(match[1]);
    if (name && isLikelyPackageToken(name)) out.add(normalizePyName(name));
  }
}

function parsePackageJson(content: string): Set<string> {
  const names = new Set<string>();
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return names;
  }
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const section of sections) {
    const block = pkg[section];
    if (block && typeof block === 'object') {
      for (const key of Object.keys(block as Record<string, unknown>)) {
        names.add(normalizeJsName(key));
      }
    }
  }
  return names;
}

function parsePyproject(content: string): Set<string> {
  const names = new Set<string>();
  const lines = content.split(/\r?\n/);
  let section = '';
  let collectingArray = false;

  for (const raw of lines) {
    const line = (raw.split('#')[0] ?? raw).trim();
    if (!line) continue;

    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1].trim();
      collectingArray = false;
      continue;
    }

    if (section === 'project') {
      if (collectingArray) {
        collectQuoted(line, names);
        if (line.includes(']')) collectingArray = false;
        continue;
      }
      const match = line.match(/^dependencies\s*=\s*(\[.*)$/);
      if (match) {
        collectQuoted(match[1], names);
        collectingArray = !match[1].includes(']');
      }
      continue;
    }

    const isOptionalDeps = section === 'project.optional-dependencies';
    const isPoetryDeps =
      /^tool\.poetry(\.dev)?\.dependencies$/.test(section) ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section);

    if (isOptionalDeps || isPoetryDeps) {
      collectQuoted(line, names);
      if (isPoetryDeps) {
        const key = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
        if (key && key[1].toLowerCase() !== 'python') names.add(normalizePyName(key[1]));
      }
    }
  }

  return names;
}

function parseGoMod(content: string): Set<string> {
  const names = new Set<string>();
  let inRequire = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ')') {
      inRequire = false;
      continue;
    }
    if (inRequire) {
      const token = line.split(/\s+/)[0];
      if (token) names.add(token);
      continue;
    }
    const single = line.match(/^require\s+(\S+)/);
    if (single) names.add(single[1]);
  }
  return names;
}

function parseRequirementLines(content: string): Set<string> {
  const names = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = (raw.split('#')[0] ?? raw).trim();
    if (!line || line.startsWith('-')) continue;
    const name = stripRequirementSpec(line);
    if (name && isLikelyPackageToken(name)) names.add(normalizePyName(name));
  }
  return names;
}

function readManifest(repoRoot: string, file: string): Manifest {
  let content: string;
  try {
    content = readFileSync(resolve(repoRoot, file), 'utf8');
  } catch {
    return { found: false, names: new Set(), normalize: IDENTITY };
  }

  const base = basename(file).toLowerCase();
  if (base === 'package.json') {
    return { found: true, names: parsePackageJson(content), normalize: normalizeJsName };
  }
  if (base === 'pyproject.toml') {
    return { found: true, names: parsePyproject(content), normalize: normalizePyName };
  }
  if (base === 'go.mod') {
    return { found: true, names: parseGoMod(content), normalize: IDENTITY };
  }
  return { found: true, names: parseRequirementLines(content), normalize: normalizePyName };
}

/**
 * Evaluates package detectors against a repository. Multiple detectors pointing
 * at the same manifest share a single read.
 */
export function evaluatePackageDetectors(
  repoRoot: string,
  detectors?: PackageDetector[],
): PackageDetectorResult[] {
  if (!detectors || detectors.length === 0) return [];

  const manifestCache = new Map<string, Manifest>();
  const getManifest = (file: string): Manifest => {
    let manifest = manifestCache.get(file);
    if (!manifest) {
      manifest = readManifest(repoRoot, file);
      manifestCache.set(file, manifest);
    }
    return manifest;
  };

  return detectors.map((detector) => {
    const manifest = getManifest(detector.file);
    const expected = [...(detector.match.legacy ?? []), ...(detector.match.target ?? [])];
    const present: string[] = [];
    const missing: string[] = [];
    for (const name of expected) {
      if (manifest.names.has(manifest.normalize(name))) present.push(name);
      else missing.push(name);
    }
    return {
      id: detector.id,
      file: detector.file,
      description: detector.description,
      required: detector.required ?? false,
      fileFound: manifest.found,
      present,
      missing,
      satisfied: manifest.found && missing.length === 0,
    };
  });
}

/** Renders unmet detectors as one-line advisories suitable for stderr logging. */
export function formatPackageDetectorAdvisories(results: PackageDetectorResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.satisfied) continue;
    const label = result.required ? 'FAIL' : 'warn';
    const reason = result.fileFound ? `missing: ${result.missing.join(', ')}` : `manifest "${result.file}" not found`;
    lines.push(`[${label}] package detector "${result.id}" (${result.file}): ${reason}`);
  }
  return lines;
}
