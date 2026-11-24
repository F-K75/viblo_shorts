# Forge Media OS foundation

FMO-002 and FMO-003 record the integration map and architecture decisions for
Media OS v1.0.0 in Forge Studio. The verified base is described in the
[repository discovery](FMO-001_REPOSITORY_DISCOVERY.md). The first release
objective is five uploaded clips and a creative brief, a server-rendered
vertical Reel with captions and music, a persisted independent QA report, and
an approved version in the originating project's internal artifact library.

## FMO-002 integration map

| Stage | Existing Forge seam | Media OS contract |
| --- | --- | --- |
| Admit request | Express setup and identity in `server.ts`, `server/lib/auth.ts`, `server/lib/requestGuards.ts`, and `server/routes/projects.ts` | Add owner-scoped `/api/v1/media` routes. Bind project and asset access to the verified identity. Enforce budgets and rights at admission and recheck them before execution. |
| Resolve capabilities | Existing queue has fair job claiming but no capability graph | Load versioned manifests through `server/media/{manifest,registry}.ts`. Resolve exact versions in dependency order after checking verification evidence, provider capability, resources and permissions. |
| Validate the edit | Script beats in `src/types.ts` and timing helpers in `src/utils/pipeline.ts` | Parse the versioned edit document in `server/media/timeline.ts`. Look up stored media, verify project ownership and check source times against measured stream lengths before any process runs. |
| Execute | `server/lib/repo.ts`, `server/lib/jsonRepo.ts`, `server/db/pgRepo.ts`, render claim and heartbeat in `server.ts` | Use one durable queue. Extend its claim filters and execution fencing for Media OS job types. Execute through `server/media/provider.ts` after checking binary readiness via `server/media/ffmpegReadiness.ts`. |
| Measure and approve | `server/lib/videoQuality/` measures actual output and returns structured findings | Adapt measured facts for the Media OS QA contract. Store ruleset version, original brief and timeline revision, output digest, measurements and timestamped findings with every decision. |
| Deliver and monitor | `GET /api/jobs/:id`, `src/utils/api.ts`, React project and preview components | Serve owner-scoped workflow state and authorized artifacts. Restore the view from REST with a per-run event sequence for replay. Reuse the React project navigation and report patterns. |

The earlier prototype at `8b6e826` is available for selective reuse after each
piece passes contract and integration tests against current `main`. Preserve
the dirty worktree. Candidate pieces include fixed command builders, media
fixtures, timeline validation patterns, and UI controls. The existing prototype
worker, persistence, and QA approval need to meet the decisions below before
adoption.

## FMO-003 architecture decisions

### FMO-ADR-001 · Use the existing repository and durable queue

Implement runtime contracts in TypeScript on Node and Express. Store project,
timeline, workflow, artifact, QA and outbox metadata through the existing
`Repo` seam. PostgreSQL is the production coordinator. Preserve the JSON
backend's single-process development and rollback behavior. Reuse job claim,
heartbeat, cancellation, leases, admission and recovery semantics. Introduce
typed Media OS dispatch and claim filters before exposing new job types to
workers. Compare-and-set completions must verify the job's current lease so a
cancelled or superseded attempt cannot approve an artifact.

### FMO-ADR-002 · Version the pilot contracts and qualify availability

The checked-in pilot manifest uses JSON syntax in `manifest.yaml`, a YAML 1.2
subset. Native TypeScript runtime validation fulfills the role assigned to
Pydantic in the specification. Keep the v1 manifest fields and exact version
references. Discovery reads manifests without loading skill instruction text.
Keep declared `planned` or `registered` state separate from operational
readiness. Only verified contract tests and compatible, healthy providers
can qualify a skill as available. The resolver also checks each selected
dependency's availability. The pilot edit contract uses
integer milliseconds, bounded contiguous video cuts, caption cues, a typed
music track, and asset IDs. The workflow enforces the five-clip, captions,
and music acceptance case on top of the parser's more general bounded inputs.

### FMO-ADR-003 · Put media processing in an isolated worker

Use a separately deployed CPU worker with bounded scratch storage, subprocess
output, time, CPU and memory. Resolve asset IDs to worker-local inputs through
authorized storage access. Pass fixed argument arrays to allowlisted binaries
with a restricted environment. Deny media subprocess network access and use
only task-scoped filesystem access. The API handles request validation and
admission. Use read-only sources and unique output paths per attempt. Prove
cancellation, timeout and worker-restart recovery before enabling processing
of uploaded assets.

### FMO-ADR-004 · Store immutable sources and artifact versions

Retain original bytes as immutable, project-owned assets. Store metadata and
digests in the repository and use shared object storage for multi-instance
delivery. Keep unpublished renders in attempt-scoped staging. Commit a derived
version with its input asset digests, edit revision and job provenance. Make
the approved artifact visible only when the QA decision for that exact digest
is durable. Local storage is suitable for development fixtures and scratch.

### FMO-ADR-005 · Persist workflow events in a transactional outbox

Write job and artifact transition events in the same transaction as the
associated state change. Store a versioned envelope with project scope, event
ID, run ID, correlation ID and per-run sequence. Design delivery for at-least-
once use and deduplication by event ID. Reconnection can load the authoritative
REST snapshot and replay after the last sequence. Live transport can follow
the durable contract without owning job state.

### FMO-ADR-006 · Gate internal approval on independent QA

Run technical and creative review under identities distinct from rendering
and planning. Review the exact encoded bytes and original brief, and bind
the result to the media digest. Require valid evidence for every mandatory gate
and a weighted score of at least 90/100. Critical failure or missing mandatory
evidence holds the version for review regardless of score. The existing QA
modules provide measured facts for this adapter. Use the Media OS weights for
technical integrity (20), visuals (20), audio (15), editing and pacing (15),
brief compliance (15), typography and subtitles (5), brand (5), and platform
compliance (5). A repair creates a new version with a new evaluation, up to
three automatic revisions within budget.

### FMO-ADR-007 · Gate autonomous runtime on verified execution

Enable autonomous planning and tool invocation only after tests demonstrate
capability availability checks, ownership, worker isolation, budget
reservations, recovery and independent approval. Keep policy enforcement at
the tool boundary and evaluate it for each invocation. The pilot uses approved
local providers and internal artifact delivery. External publishing and
paid generation require separately configured authorization.

## Implementation inventory

FMO-004 through FMO-008 establish the pilot namespaces under
`server/media/`. The contracts live in `manifest.ts` and `timeline.ts`.
Registry validation lives in `registry.ts` and the repository validator in
`validateManifests.ts` checks the pilot package at
`media_skills/video_editing/video-trimming/`. Provider interfaces
live in `provider.ts`, and the first FFmpeg/FFprobe binary readiness check
lives in `ffmpegReadiness.ts`. Readiness and manifest registration are inputs
to execution qualification. The remaining work is tracked separately from
those foundations.

| Task | Planned files and seams | Evidence required |
| --- | --- | --- |
| FMO-008 · Provider execution | Add `server/media/ffmpegProvider.ts` with typed probe and render operations, sharing appropriate existing code from `server/lib/videoQuality/probe.ts`. | Generate and decode synthetic fixtures with native FFmpeg and FFprobe. Verify allowlisted operations, timeouts and cancellation. |
| FMO-009 · CPU worker | Add `server/media/worker.ts` and an isolated deployment definition. Extend `Repo` job claims and `server.ts` dispatch integration. | Validate process limits, isolation, stop propagation, restart and completion fencing. |
| FMO-010 · Assets and versions | Add a media storage adapter, repository methods, PostgreSQL migration and updates to both repository implementations and backup coverage. | Verify ownership, immutable byte identity, version history, storage failures and restoration. |
| FMO-011 · Resolver integration | Connect the registry to job admission and worker dispatch. Bind available implementation evidence and provider health to exact dependency versions. | Verify unavailable operations, cycles, policy denial and provider failure behavior. |
| FMO-012 · Reel workflow | Add `server/media/reelWorkflow.ts` and `server/routes/media.ts`, wired through `server.ts`. Store typed timeline revisions, work state and outbox events. | Exercise five owned clips, a creative brief, caption timing and music in a real vertical render. Recover from worker interruption. |
| FMO-013 · Independent QA | Add `server/media/qualityGate.ts` and persistent report and approval methods in the repository. | Reject defective media and forged or missing evidence. Approve an actual decoded artifact with score ≥ 90 and every mandatory gate passing. |
| FMO-014 · Revision planner | Add `server/media/revision.ts` with bounded timeline patches based on stored findings. | Demonstrate repair and re-evaluation, history preservation, and budget exhaustion handling. |
| FMO-015 · Studio foundation | Add Media Studio views and API bindings under `src/components/` and `src/utils/`, reusing the authenticated project flow. | Verify upload, workflow status, reconnect, visible QA status and authorized artifact retrieval in a browser. |

## Local verification

- `npm run media:validate` returned `video-trimming@1.0.0` in the `planned` state.
- The registry, timeline, and binary readiness suites passed all 15 tests. The same run included 22 existing footage, timing, auth, and storage tests, for 37 passing tests total.
- `npm run build` passed, including the frontend and server typechecks.
- The real readiness check detected FFmpeg 7.1 and reported the provider unavailable because FFprobe was missing. The existing quality baseline passed 12 of 24 tests in that environment. Those results do not certify the renderer or quality gate.

Release classification remains `NOT_READY` until the first-slice workflow
and its acceptance gates are verified. See the [task board](TASK_BOARD.md) for
task owners and current evidence.
