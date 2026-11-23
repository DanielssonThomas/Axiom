# Axiom bundle installation

The workspace builds three native-layout fixtures for packaging and lifecycle tests. Their manifests set `fixture: true`. Before installing a release in a working profile, verify the artifact and your host version against the [compatibility matrix](compatibility.md).

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

These commands use Hermes Agent 0.23.3 and a named profile. The installed shared checker uses Node.js 24 on the host's `PATH`. For a disposable Git test, place the assembled native Hermes artifact at the Git repository root. Set `HERMES_RELEASE_URL` to that repository's `file://` URL and set `INITIAL_COMMIT_SHA` and `UPDATE_COMMIT_SHA` to the full 40-character commit SHAs for the reviewed artifacts. Hermes's package manager may provision its pinned Python runtime during installation. [Hermes Agent plugin lifecycle](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

```sh
export HERMES_HOME=/absolute/path/to/disposable-hermes-home
hermes profile create axiom-test --no-alias --no-credentials
hermes --profile axiom-test plugins install "$HERMES_RELEASE_URL" --ref "$INITIAL_COMMIT_SHA" --no-enable
hermes --profile axiom-test plugins enable axiom
hermes --profile axiom-test plugins list --user --json
hermes --profile axiom-test plugins install "$HERMES_RELEASE_URL" --force --ref "$UPDATE_COMMIT_SHA" --enable
hermes --profile axiom-test plugins disable axiom
hermes --profile axiom-test plugins remove axiom
```

The second install moves the source pin to the reviewed update. Start a new session in the selected profile after changing plugin state. Check the native inventory, then verify policy loading and a skill call in that session. [Hermes Agent plugin lifecycle](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

## Verify the result

Record the artifact and policy digests, host version and surface, selected scope or profile, and native observations. Use the [compatibility matrix](compatibility.md) to check the tested configurations and qualification gaps.
