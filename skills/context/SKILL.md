---
name: context
description: Find applicable instructions, acceptance criteria, and existing tools before changing a repository. Use at task start, on scope changes, and when a consequential requirement is unclear.
---

# Context discovery

## When to use

Use before consequential changes or when new information changes the task. Follow AX-01 and AX-05.

## Procedure

1. Identify the requested outcome and the paths likely to change. Read repository and path-scoped instructions, then inspect the issue, authoritative documentation, and relevant code.
2. Inspect manifests, tests, and existing tools for the repository's normal implementation and verification paths. Match each acceptance criterion to the evidence it will need.
3. Resolve open questions from applicable sources first. If a missing or conflicting answer would materially change the outcome, acceptance criteria, scope, or a public interface, ask one focused question before making the dependent change. Include the concrete decision and its impact.
4. Proceed on settled requirements. Use the repository convention for routine, reversible choices and record assumptions that affect verification or handoff.

## Expected evidence

Identify the governing sources and scope, the acceptance criteria, and the relevant tools. Record any material open decision and the dependent work it blocks. Keep the evidence proportional to the task.
