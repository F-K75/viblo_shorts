import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ManifestError, parseContract, parseSkillManifest, type SkillManifest } from './manifest.ts';
import type { MediaProviderDescriptor } from './provider.ts';
import { SkillRegistry } from './registry.ts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_MANIFESTS = 512;
const PACKAGE_DIR = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

// Catalog descriptions declare intended compatibility. Adapter availability is runtime evidence.
const CATALOG_PROVIDERS: readonly MediaProviderDescriptor[] = [{
  id: 'ffmpeg', capabilities: ['media.video.trim'], networkAccess: false, gpu: false,
}];

function checkedFile(file: string): void {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0 || stat.size > MAX_DOCUMENT_BYTES) {
    throw new ManifestError(file, 'expected a non-empty repository file within the size limit');
  }
}

function readJson(file: string): unknown {
  checkedFile(file);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ManifestError(file, 'invalid JSON document');
  }
}

function readPackage(dir: string, domain: string, id: string, testsDir: string): SkillManifest {
  // JSON is a YAML 1.2 subset. Only the JSON syntax is accepted by the v1 loader.
  const manifest = parseSkillManifest(readJson(join(dir, 'manifest.yaml')));
  const skill = manifest.skill;
  if (skill.id !== id || skill.domain.replaceAll('-', '_') !== domain.replaceAll('-', '_')) {
    throw new ManifestError(dir, 'manifest skill and domain must match their directories');
  }
  checkedFile(join(dir, skill.documentation.skill_file));
  checkedFile(join(testsDir, skill.quality.test_suite));
  for (const example of skill.documentation.examples) {
    const exampleDir = join(dir, 'examples');
    if (!lstatSync(exampleDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ManifestError(exampleDir, 'expected an examples directory in the skill package');
    }
    parseContract(skill.inputs, readJson(join(dir, example)), 'inputs');
  }
  return manifest;
}

export function loadCatalog(repositoryRoot = REPOSITORY_ROOT): SkillRegistry {
  const root = join(repositoryRoot, 'media_skills');
  const testsDir = join(repositoryRoot, 'tests');
  const manifests: SkillManifest[] = [];
  for (const domain of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!domain.isDirectory() || !PACKAGE_DIR.test(domain.name)) continue;
    const domainDir = join(root, domain.name);
    for (const entry of readdirSync(domainDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !PACKAGE_DIR.test(entry.name)) continue;
      if (manifests.length >= MAX_MANIFESTS) throw new ManifestError(root, 'maximum catalog size exceeded');
      manifests.push(readPackage(join(domainDir, entry.name), domain.name, entry.name, testsDir));
    }
  }
  if (!manifests.length) throw new ManifestError(root, 'catalog contains no skill packages');
  return new SkillRegistry(manifests, CATALOG_PROVIDERS);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const entries = loadCatalog().list();
    console.log(JSON.stringify(entries.map(({ manifest: { skill }, state }) => ({ id: skill.id, version: skill.version, state }))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
