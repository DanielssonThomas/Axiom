---
name: verify
description: Verify acceptance criteria against the delivered source and running system. Use for new behavior, regression fixes, and completion reviews that need credible evidence.
---

# Verify the outcome

## When to use

Use when changing executable behavior, reviewing acceptance, or verifying a delivered revision. Follow AX-04 and AX-05.

## Procedure

1. Map each criterion to an observable outcome and find the repository's existing test and runtime commands. Identify which criteria need a running application or a real host.
2. For executable behavior, write a test that fails for the requested missing behavior. Check the failure reason before changing implementation. Use meaningful inputs and outputs through the normal entry point. Record a concrete justification and compensating check when a meaningful RED test cannot run.
3. Run the targeted checks after the change. Run affected regressions and the relevant repository-native type, build, and acceptance checks. Treat expected RED as development evidence.
4. Exercise affected runtime behavior through its real entry point when applicable. Record the action, resulting state, environment, and artifact. Use test and build output for the conditions those commands measured.
5. Compare evidence to the final relevant source, configuration, and policy. Rerun affected checks after changes. Carry each required failed, blocked, unrun, missing, or stale result into the completion decision.

## Expected evidence

Report each criterion, exact command or live action, tested identity, result, and artifact. Record why a required check could not run or why a check does not apply. Keep unverified work visible at handoff.
