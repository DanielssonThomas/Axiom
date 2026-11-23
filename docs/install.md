# Axiom bundle installation

The workspace builds three native-layout fixtures for packaging and lifecycle tests. Verify the installed release and supported host versions against the integration evidence from [#19](https://github.com/DanielssonThomas/Axiom/issues/19) before installing in a working profile. The fixture manifests identify themselves as fixtures. They exercise packaging without asserting policy activation, skill behavior, or lifecycle enforcement.

## Build and inspect

Run `pnpm install --frozen-lockfile` and `pnpm build` from the repository root. The build lists fixture directories under `packages/bundles/dist/fixtures/<version>/<host>/<digest>`. Each directory includes an `axiom-bundle.json` with the source revision, artifact version, policy identity, normalized policy and skill file hashes, runtime inventory, and missing adapter requirements. The build records Git HEAD when available. For an exported source tree, supply its known revision as `AXIOM_BUNDLE_SOURCE_REVISION`; otherwise the manifest identifies it as a source archive.

The assembler copies canonical `core/AXIOMS.md`, selected profiles and their parents, the selected skill entry points and declared runtime references, and `LICENSE`. An adapter supplies the native manifests and any explicitly required runtime files. Reference paths stay inside the owning skill's `references/`, `assets/`, or `scripts/` directory. Assembly rejects invalid paths and symlinks. Private evaluations, graders, held-out data, credentials, and run outputs stay outside the runtime inventory.

Artifact normalization uses UTF-8 text, LF line endings, and POSIX relative paths sorted by code-unit order. It preserves other textual content. All inventory hashes use SHA-256. The shared policy resolver provides `policy.digest`, and `policyContentDigest` fingerprints the exact normalized core and profile files carried by the artifact. Each skill hash fingerprints its entry point and declared runtime references. The bundle digest covers the manifest fields and ordered file hashes before the digest field is appended. File timestamps and permissions are outside this digest. A repeated write verifies an existing content-addressed artifact.

## Claude Code

The commands below follow the Claude Code 2.1.330 CLI reference. Use a local marketplace directory containing the Claude artifact and keep its path stable across versions, or use a release marketplace while keeping the same qualified plugin identifier. Select `local` for your current project only, `project` for shared project settings, or `user` for your user settings. Run every lifecycle command at the intended scope. [Claude Code plugin CLI reference](https://code.claude.com/docs/en/plugins/cli-reference.md)

```sh
claude plugin marketplace add /absolute/path/to/claude-marketplace
claude plugin install axiom@axiom-local --scope local
claude plugin marketplace update axiom-local
claude plugin update axiom@axiom-local --scope local
claude plugin disable axiom@axiom-local --scope local
claude plugin uninstall axiom@axiom-local --scope local
```

Run the two update commands after the newer artifact is available at the registered source. Start a new Claude Code session or run `/reload-plugins` in the session after lifecycle changes. Local and user plugins do not carry into Claude Code cloud sessions. [Claude Code plugin installation](https://code.claude.com/docs/en/plugins/install.md)

## Codex CLI

The commands match the plugin CLI in Codex 0.172.0-alpha.2. Select the intended local Codex home, using `CODEX_HOME` to isolate a test profile. Register a stable local marketplace directory that contains the Codex artifact. This flow uses a local Codex configuration scope. [Codex plugin documentation](https://developers.openai.com/codex/plugins/)

```sh
codex plugin marketplace add /absolute/path/to/codex-marketplace
codex plugin add axiom@axiom-local
codex plugin list --marketplace axiom-local --available
codex plugin remove axiom@axiom-local
```

After a newer version is available at the configured source, run `codex plugin add axiom@axiom-local` again. For a Git-backed marketplace, run `codex plugin marketplace upgrade axiom-local` first and then install the updated plugin. For a session-only disable, launch with `codex -c 'plugins.axiom@axiom-local.enabled=false'`. To disable persistently, set `enabled = false` in `[plugins."axiom@axiom-local"]` in the selected home's `config.toml` or use the native plugin management UI. Open a new session after changing the installation or plugin selection. Query the installed state before treating a lifecycle command as evidence of activation. [Codex CLI reference](https://developers.openai.com/codex/cli/reference/)

## Hermes Agent

These commands follow Hermes Agent v0.23.3. Select the profile explicitly for every operation. Use a Git release source containing the Hermes artifact at its root, or place the artifact in a disposable Git repository for a local test. Replace `/absolute/path/to/hermes-release` with that repository and use its version tag. [Hermes Agent plugin lifecycle](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

```sh
hermes --profile axiom-test plugins install file:///absolute/path/to/hermes-release --ref v0.1.0
hermes --profile axiom-test plugins enable axiom
hermes --profile axiom-test plugins install file:///absolute/path/to/hermes-release --force --ref v0.2.0
hermes --profile axiom-test plugins disable axiom
hermes --profile axiom-test plugins remove axiom
```

The second install explicitly selects a new version for a pinned source. An unpinned Git install uses `hermes --profile axiom-test plugins update axiom` to follow its configured origin. Start a new session in the selected profile after changing plugin state. Verify the selected profile's installed files and actual loading independently from discovery. [Hermes Agent plugin lifecycle](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

## Verify the result

Record the artifact digest, host version and surface, selected scope or profile, and any missing capabilities. Install, update, disable, and uninstall evidence in this branch comes from fixture configuration. Final native installation, activation, and ordinary-session behavior require the integration matrix.
