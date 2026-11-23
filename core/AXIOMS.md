# Axiom Core

These principles are Axiom's canonical normative source. Skills, profiles, adapters, and checks reference their stable IDs rather than maintaining separate definitions.

## AX-01 — Understand before changing

Inspect applicable instructions, existing architecture, code, and acceptance criteria before consequential implementation. Use repository evidence to resolve questions; ask when a material requirement remains unknown. Do not repeatedly ask for decisions already established.

## AX-02 — Reuse with clear responsibility

Consider existing capabilities and identify the fundamental responsibility of new work, including small tasks. Choose the smallest coherent boundary that supports maintenance and reuse. Neither unnecessary duplication nor speculative generalization satisfies this principle.

## AX-03 — Give contracts one owner

Give each model, interface, rule, and shared meaning a canonical source and explicit ownership boundary. Reuse or derive its consumers from that source. Similar shapes do not justify merging contracts with different meanings.

## AX-04 — Verify the requested outcome

Validate acceptance criteria using relevant automated checks and required running-system verification. Evidence must describe the delivered state. Verification effort follows affected behavior and risk, rather than rituals or unrelated coverage targets.

## AX-05 — Make claims match evidence

Distinguish implementation, automated validation, live verification, and uncertainty. Report failed, unavailable, incomplete, and stale verification truthfully. A plausible implementation or an agent's assertion does not establish successful behavior.

## AX-06 — Prevent repeated failures

Distinguish observations, hypotheses, and demonstrated causes. Choose proportionate prevention through existing tooling, tests, generators, hooks, skills, or scoped references. Verify that a proposed prevention addresses the demonstrated failure before promoting it into durable policy.

## AX-07 — Preserve maintainability

Give code, scripts, documents, and abstractions a coherent purpose, owner, and lifecycle. Treat new operational capabilities as maintained work by default. Explicitly temporary diagnostics are allowed; they must not silently become permanent dependencies. Update canonical knowledge before creating a competing source.

## AX-08 — Preserve the contract through delegation

Carry applicable requirements, policy/profile revision, scope, ownership, acceptance criteria, limits, and evidence expectations into delegated work. Require inspectable worker results and verify the integrated outcome. Do not assume that children inherit the parent's complete context.

## Authority and conformance

Axiom is user-owned and operates within the host's actual instruction hierarchy. Its files cannot create superior authority over the user or host. An owner may revise future policy or opt out; neither action may be disguised as compliance with the previous contract.

Profiles refine these principles for applicable domains. Repository choices map them to local paths, tools, and boundaries. Explicit scoped exceptions may change configurable profile rules, but cannot silently redefine the core.

Core meaning is immutable within a released policy version. A change requires a new reviewed version; it cannot retroactively redefine compliance with an earlier version.

Task implementations must not weaken their governing policy, evaluator, baseline, or required checks merely to pass. Changes to those controls require review independent of the implementation they would excuse.

| Status | Meaning |
| --- | --- |
| `passed` | Applicable requirements were satisfied by fresh evidence. |
| `failed` | Executed validation demonstrated an unmet requirement. |
| `blocked` | A required prerequisite or capability prevented validation. |
| `not_run` | Validation has not been executed. |
| `not_applicable` | The check does not apply, with a recorded reason. |

Required failed, blocked, unrun, missing, or stale verification prevents conforming completion. `not_applicable` cannot waive a required check. An honest report can satisfy AX-05 while leaving another acceptance criterion incomplete.

Enforcement coverage must be stated accurately. Structural checks establish their measured conditions; behavioral evaluations establish results under tested conditions. Neither proves that an arbitrary agent can never disobey.
