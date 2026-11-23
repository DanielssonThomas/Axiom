# Atomic UI profile

Select `ui-atomic` for UI work with component or browser behavior requirements. Apply it to the affected UI and use the repository's design system, conventions, and verification tools.

## Reuse and component responsibility

Inspect the existing design system, including its component APIs, variants, and accessibility behavior. Use a suitable component directly or compose it into the feature. When a requirement needs a new component, identify its responsibility and the capability the existing components lack. Keep presentation details that change together with the component that owns them.

| Level | Responsibility |
| --- | --- |
| Atom | One independently meaningful UI primitive, such as the design system's accessible button. |
| Molecule | A focused interaction or presentation composed from primitives, such as a labeled date filter with an apply action. |
| Organism | A cohesive feature section composed from lower levels, such as a catalog toolbar that coordinates filtering and sorting. |
| Template | The structure that places feature sections and content, such as the catalog layout. |

Composition dependencies point toward strictly lower levels. An atom has no internal UI composition dependency, and a higher level can use any lower level. Keep feature-private components inside their owning domain. A cross-domain dependency uses an intentionally public component API and still follows the layer order. A layout can use its catalog toolbar and the toolbar can use the date filter. An atom importing that toolbar creates an upward edge. A date filter importing the toolbar that consumes it also creates a cycle.

Keep decorative markup with its owner when it has no independent responsibility. For example, write the filter's decorative divider inline and use the design system button for the apply action. Splitting the divider into multiple components or rewriting a compatible design system button adds maintenance without solving a separate UI requirement.

## Verification

Map the affected behavior to acceptance criteria and select relevant repository-native automated tests and live observations. Cover each affected area with both kinds of evidence when they are needed to verify the outcome.

| Area | Examples of observable evidence |
| --- | --- |
| Layout | Verify order, spacing, alignment, or overflow in the rendered view for affected states. |
| Interaction | Exercise the user action and observe the resulting application state, including relevant keyboard actions. |
| Responsive behavior | Exercise affected viewport sizes or breakpoints and check reflow, clipping, and operability. |
| Accessibility | Check applicable semantics, accessible names, focus, and keyboard operation with the repository's tools and the running view. |

Record the criterion, tested source and policy identity, view and state, viewport when relevant, actions, observed result, and an artifact reference for each observation. Use `browser-trace` or `ui-observation` references for live observations, with screenshots or automated reports as supporting evidence. A test report demonstrates the test's measured behavior. A live interaction claim needs a corresponding observed interaction in the running view. Record a concrete reason when a check cannot run. A required check remains incomplete when the browser is unavailable or its evidence is stale.

## Profile checks and evaluations

| Check | Inspectable input |
| --- | --- |
| `ui-atomic.composition` | A graph of UI composition dependencies, layers, owners, and public boundaries. |
| `ui-atomic.reuse` | An observed component graph and a compatible component identified independently by the fixture baseline or a reviewer. Feature changes without a confirmed match need a review of the reuse decision. |
| `ui-atomic.verification` | A scoped UI criterion, its expected evidence method, and a matching shared evidence record selected by the verifier. Confirm artifact contents and availability in the verification harness. |

The colocated cases share a synthetic catalog-filter fixture. The composition and reuse exercises ask for inspectable component decisions. The verification exercise checks evidence coverage and truthful reporting. `ui-atomic.responsibility-review` is a behavioral assertion. The reviewer looks for a meaningful interaction boundary, inline decorative markup, and preservation of feature ownership. Mechanical fixture checks establish dependency, reuse, and evidence-record conditions. Live browser observations and installed-agent behavior need separate execution.
