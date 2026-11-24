import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseContract, parseSkillManifest, type SkillRef } from '../server/media/manifest.ts';
import { SkillRegistry, type ResolutionPolicy } from '../server/media/registry.ts';
import { loadCatalog } from '../server/media/validateManifests.ts';

const pilot = JSON.parse(readFileSync(new URL(
  '../media_skills/video_editing/video-trimming/manifest.yaml', import.meta.url,
), 'utf8'));
const trim = { id: 'video-trimming', version: '1.0.0' };
const metadata = { id: 'media-metadata-extraction', version: '1.0.0' };
const providers = [
  { id: 'ffmpeg', capabilities: ['media.video.trim'], networkAccess: false, gpu: false },
  { id: 'fallback', capabilities: ['media.video.trim'], networkAccess: false, gpu: false },
];
const evidence = {
  testSuite: 'media_registry.test.ts', contractTestsPassed: true,
  outputValidationPassed: true, healthyProviders: ['ffmpeg', 'fallback'],
};
const policy: ResolutionPolicy = {
  permissions: new Set(['media.asset.read', 'media.artifact.create']),
  maxCpu: 2, maxMemoryMb: 1024, gpu: false, networkAccess: false,
};
const manifest = (ref: SkillRef, overrides = {}) => ({
  ...pilot,
  skill: { ...pilot.skill, ...ref, lifecycle: 'registered', ...overrides },
});

test('discovers the pilot on disk and keeps it planned', () => {
  const registry = loadCatalog();
  const [entry] = registry.list();
  assert.equal(entry.manifest.skill.id, trim.id);
  assert.equal(entry.state, 'planned');
  assert.equal(Object.isFrozen(entry.manifest.skill.inputs[0]), true);
  assert.throws(() => registry.beginValidation(trim), /cannot validate from planned/);
  assert.throws(() => registry.resolve(trim, policy), /skill is planned/);
});

test('manifest validation rejects unsafe fields, invalid versions, and incompatible providers', () => {
  for (const invalid of ['v1.0.0', '01.0.0', '1.0.0-01', '1.0', '1.0.0\n']) {
    assert.throws(() => parseSkillManifest(manifest({ ...trim, version: invalid })), /skill.version/);
  }
  assert.equal(parseSkillManifest(manifest({ ...trim, version: '1.0.0-rc.1+build' })).skill.version, '1.0.0-rc.1+build');
  assert.throws(() => parseSkillManifest(manifest(trim, { lifecycle: 'available' })), /skill.lifecycle/);
  assert.throws(() => parseSkillManifest(manifest(trim, { shell: 'ffmpeg' })), /unknown field/);
  assert.throws(() => parseSkillManifest(manifest(trim, { safety: { ...pilot.skill.safety, shell_access: true } })), /shell_access/);
  assert.throws(() => new SkillRegistry([manifest(trim)], []), /required capabilities/);
  assert.throws(() => new SkillRegistry([manifest(trim)], [{ ...providers[0], networkAccess: true }]), /incompatible/);
});

test('input and output contracts enforce field types, presence, and closed keys', () => {
  const { skill } = parseSkillManifest(pilot);
  const input = { asset_id: 'asset_sample', start_seconds: 0, end_seconds: 2.5 };
  assert.deepEqual(parseContract(skill.inputs, input, 'inputs'), input);
  assert.throws(() => parseContract(skill.inputs, { ...input, path: '/tmp/sample.mp4' }, 'inputs'), /unknown field/);
  assert.throws(() => parseContract(skill.inputs, { ...input, start_seconds: '0' }, 'inputs'), /expected number/);
  assert.throws(() => parseContract(skill.inputs, { ...input, end_seconds: Infinity }, 'inputs'), /expected number/);
  assert.throws(() => parseContract(skill.outputs, { artifact_id: 'artifact_sample' }, 'outputs'), /required field missing/);
});

test('catalog rejects duplicate versions, missing dependencies and dependency cycles', () => {
  const dependency = (ref: SkillRef) => ({ ...ref, optional: false });
  assert.throws(() => new SkillRegistry([manifest(trim), manifest(trim)], providers), /duplicate skill version/);
  assert.throws(() => new SkillRegistry([manifest(trim, { dependencies: [dependency(metadata)] })], providers), /dependency is missing/);
  assert.throws(() => new SkillRegistry([
    manifest(trim, { dependencies: [dependency(metadata)] }),
    manifest(metadata, { dependencies: [dependency(trim)] }),
  ], providers), /circular skill dependency/);
  const upgraded = { ...trim, version: '1.1.0' };
  assert.equal(new SkillRegistry([manifest(trim), manifest(upgraded)], providers).list().length, 2);
});

test('resolution enforces availability, dependency order, permissions and resource limits', () => {
  const registry = new SkillRegistry([
    manifest(trim, {
      dependencies: [{ ...metadata, optional: false }],
      providers: { preferred: ['ffmpeg'], supported: ['ffmpeg', 'fallback'] },
    }),
    manifest(metadata),
  ], providers);
  registry.beginValidation(trim);
  assert.equal(registry.completeValidation(trim, { ...evidence, healthyProviders: ['fallback'] }), 'available');
  assert.throws(() => registry.resolve(trim, policy), /metadata-extraction@1.0.0: skill is registered/);
  registry.beginValidation(metadata);
  assert.equal(registry.completeValidation(metadata, { ...evidence, outputValidationPassed: false }), 'rejected');
  registry.beginValidation(metadata);
  assert.equal(registry.completeValidation(metadata, { ...evidence, healthyProviders: ['fallback'] }), 'degraded');
  registry.beginValidation(metadata);
  assert.equal(registry.completeValidation(metadata, evidence), 'available');

  assert.deepEqual(registry.resolve(trim, policy), [
    { skill: metadata, providerId: 'ffmpeg', dependencies: [] },
    { skill: trim, providerId: 'fallback', dependencies: [metadata] },
  ]);
  assert.throws(() => registry.resolve(trim, { ...policy, permissions: new Set() }), /permission/);
  assert.throws(() => registry.resolve(trim, { ...policy, maxMemoryMb: 512 }), /exceeds execution policy/);
  assert.throws(() => registry.resolve(trim, { ...policy, maxMemoryMb: NaN }), /invalid resource budget/);
  registry.deactivate(metadata, 'degraded');
  assert.throws(() => registry.resolve(trim, policy), /skill is degraded/);
});

test('optional dependencies require explicit policy opt-in', () => {
  const registry = new SkillRegistry([
    manifest(trim, { dependencies: [{ ...metadata, optional: true }] }),
    manifest(metadata),
  ], providers);
  registry.beginValidation(trim);
  registry.completeValidation(trim, evidence);
  assert.deepEqual(registry.resolve(trim, policy).map((step) => step.skill), [trim]);
  assert.throws(() => registry.resolve(trim, { ...policy, allowOptionalDependencies: true }), /skill is registered/);
});
