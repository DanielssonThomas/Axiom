# Axiom

Foundational principles, portable skills, and evidence-based validation for AI-assisted engineering.

Axiom is a shared foundation for agents to discover context, reuse existing capabilities, build maintainable components, verify real outcomes, and improve recurring workflows. Its core is independent of any application, employer, or agent vendor.

## Status

The workspace includes shared contracts, a policy resolver, an evidence recorder, a verification engine, and read-only doctor diagnostics. All six portable skills and both optional profiles have deterministic fixture coverage. The pinned Claude Code, Codex, and Hermes adapters have native Linux loopback evidence. Final installed-host qualification and release validation are pending.

Implementation is organized under the [Axiom v1 Epic](https://github.com/DanielssonThomas/Axiom/issues/1) and the [Axiom v1 milestone](https://github.com/DanielssonThomas/Axiom/milestone/1). Start with [the foundation issue](https://github.com/DanielssonThomas/Axiom/issues/2); its contracts enable the parallel workstreams.

## Design

| Layer | Responsibility |
| --- | --- |
| Core fundamentals | Stable principles with explicit conformance requirements. |
| Portable skills | Focused workflows, progressive references, and executable evaluation cases. |
| Optional profiles | Framework-independent atomic UI design, selected explicitly for applicable work. |
| Native adapters | Claude Code, Codex, and Hermes installation, activation, capability reporting, and lifecycle handling. |
| Validation and evidence | Structural checks, repository-native tests, behavioral evaluations, and honest runtime verification. |

The [CLI contract](docs/architecture.md#cli) defines the commands, JSON output, and exit codes.

Axiom uses existing standards and native tools where suitable. Reuse does not require a framework around every small task: identify the responsibility, inspect what exists, and choose the smallest durable implementation. Named domain and API contracts have one authoritative definition, even with one initial consumer.

## Build Axiom

Read [AGENTS.md](AGENTS.md), [the core fundamentals](core/AXIOMS.md), and [the architecture](docs/architecture.md) before claiming an issue.

Use Node.js 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm test -- tests/contracts
pnpm test -- tests/cli
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test -- <path>` builds the workspace and runs only the matching test files. After building, run the CLI with `node packages/cli/dist/index.js doctor --request /absolute/path/to/request.mjs`. The [CLI contract](docs/architecture.md#cli) describes the operator inputs for each command.

Each implementation issue defines owned paths, prerequisites, measurable acceptance criteria, and validation. Use a separate branch or worktree. Coordinate shared contracts, manifests, and lockfiles through the integration owner. Parallel work starts when the required contracts are merged.

Meaningful TDD is the default for executable behavior. Completion requires evidence for the final revision, including relevant live verification or an explicit explanation of what remains blocked or unverified. A passing score cannot hide a failed mandatory criterion.

## License

Publicly visible, **all rights reserved**. This is not an open-source license. See [LICENSE](LICENSE) for the rights notice. Third-party materials retain their own licenses; no third-party repository source is included in this bootstrap.
