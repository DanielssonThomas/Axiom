# Architecture

The [README](../README.md#status) tracks the current implementation. This document defines v1 responsibilities and verification requirements.

Axiom connects a principle to an applicable workflow, an observable check, evidence, and a truthful completion status. It provides a reusable engineering foundation through native agent integrations, not a new agent runtime.

## Source ownership

| Source | Responsibility |
| --- | --- |
| `core/AXIOMS.md` | Authoritative AX-01–AX-08 principles and conformance semantics. |
| `packages/contracts/` | Versioned data schemas and interfaces; no second normative policy. |
| `skills/<name>/SKILL.md` | Compact portable procedures that reference applicable principles. |
| `skills/<name>/evals/` | Canonical skill-specific evaluation definitions and shared-case references. |
| `profiles/` | Domain-specific refinements, inheritance, check registrations, and configuration. |
| `adapters/` | Native packaging, activation, event translation, and capability detection. |

Metadata links principles to checks and evidence fields. Repeated policy text, native manifests, and backend evaluation formats are generated or referenced from their owner. Generated catalogs are outputs, not independently edited policy sources.

Keep skills generic and selectively load their references. Runtime skill bundles exclude evaluation-only graders and hidden expected outputs. Documentation explains architecture and usage without becoming a competing instruction registry.

## Planned implementation boundaries

| Path | Responsibility |
| --- | --- |
| `packages/cli/` | TypeScript command entry points and composition. |
| `packages/policy/` | Effective-policy resolution and structural checks. |
| `packages/evidence/` | Run records, artifact identity, freshness, and completion status. |
| `packages/verification/` | Bounded execution of repository-native checks. |
| `packages/benchmark/` | Evaluation staging, host-backend orchestration, and reports. |
| `packages/doctor/` | Installed-state, effective-policy, and capability diagnostics. |
| `packages/bundles/` | Reproducible native release assembly. |
| `adapters/{claude,codex,hermes}/` | Thin native integrations backed by shared contracts and logic. |
| `skills/{context,design,verify,diagnose,delegate,knowledge}/` | Core reusable workflows and their local evaluations. |
| `profiles/{ui-atomic,angular-nx}/` | Optional UI and Angular/Nx conventions. |
| `evals/{cases,graders}/` | Shared behavioral cases and independent grading assets. |
| `tests/<area>/` and `tests/integration/hosts/` | Contract, implementation, and actual-host verification. |

Create directories as their work becomes concrete. Native manifests belong at the paths required by each host in the assembled bundle. A narrow Python adapter is appropriate where the host requires it; duplicated one-off orchestration is not.

Use existing libraries, native packaging, framework generators, and repository tools where suitable. Copying upstream repositories, introducing a permanent monitoring daemon, or building a universal installer is outside the initial scope.

## Profiles and UI structure

`ui-atomic` owns the responsibility and dependency rules for atoms, molecules, organisms, and templates. UI-layer dependencies point toward lower layers. Feature composition consumes the appropriate layers while preserving domain ownership.

`angular-nx` extends `ui-atomic` rather than copying its rules. It adds:

- Application shells for bootstrap, routing, configuration, and composition; scoped libraries for reusable behavior and UI.
- A directory for every page and every collection, with component implementation, external template, and relevant tests colocated. For example, `pages/dashboard/dashboard.component.ts` and `pages/dashboard/dashboard.component.html` share the `dashboard` directory.
- Named domain, API, and reusable UI models in their own owned model/schema files, even with one consumer. Existing schema-owned contracts remain derived rather than manually duplicated.
- Appropriate public APIs, selected layer suffix conventions, and dependency restrictions within and between libraries.
- Existing repository test tooling and framework-compatible generator options, selected from the actual installed versions.

A collection is a cohesive feature composition, not automatically another atomic layer. A component directory does not require a separate build library. Private local types need not become public interfaces, and similar DTO/domain/view-model shapes do not imply a single contract.

## Workspace contracts

Import runtime schemas and their inferred TypeScript types from `@axiom/contracts`. Declare it as a `workspace:*` dependency and keep new package builds ordered after their dependencies. The integration owner coordinates changes to shared contracts, central exports, CLI wiring, root configuration and manifests, and the lockfile.

| Contract | Responsibility |
| --- | --- |
| `principleIdSchema`, `policyDefinitionSchema`, `profileDefinitionSchema`, `policyIdentitySchema` | Validate identifier formats, versioned definitions and references, and the effective policy digest. Core prose remains canonical. The policy resolver checks references, applicability, and conflicts. |
| `capabilitySchema`, `hostIdentitySchema` | Describe capability availability and identify agent version, model, OS, and surface. An unavailable capability includes a reason such as `unsupported`. |
| `taskBriefSchema` | Carry task lineage, objective, owned paths, policy identity, acceptance criteria, required capabilities, and execution limits. |
| `evaluationCaseSchema` | Define a versioned fixture, task prompt, applicable principles and profiles, and observable assertions with grader references. |
| `backendRequestSchema`, `backendResultSchema`, `BenchmarkBackend` | Pass staged execution inputs to an abortable backend, then return execution outcome, duration, observed host if available, artifact references, and usage or its absence. The benchmark owns grading and keeps assertions and expected outputs out of backend requests. |
| `evidenceSchema`, `evidenceOutcomeSchema`, `resultStatusSchema` | Record criterion and source identity, observation provenance, timing, optional command invocation, and artifacts. Outcomes use the five core statuses. Every non-passing outcome includes a reason. |

Digests use `sha256:` followed by 64 lowercase hexadecimal digits. Runtime schemas validate record shape and local invariants. Evidence consumers establish coverage, freshness, and conformance.

`@axiom/doctor` consumes the host's configuration and collected observations through its diagnostic API. It checks source digests and binds stage observations to the reported host and file. File inspection establishes installation, while discovery, loading, and enforcement each require observed evidence. The native integration supplies the configuration and observations.

## CLI

Run `node packages/cli/dist/index.js <command>` after `pnpm build`. The CLI recognizes the following commands:

- `doctor`: identify installed versions, active policy/profile sources, skill discovery, hook coverage, and unsupported capabilities.
- `check`: run applicable deterministic checks and selected repository-native verification, with evidence for the assessed scope.
- `benchmark`: execute versioned behavioral cases through actual host backends; the requested `--benchmark <agent>` form is an alias.

Both benchmark forms emit the same result with `command: "benchmark"` and the requested `agent` identifier. Every invocation emits one JSON object to stdout.

| Exit code | JSON output |
| --- | --- |
| `0` | Reserved for successful execution with `status: "passed"`. |
| `1` | Unsuccessful operation. The skeleton emits `command`, `status: "not_run"`, and `reason`, plus `agent` for benchmark. |
| `2` | Invalid invocation. The object includes `status: "failed"` and a usage `reason`. |

Unsupported capabilities produce explicit gaps. Installation alone does not establish instruction activation, successful skill triggering, or enforcement.

## Evidence and evaluations

One structured record links task and parent/child IDs, host/model/Axiom/profile identities, acceptance criteria, check outcomes, durations, and artifact references. Record observable actions and results, not private reasoning. Redact secrets and retain local evidence by default.

Bind results to the relevant source state, including uncommitted changes. Exclude emitted result files from the source identity. Later relevant edits invalidate earlier evidence until affected checks run again. Use the canonical statuses from `core/AXIOMS.md`; required incomplete or stale evidence cannot become a clean result.

Use meaningful TDD for executable behavior. Expected failing tests are development evidence, not final acceptance success. Runtime changes also require relevant running-application verification or an explicit gap; a browser-only check does not establish native-host behavior.

Every maintained skill owns runnable evaluation definitions. Shared cases cover reuse, ambiguity, model ownership, temporary diagnostics, prevention, truthful verification, and delegation. Each objective grader must distinguish seeded compliant and violating artifacts.

Stage evaluations into disposable fixtures. Keep trusted graders, hidden expected results, and governing baselines outside the tested agent's accessible runtime and supplied context. Use repeated trials and controlled with/without-Axiom comparisons; record versions, limits, coverage, partial runs, and available cost/runtime measurements.

Packaged-workflow evaluations and installed-host integration are separate gates. In particular, isolated native evaluations that omit normal user/project rules, settings, or hooks cannot establish their real integration. Hard failures cannot be averaged away by other successful cases.

## Native integration and release

Adapters translate shared contracts into each host's supported mechanisms. They detect version/surface differences and preserve unrelated configuration and agent identity. Hooks run relevant bounded checks; their registration does not prove every action was observed.

Actual-host tests must exercise activation, instruction composition, skill triggering, delegation, relevant lifecycle events, disabled or failing hooks, and truthful handling of unsupported capabilities. Test installation, repeated setup, update, disable, uninstall, and rollback without erasing unrelated edits.

Build versioned native bundles from canonical inputs and locked dependency resolutions. Exclude hidden evaluation assets; record bundle identity and checksums. Test the assembled artifact, not only the source checkout.

Claim support only for verified host, version, surface, and operating-system combinations. Windows, macOS, and Linux compatibility requires executable evidence for each claimed row. Missing credentials, unavailable runtimes, or unsupported host features remain explicit limitations.
