import type { SkillRef } from './manifest.ts';

export type MediaProviderCategory = 'ffmpeg' | 'python' | 'local-ai' | 'browser' | 'cloud-ai' | 'gpu';

export type MediaValue = null | boolean | number | string | readonly MediaValue[] | MediaData;

export interface MediaData {
  readonly [key: string]: MediaValue;
}

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

/** Static capability discovery for the registry. Readiness is checked separately. */
export interface MediaProviderDescriptor {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly networkAccess: boolean;
  readonly gpu: boolean;
}

export interface MediaProviderCapability {
  readonly skill: Readonly<SkillRef>;
  readonly inputFormats: readonly string[];
  readonly outputFormats: readonly string[];
  readonly isolation: 'cpu' | 'gpu' | 'browser' | 'remote';
  readonly network: 'none' | 'allowlisted';
  readonly authentication: 'none' | 'managed-credential';
  readonly maxInputBytes: number;
  readonly maxConcurrency: number;
  readonly retry: 'never' | 'transient-only';
}

export interface MediaProviderHealth {
  readonly status: 'ready' | 'unavailable';
  readonly checkedAt: string;
}

/** Created by the execution layer after schema validation, policy checks and resource admission. */
export interface MediaExecutionContext<Input extends MediaData = MediaData> {
  readonly executionId: string;
  readonly projectId: string;
  readonly skill: Readonly<SkillRef>;
  readonly input: Immutable<Input>;
  readonly signal: AbortSignal;
}

export interface MediaResourceEstimate {
  readonly cpuSeconds: number;
  readonly memoryBytes: number;
  readonly billedUnits: number;
  readonly unit: string;
}

export interface MediaExecutionResult<Output extends MediaData = MediaData> {
  readonly executionId: string;
  readonly skill: Readonly<SkillRef>;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly durationMs: number;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly warnings: readonly string[];
  readonly output?: Immutable<Output>;
  readonly errorCode?: string;
}

export interface MediaOutputValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface MediaProvider<Input extends MediaData = MediaData, Output extends MediaData = MediaData> {
  readonly descriptor: MediaProviderDescriptor;
  readonly category: MediaProviderCategory;
  healthCheck(): Promise<MediaProviderHealth>;
  capabilities(): readonly MediaProviderCapability[];
  estimateCost(request: MediaExecutionContext<Input>): Promise<MediaResourceEstimate>;
  execute(request: MediaExecutionContext<Input>): Promise<MediaExecutionResult<Output>>;
  cancel(executionId: string): Promise<void>;
  validateOutput(result: MediaExecutionResult<Output>): Promise<MediaOutputValidation>;
}
