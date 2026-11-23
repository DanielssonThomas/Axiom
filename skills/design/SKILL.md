---
name: design
description: Choose a maintainable implementation by finding existing owners, capabilities, and contracts before adding code. Use for new behavior, refactoring, or a change that crosses module boundaries.
---

# Reusable design

## When to use

Use when choosing where behavior belongs or deciding whether to extend a component. Follow AX-02, AX-03, and AX-07.

## Procedure

1. State the responsibility in terms of an observable result and identify its current owner. Search relevant implementation, tests, and repository tools for existing behavior before writing a new component.
2. Reuse the existing owner and public interface when they fit. Consider composing existing capabilities or extending the owner when the same responsibility needs new behavior.
3. Introduce an abstraction when it has a distinct responsibility and a clear owner. Keep a simple operation cohesive when splitting it would add callers and files without independent behavior.
4. Place named shared contracts at their authoritative source and derive or import their consumers. Keep implementation details local and identify the existing behavior the change must preserve.
5. Verify the smallest coherent change through the real entry point and its acceptance criteria.

## Expected evidence

Identify the responsibility, owner, and existing capabilities inspected. Explain the selected reuse or new boundary, any shared contract it consumes, and the verification that checks existing callers and the requested outcome.
