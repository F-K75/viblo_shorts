export interface SkillRef {
  readonly id: string;
  readonly version: string;
}

export const MEDIA_QUEUES = [
  'media_probe', 'media_analysis', 'media_cpu', 'media_gpu', 'media_ai_local',
  'media_ai_cloud', 'media_browser', 'media_qa', 'media_publish', 'media_cleanup',
] as const;
export const MEDIA_PERMISSIONS = [
  'media.asset.read', 'media.artifact.create', 'media.provider.spend', 'media.publish.external',
] as const;

export type MediaQueue = typeof MEDIA_QUEUES[number];
export type MediaPermission = typeof MEDIA_PERMISSIONS[number];
export type FieldType = 'string' | 'number' | 'integer' | 'boolean';
export type ContractValue = string | number | boolean;
export type ContractRecord = Readonly<Record<string, ContractValue>>;

export interface SkillField {
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
}

export interface SkillManifest {
  readonly manifest_version: '1.0';
  readonly skill: SkillRef & {
    readonly name: string;
    readonly domain: string;
    readonly description: string;
    readonly lifecycle: 'planned' | 'registered';
    readonly maturity: 'experimental' | 'beta' | 'stable';
    readonly tags: readonly string[];
    readonly capabilities: readonly string[];
    readonly inputs: readonly SkillField[];
    readonly outputs: readonly SkillField[];
    readonly dependencies: readonly (SkillRef & { readonly optional: boolean })[];
    readonly providers: { readonly preferred: readonly string[]; readonly supported: readonly string[] };
    readonly execution: {
      readonly mode: 'deterministic' | 'analytical' | 'generative' | 'creative' | 'distribution' | 'governance';
      readonly queue: MediaQueue;
      readonly timeout_seconds: number;
      readonly retry_policy: 'none' | 'transient_only';
      readonly idempotent: boolean;
    };
    readonly resources: { readonly cpu: number; readonly memory_mb: number; readonly gpu_required: boolean };
    readonly permissions: readonly MediaPermission[];
    readonly safety: { readonly network_access: boolean; readonly filesystem_scope: 'authorized_assets'; readonly shell_access: false };
    readonly quality: { readonly test_suite: string; readonly validation_required: true };
    readonly observability: { readonly metrics: readonly string[] };
    readonly documentation: { readonly skill_file: 'SKILL.md'; readonly examples: readonly string[] };
  };
}

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAPABILITY = /^media(?:\.[a-z][a-z0-9_]*){2,5}$/;
const FIELD = /^[a-z][a-z0-9_]*$/;
const NUMERIC = '(?:0|[1-9][0-9]*)';
const PRE = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRE}(?:\\.${PRE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export class ManifestError extends Error {
  constructor(path: string, issue: string) {
    super(`${path}: ${issue}`);
    this.name = 'ManifestError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ManifestError(path, 'expected a JSON object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ManifestError(path, 'expected a plain object');
  return value as Record<string, unknown>;
}

function object(value: unknown, path: string, keys: string): Record<string, unknown> {
  const obj = record(value, path);
  const expected = keys.split(' ');
  for (const key of Object.keys(obj)) if (!expected.includes(key)) throw new ManifestError(path, `unknown field "${key}"`);
  for (const key of expected) if (!Object.hasOwn(obj, key)) throw new ManifestError(path, `missing field "${key}"`);
  return obj;
}

function string(value: unknown, path: string, pattern?: RegExp, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (pattern && (value !== value.trim() || !pattern.test(value)))) {
    throw new ManifestError(path, 'invalid string');
  }
  return value;
}

function choice<const T extends readonly (string | boolean)[]>(value: unknown, path: string, choices: T): T[number] {
  if (!choices.some((candidate) => candidate === value)) throw new ManifestError(path, `expected one of: ${choices.join(', ')}`);
  return value as T[number];
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ManifestError(path, `expected integer in [${min}, ${max}]`);
  }
  return value;
}

function list<T>(value: unknown, path: string, parse: (v: unknown, p: string) => T, min = 0): readonly T[] {
  if (!Array.isArray(value) || value.length < min || value.length > 64) throw new ManifestError(path, `expected ${min}–64 entries`);
  return Array.from(value, (entry, index) => parse(entry, `${path}[${index}]`));
}

function unique<T>(items: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  if (new Set(items.map(key)).size !== items.length) throw new ManifestError(path, 'duplicate entry');
  return items;
}

const boolean = (value: unknown, path: string) => choice(value, path, [true, false]);
const strings = (value: unknown, path: string, pattern: RegExp, min = 0) =>
  unique(list(value, path, (item, p) => string(item, p, pattern), min), (item) => item, path);
const readRef = (ref: Record<string, unknown>, path: string): SkillRef => ({
  id: string(ref.id, `${path}.id`, IDENTIFIER, 80),
  version: string(ref.version, `${path}.version`, VERSION, 64),
});
export const skillKey = ({ id, version }: SkillRef): string => `${id}@${version}`;

function fields(value: unknown, path: string): readonly SkillField[] {
  return unique(list(value, path, (entry, p) => {
    const field = object(entry, p, 'name type required');
    const name = string(field.name, `${p}.name`, FIELD, 64);
    if (Object.hasOwn(Object.prototype, name)) throw new ManifestError(p, 'reserved field name');
    return { name, type: choice(field.type, `${p}.type`, ['string', 'number', 'integer', 'boolean']), required: boolean(field.required, `${p}.required`) };
  }), (field) => field.name, path);
}

function freeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

export function parseSkillManifest(raw: unknown): SkillManifest {
  const root = object(raw, 'manifest', 'manifest_version skill');
  const manifestVersion = choice(root.manifest_version, 'manifest_version', ['1.0']);
  const skill = object(root.skill, 'skill', 'id name version domain description lifecycle maturity tags capabilities inputs outputs dependencies providers execution resources permissions safety quality observability documentation');
  const ref = readRef(skill, 'skill');
  const providers = object(skill.providers, 'providers', 'preferred supported');
  const supported = strings(providers.supported, 'providers.supported', IDENTIFIER, 1);
  const preferred = strings(providers.preferred, 'providers.preferred', IDENTIFIER, 1);
  if (preferred.some((id) => !supported.includes(id))) throw new ManifestError('providers.preferred', 'provider must also be supported');

  const execution = object(skill.execution, 'execution', 'mode queue timeout_seconds retry_policy idempotent');
  const resources = object(skill.resources, 'resources', 'cpu memory_mb gpu_required');
  const safety = object(skill.safety, 'safety', 'network_access filesystem_scope shell_access');
  const quality = object(skill.quality, 'quality', 'test_suite validation_required');
  const observability = object(skill.observability, 'observability', 'metrics');
  const documentation = object(skill.documentation, 'documentation', 'skill_file examples');
  const idempotent = boolean(execution.idempotent, 'execution.idempotent');
  const retryPolicy = choice(execution.retry_policy, 'execution.retry_policy', ['none', 'transient_only']);
  if (!idempotent && retryPolicy !== 'none') throw new ManifestError('execution.retry_policy', 'retry requires an idempotent skill');

  return freeze<SkillManifest>({
    manifest_version: manifestVersion,
    skill: {
      ...ref,
      name: string(skill.name, 'skill.name'),
      domain: string(skill.domain, 'skill.domain', IDENTIFIER),
      description: string(skill.description, 'skill.description', undefined, 400),
      lifecycle: choice(skill.lifecycle, 'skill.lifecycle', ['planned', 'registered']),
      maturity: choice(skill.maturity, 'skill.maturity', ['experimental', 'beta', 'stable']),
      tags: strings(skill.tags, 'skill.tags', IDENTIFIER),
      capabilities: strings(skill.capabilities, 'skill.capabilities', CAPABILITY, 1),
      inputs: fields(skill.inputs, 'skill.inputs'),
      outputs: fields(skill.outputs, 'skill.outputs'),
      dependencies: unique(list(skill.dependencies, 'skill.dependencies', (value, path) => {
        const dependency = object(value, path, 'id version optional');
        return { ...readRef(dependency, path), optional: boolean(dependency.optional, `${path}.optional`) };
      }), skillKey, 'skill.dependencies'),
      providers: { preferred, supported },
      execution: {
        mode: choice(execution.mode, 'execution.mode', ['deterministic', 'analytical', 'generative', 'creative', 'distribution', 'governance']),
        queue: choice(execution.queue, 'execution.queue', MEDIA_QUEUES),
        timeout_seconds: integer(execution.timeout_seconds, 'execution.timeout_seconds', 1, 1800),
        retry_policy: retryPolicy,
        idempotent,
      },
      resources: {
        cpu: integer(resources.cpu, 'resources.cpu', 1, 32),
        memory_mb: integer(resources.memory_mb, 'resources.memory_mb', 32, 65536),
        gpu_required: boolean(resources.gpu_required, 'resources.gpu_required'),
      },
      permissions: unique(list(skill.permissions, 'skill.permissions', (value, path) => choice(value, path, MEDIA_PERMISSIONS)), (value) => value, 'skill.permissions'),
      safety: {
        network_access: boolean(safety.network_access, 'safety.network_access'),
        filesystem_scope: choice(safety.filesystem_scope, 'safety.filesystem_scope', ['authorized_assets']),
        shell_access: choice(safety.shell_access, 'safety.shell_access', [false]),
      },
      quality: {
        test_suite: string(quality.test_suite, 'quality.test_suite', /^[a-z][a-z0-9_]*\.test\.ts$/),
        validation_required: choice(quality.validation_required, 'quality.validation_required', [true]),
      },
      observability: { metrics: strings(observability.metrics, 'observability.metrics', FIELD, 1) },
      documentation: {
        skill_file: choice(documentation.skill_file, 'documentation.skill_file', ['SKILL.md']),
        examples: strings(documentation.examples, 'documentation.examples', /^examples\/[a-z0-9_-]+\.json$/),
      },
    },
  });
}

export function parseContract(fields: readonly SkillField[], raw: unknown, path: 'inputs' | 'outputs'): ContractRecord {
  const values = record(raw, path);
  const parsed = new Map<string, ContractValue>();
  for (const key of Object.keys(values)) {
    if (!fields.some((field) => field.name === key)) throw new ManifestError(path, `unknown field "${key}"`);
  }
  for (const field of fields) {
    const key = `${path}.${field.name}`;
    if (!Object.hasOwn(values, field.name)) {
      if (field.required) throw new ManifestError(key, 'required field missing');
      continue;
    }
    const value = values[field.name];
    const valid = field.type === 'integer' ? Number.isSafeInteger(value) :
      field.type === 'number' ? Number.isFinite(value) :
      field.type === 'string' ? typeof value === 'string' && value.length <= 4096 :
      typeof value === 'boolean';
    if (!valid) throw new ManifestError(key, `expected ${field.type}`);
    parsed.set(field.name, value as ContractValue);
  }
  return Object.freeze(Object.fromEntries(parsed));
}
