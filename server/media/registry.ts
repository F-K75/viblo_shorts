import { ManifestError, parseSkillManifest, skillKey, type MediaPermission, type SkillManifest, type SkillRef } from './manifest.ts';
import type { MediaProviderDescriptor } from './provider.ts';

export type SkillState = 'planned' | 'registered' | 'validating' | 'available' | 'degraded' | 'deprecated' | 'rejected';

export interface SkillStatus {
  readonly manifest: SkillManifest;
  readonly state: SkillState;
  readonly verifiedProviders: readonly string[];
}

export interface ValidationEvidence {
  readonly testSuite: string;
  readonly contractTestsPassed: boolean;
  readonly outputValidationPassed: boolean;
  readonly healthyProviders: readonly string[];
}

interface Entry {
  manifest: SkillManifest;
  state: SkillState;
  verifiedProviders: readonly string[];
}

export interface ResolutionPolicy {
  readonly permissions: ReadonlySet<MediaPermission>;
  readonly maxCpu: number;
  readonly maxMemoryMb: number;
  readonly gpu: boolean;
  readonly networkAccess: boolean;
  readonly allowOptionalDependencies?: boolean;
}

export interface ExecutionPlanStep {
  readonly skill: SkillRef;
  readonly providerId: string;
  readonly dependencies: readonly SkillRef[];
}

export class SkillResolutionError extends Error {
  constructor(ref: SkillRef, reason: string) {
    super(`${skillKey(ref)}: ${reason}`);
    this.name = 'SkillResolutionError';
  }
}

export class SkillRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(manifests: readonly unknown[], providers: readonly MediaProviderDescriptor[]) {
    if (manifests.length > 512) throw new ManifestError('registry', 'maximum of 512 skill versions exceeded');
    const providersById = new Map(providers.map((provider) => [provider.id, provider]));
    if (providersById.size !== providers.length) throw new ManifestError('registry', 'duplicate provider');
    for (const raw of manifests) {
      const manifest = parseSkillManifest(raw);
      const skill = manifest.skill;
      const key = skillKey(skill);
      if (this.entries.has(key)) throw new ManifestError(key, 'duplicate skill version');
      for (const providerId of skill.providers.supported) {
        const provider = providersById.get(providerId);
        if (!provider || !skill.capabilities.every((cap) => provider.capabilities.includes(cap))) {
          throw new ManifestError(key, `provider "${providerId}" does not declare the required capabilities`);
        }
        if (provider.networkAccess !== skill.safety.network_access || (skill.resources.gpu_required && !provider.gpu)) {
          throw new ManifestError(key, `provider "${providerId}" is incompatible with the skill restrictions`);
        }
      }
      this.entries.set(key, { manifest, state: skill.lifecycle, verifiedProviders: Object.freeze([]) });
    }
    this.validateDependencies();
  }

  private validateDependencies(): void {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (key: string) => {
      if (visited.has(key)) return;
      if (visiting.has(key)) throw new ManifestError(key, 'circular skill dependency');
      const entry = this.entries.get(key);
      if (!entry) throw new ManifestError(key, 'dependency is missing from the catalog');
      visiting.add(key);
      for (const ref of entry.manifest.skill.dependencies) visit(skillKey(ref));
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of this.entries.keys()) visit(key);
  }

  list(): readonly SkillStatus[] {
    return Object.freeze([...this.entries.values()].map((entry) => Object.freeze({ ...entry })));
  }

  private require(ref: SkillRef): Entry {
    const entry = this.entries.get(skillKey(ref));
    if (!entry) throw new SkillResolutionError(ref, 'skill version is unknown');
    return entry;
  }

  beginValidation(ref: SkillRef): void {
    const entry = this.require(ref);
    if (!['registered', 'degraded', 'rejected'].includes(entry.state)) {
      throw new SkillResolutionError(ref, `cannot validate from ${entry.state}`);
    }
    entry.state = 'validating';
  }

  /** Only the trusted validation runner may supply test and provider evidence. */
  completeValidation(ref: SkillRef, evidence: ValidationEvidence): SkillState {
    const entry = this.require(ref);
    if (entry.state !== 'validating') throw new SkillResolutionError(ref, 'validation has not started');
    const { skill } = entry.manifest;
    const orderedIds = new Set([...skill.providers.preferred, ...skill.providers.supported]);
    const healthyIds = [...orderedIds].filter((id) => evidence.healthyProviders.includes(id));
    if (evidence.testSuite !== skill.quality.test_suite || !evidence.contractTestsPassed || !evidence.outputValidationPassed) {
      entry.state = 'rejected';
      entry.verifiedProviders = Object.freeze([]);
    } else {
      entry.state = healthyIds.length ? 'available' : 'degraded';
      entry.verifiedProviders = Object.freeze(healthyIds);
    }
    return entry.state;
  }

  deactivate(ref: SkillRef, state: 'degraded' | 'deprecated'): void {
    const entry = this.require(ref);
    if (entry.state === 'deprecated' || (state === 'degraded' && entry.state !== 'available')) {
      throw new SkillResolutionError(ref, `cannot set ${state} from ${entry.state}`);
    }
    entry.state = state;
    entry.verifiedProviders = Object.freeze([]);
  }

  /** Resolve exact skill versions in dependency order. Execution still requires gateway authorization. */
  resolve(ref: SkillRef, policy: ResolutionPolicy): readonly ExecutionPlanStep[] {
    if (!Number.isSafeInteger(policy.maxCpu) || policy.maxCpu < 1 ||
        !Number.isSafeInteger(policy.maxMemoryMb) || policy.maxMemoryMb < 1) {
      throw new SkillResolutionError(ref, 'invalid resource budget');
    }
    const steps = new Map<string, ExecutionPlanStep>();
    const visit = (target: SkillRef) => {
      const key = skillKey(target);
      if (steps.has(key)) return;
      const { manifest: { skill }, state, verifiedProviders } = this.require(target);
      if (state !== 'available') throw new SkillResolutionError(target, `skill is ${state}`);
      if (skill.permissions.some((permission) => !policy.permissions.has(permission))) {
        throw new SkillResolutionError(target, 'required permission is missing');
      }
      if (skill.resources.cpu > policy.maxCpu || skill.resources.memory_mb > policy.maxMemoryMb ||
          (skill.resources.gpu_required && !policy.gpu) || (skill.safety.network_access && !policy.networkAccess)) {
        throw new SkillResolutionError(target, 'skill exceeds execution policy');
      }
      const dependencies = skill.dependencies
        .filter(({ optional }) => !optional || policy.allowOptionalDependencies)
        .map(({ id, version }) => Object.freeze({ id, version }));
      for (const dependency of dependencies) visit(dependency);
      steps.set(key, Object.freeze({
        skill: Object.freeze({ id: skill.id, version: skill.version }),
        providerId: verifiedProviders[0],
        dependencies: Object.freeze(dependencies),
      }));
    };
    visit(ref);
    return Object.freeze([...steps.values()]);
  }
}
