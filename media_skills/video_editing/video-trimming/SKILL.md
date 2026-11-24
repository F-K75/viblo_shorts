---
name: video-trimming
description: Trim an authorized video asset to a specified source window.
---

# Video Trimming

Status is `planned`. The manifest and example define the contract.

Resolve the asset through the project repository and verify ownership before staging it. Probe its duration and require a finite source window where `0 ≤ start_seconds < end_seconds ≤ source_duration`. The provider must render to a new artifact and preserve the source asset. Independently decode the result and compare its duration to the requested range before completing the execution.

Use opaque asset and artifact IDs. The provider builds its own arguments from the validated time range and authorized staged files. Treat invalid timestamps and unauthorized assets as permanent failures.

The registry test exercises discovery and the declared contract. Availability requires a provider implementation, controlled render and decode tests, and healthy worker binaries.
