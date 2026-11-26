---
name: delegate
description: Delegate with explicit ownership and a structured worker brief. Verify delivery directly or through a digest-bound reference.
---

# Delegate with evidence

## When to use

Use when independent work can proceed in a separate worker or worktree. Follow AX-08, AX-03, AX-04, and AX-05.

## Procedure

1. Read the authoritative task and applicable instructions before launching a worker. Identify dependencies, the tested base, scope, owned paths, and the integration owner. Partition work so ownership is disjoint. Route shared contracts, manifests, lockfiles, and entry points through their owner. Coordinate overlaps before either worker edits them.
2. Put the objective, parent and task IDs, applicable instructions, principle and profile revisions, policy identity, exact owned paths, acceptance criteria, existing interfaces, required capabilities, limits, and required evidence in the worker's native handoff. Include source references for context and carry the constraints in the handoff itself. Verify which instructions and artifacts the target actually received. Supply missing context explicitly or report the required capability as unavailable.
3. Require the tested revision, changed artifacts, observed check results, and blockers. Preserve worker failures and unavailable checks in the handoff.
4. Review claims against the artifacts and rerun applicable checks after combining the changes. Resolve cross-worker interactions and check that required evidence matches the final source and policy. The parent remains responsible for completion.

## Verifiable native handoffs

Use the host's structured Axiom task brief when present. Include the worker's own `id`, `parentId`, `objective`, `ownedPaths`, and effective `policy` with `version`, `digest`, and `profiles`. Carry `criteria` with each `id`, `description`, and `required` value, the `requiredCapabilities`, and the execution `limits` with `timeoutMs`, `maxAttempts`, and `maxConcurrency`.

When the verifier can observe worker reads and the native handoff body is opaque, write the full JSON brief to a temporary workspace file and record its SHA-256 before delegating. Send the work objective, path, and digest through the native handoff. The linked worker must read that exact file and check its digest before editing. On Linux, separate `sha256sum -- path` and `cat -- path` commands expose the digest and read to native command observers. Keep the reference available until the worker completes and remove the temporary file before verifying the delivered source. If native delivery is unobservable on the selected surface, record the missing evidence.

## Expected evidence

Keep the worker brief, confirmation of inherited requirements, scope coordination, tested changes, criterion-level results, and the final combined validation. Report missing worker context or evidence with a concrete reason.
