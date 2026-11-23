---
name: diagnose
description: Reproduce a failure, verify its cause, and place prevention in the owning test, tool, rule, or scoped documentation. Use for recurring defects and repeated workflow failures.
---

# Diagnose and prevent recurrence

## When to use

Use when the cause of a failure is uncertain or a failure is likely to recur. Follow AX-02, AX-06, and AX-07.

## Procedure

1. Record observations, the smallest repeatable trigger, and the affected entry point. Inspect existing tests, tooling, documentation, and prior fixes for the responsibility.
2. List plausible causes separately from observations. Vary one relevant condition at a time and use a failing check or concrete comparison to establish which condition causes the observed failure.
3. Choose the smallest preventive change at the existing owner. Extend the relevant test, lint rule, hook, tool, or scoped procedure when it can reliably catch the demonstrated cause.
4. Run the prevention against both the original failure and the repaired behavior. Record how it would detect recurrence. Keep exploratory diagnostics temporary.
5. Before adding a maintained script or document, identify its owner, scope, and lifecycle. Update the existing authority where possible. Promote durable guidance only after the evidence supports the relevant scope.

## Expected evidence

Record the observation, rejected or unresolved hypotheses, demonstrated cause, owning preventive change, and the results that show it catches recurrence. Record any scope or verification gaps.
