# Angular and Nx profile

Select `angular-nx` for Angular source maintained with Nx project and library conventions. The profile inherits [atomic UI composition and verification](../ui-atomic/PROFILE.md). Use those rules for design-system reuse, dependency direction, owner visibility, and live evidence.

## Application and library boundaries

Keep applications focused on bootstrap, routing, provider configuration, and composition. Keep feature behavior in libraries scoped to the domain or capability that owns it. Cross a project boundary through its declared public entry point and TypeScript path mapping. Keep feature-private implementation in the owning library.

| UI level | File ending | Class ending |
| --- | --- | --- |
| Atom | `-atom.component.ts` | `AtomComponent` |
| Molecule | `-molecule.component.ts` | `MoleculeComponent` |
| Organism | `-organism.component.ts` | `OrganismComponent` |
| Template | `-template.component.ts` | `TemplateComponent` |

Use the repository's domain layout and the established layer directory names for atomic components. A feature page or collection composes the appropriate layers. Each page and collection owns its own directory and keeps its component, same-stem external template, styles, and related tests together. For example, `pages/dashboard/dashboard.component.ts` and `pages/dashboard/dashboard.component.html` share the `dashboard` directory, and `collections/results/results.component.ts` owns the corresponding `results.component.html`.

## Model ownership

Place named domain, input/output, and view-model contracts in a scoped `*.model.ts` file. Use the existing schema owner for a contract derived from a schema. Export the named definition from its owning file even when it has one consumer. Expose it through the library entry point when the contract is intentionally public. Keep a helper type local when its meaning is confined to one implementation. Independently scoped contracts can have similar shapes.

## Repository-native tools

Read the actual workspace and project definitions, TypeScript aliases, generator collections, and build, test, and lint targets. Use the installed versions, supported generator options, and project conventions. Review generator output before integrating it. Treat existing paths as a collision and preserve their contents. Plan any existing-application reorganization as an explicitly scoped change.

`inspectAngularWorkspace` consumes inspected project roots, shell paths, aliases, declared model ownership, and the affected source files. It checks file placement, module boundaries, model declarations and exports, and atomic import edges through the inherited composition checker. The caller supplies the project and domain ownership expectations. Mechanical results establish only the measured source conditions.

The disposable fixture uses Angular CLI and its installed component schematic, then selects Angular build and TestBed tests and ESLint via Nx's declared targets. The component generator wrapper supports matching Angular CLI and schematics in major version 21, with the locked fixture verifying 21.2.26 with Nx 22.7.12. Check the installed repository conventions when using another collection or version.

Run the deterministic profile checks with `pnpm test -- tests/profiles/angular-nx`. To include native generation, build, tests, and lint, install the locked fixture dependencies in a separate directory and pass that directory's `node_modules` to the test. The test stages a fresh workspace and discards it afterward.

```sh
fixture=profiles/angular-nx/evals/fixtures/angular-workspace
fixture_deps=$(mktemp -d)
cp "$fixture/package.json" "$fixture/package-lock.json" "$fixture_deps/"
npm ci --prefix "$fixture_deps"
AXIOM_ANGULAR_FIXTURE_MODULES="$fixture_deps/node_modules" pnpm test -- tests/profiles/angular-nx
```
