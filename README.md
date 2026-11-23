# Axiom

Foundational principles, portable skills, and evidence-based validation for AI-assisted engineering.

Axiom is a shared foundation for agents to discover context, reuse existing capabilities, build maintainable components, verify real outcomes, and improve recurring workflows. Its core is independent of any application, employer, or agent vendor.

## Status

This repository currently contains the v1 design, contributor rules, and implementation backlog. The CLI, plugins, skills, and automated gates are **planned, not yet implemented or verified**. No package is ready to install.

Implementation is organized under the [Axiom v1 Epic](https://github.com/DanielssonThomas/Axiom/issues/1) and the [Axiom v1 milestone](https://github.com/DanielssonThomas/Axiom/milestone/1). Start with [the foundation issue](https://github.com/DanielssonThomas/Axiom/issues/2); its contracts enable the parallel workstreams.

## Design

| Layer | Responsibility |
| --- | --- |
| Core fundamentals | Stable principles with explicit conformance requirements. |
| Portable skills | Focused workflows, progressive references, and executable evaluation cases. |
| Optional profiles | Atomic UI design and Angular/Nx conventions without putting framework details in the core. |
| Native adapters | Claude Code, Codex, and Hermes installation, activation, capability reporting, and lifecycle handling. |
| Validation and evidence | Structural checks, repository-native tests, behavioral evaluations, and honest runtime verification. |

The planned CLI exposes `axiom doctor`, `axiom check`, and `axiom benchmark <agent>`, with `axiom --benchmark <agent>` as an alias. These names describe the v1 contract; they are not installation instructions.

Axiom uses existing standards and native tools where suitable. Reuse does not require a framework around every small task: identify the responsibility, inspect what exists, and choose the smallest durable implementation. Named domain and API contracts have one authoritative definition, even with one initial consumer.

## Build Axiom

Read [AGENTS.md](AGENTS.md), [the core fundamentals](core/AXIOMS.md), and [the architecture](docs/architecture.md) before claiming an issue.

Each implementation issue defines owned paths, prerequisites, measurable acceptance criteria, and validation. Use a separate branch or worktree. Coordinate shared contracts, manifests, and lockfiles through the integration owner. Parallel work starts when the required contracts are merged.

Meaningful TDD is the default for executable behavior. Completion requires evidence for the final revision, including relevant live verification or an explicit explanation of what remains blocked or unverified. A passing score cannot hide a failed mandatory criterion.

## License

Publicly visible, **all rights reserved**. This is not an open-source license. See [LICENSE](LICENSE) for the rights notice. Third-party materials retain their own licenses; no third-party repository source is included in this bootstrap.
