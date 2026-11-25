---
name: delegate
description: Assign independent work with explicit ownership and preserve its requirements through integration. Use when handing work to another agent, session, or contributor.
---

# Delegate with evidence

## When to use

Use when independent work can proceed in a separate worker or worktree. Follow AX-08, AX-03, AX-04, and AX-05.

## Procedure

1. Read the authoritative task and applicable instructions before launching a worker. Identify dependencies, the tested base, scope, owned paths, and the integration owner. Partition work so ownership is disjoint. Route shared contracts, manifests, lockfiles, and entry points through their owner. Coordinate overlaps before either worker edits them.
2. Put the objective, parent and task IDs, applicable instructions, principle and profile revisions, policy identity, exact owned paths, acceptance criteria, existing interfaces, required capabilities, limits, and required evidence in the worker's native handoff. Include source references for context and carry the constraints in the handoff itself. Verify which instructions and artifacts the target actually received. Supply missing context explicitly or report the required capability as unavailable.
3. Require the tested revision, changed artifacts, observed check results, and blockers. Preserve worker failures and unavailable checks in the handoff.
4. Review claims against the artifacts and rerun applicable checks after combining the changes. Resolve cross-worker interactions and check that required evidence matches the final source and policy. The parent remains responsible for completion.

## Expected evidence

Keep the worker brief, confirmation of inherited requirements, scope coordination, tested changes, criterion-level results, and the final combined validation. Report missing worker context or evidence with a concrete reason.
