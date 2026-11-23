# Axiom bundle installation

Use a reviewed Axiom checkout and a pinned native CLI. The [compatibility matrix](compatibility.md) records observed host versions and supported surfaces.

## Prepare a native distribution

Run these commands from the reviewed checkout using Node.js 24, the pinned pnpm version in `package.json`, and Git. Use a new output directory and set the artifact version explicitly. The commands below stage version `0.1.0` for local qualification.

```sh
AXIOM_CHECKOUT="$PWD"
AXIOM_DIST="$AXIOM_CHECKOUT/dist/axiom-0.1.0"
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js bundle --out "$AXIOM_DIST" --version 0.1.0
```

The build stages native Claude and Codex marketplaces and a local Git repository for Hermes. The default includes the complete core and all canonical skills. Add `--profile angular-nx` to select Angular/Nx with its inherited atomic UI profile. The command reports the local Hermes file URL and full Git commit for its native pin. Save `axiom-distribution.json` with the staged artifacts. It records the committed source revision, artifact version, resolved policy identity, pinned CLI versions, and per-host digests. Build fixtures under `packages/bundles/dist/fixtures` support packaging tests and carry `fixture: true`.

The assembler selects canonical runtime files and excludes evaluations, graders, credentials, and run outputs. Claude and Hermes use the shared runtime inventory in `axiom-bundle.json`, and the Codex distribution pins its file inventory by digest. A repeat build from the same reviewed inputs produces the same distribution manifest and Hermes commit.

## Claude Code

Use Claude Code **2.1.330** and Node.js 24 on `PATH` for the installed hook. Run `claude --version` before installing. From the intended project, select `local` for that project's personal settings, `project` for shared project settings, or `user` for a user-wide installation. [Claude Code plugin CLI reference](https://code.claude.com/docs/en/plugins/cli-reference.md)

```sh
claude plugin marketplace add "$AXIOM_DIST/claude"
claude plugin install axiom@axiom-local --scope local
claude plugin list --json
```

For a versioned update, stage the newer reviewed artifact and make its complete `claude` directory available at the registered marketplace path. Refresh the marketplace and update the installed plugin at its selected scope.

```sh
claude plugin marketplace update axiom-local
claude plugin update axiom@axiom-local --scope local
claude plugin disable axiom@axiom-local --scope local
claude plugin uninstall axiom@axiom-local --scope local
```

Start a new Claude Code session or run `/reload-plugins` after a lifecycle change. Local and user plugins do not carry into Claude Code cloud sessions. [Claude Code plugin installation](https://code.claude.com/docs/en/plugins/install.md)

## Codex CLI

Use Codex **0.172.0-alpha.2** and confirm with `codex --version`. The Axiom command registers and installs the package through the pinned native plugin mechanism and manages the Axiom-owned core instruction block in the selected profile's `AGENTS.md`. Use `--home` to select a disposable profile, or use the current `CODEX_HOME` or native default. Use `--program` if the pinned Codex binary is outside `PATH`. [Codex plugin documentation](https://developers.openai.com/codex/plugins/)

```sh
node "$AXIOM_CHECKOUT/packages/cli/dist/index.js" codex install --distribution "$AXIOM_DIST"
codex plugin list --marketplace axiom-local --available --json
```

Use the same Axiom lifecycle entry point for updates and removal so the profile instructions follow the native selection. Set `AXIOM_NEXT` to the newly staged distribution. Specify the same `--home` if you selected another profile. [Codex CLI reference](https://developers.openai.com/codex/cli/reference/)

```sh
node "$AXIOM_CHECKOUT/packages/cli/dist/index.js" codex update --distribution "$AXIOM_NEXT"
node "$AXIOM_CHECKOUT/packages/cli/dist/index.js" codex disable
node "$AXIOM_CHECKOUT/packages/cli/dist/index.js" codex uninstall
```

## Hermes Agent

Use Hermes Agent **0.23.3** and a named profile. Confirm the CLI with `hermes --version`. The installed shared checker uses Node.js 24 on `PATH`. Set `AXIOM_HERMES_URL` to `hermesUrl` printed by the staging command and obtain its full commit from the staged Git source. Hermes's package manager may provision its pinned Python runtime during the first installation. [Hermes Agent plugin lifecycle](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

```sh
AXIOM_HERMES_PIN=$(git -C "$AXIOM_DIST/hermes" rev-parse HEAD)
hermes profile create axiom-test --no-alias --no-credentials
hermes --profile axiom-test plugins install "$AXIOM_HERMES_URL" --ref "$AXIOM_HERMES_PIN" --no-enable
hermes --profile axiom-test plugins enable axiom
hermes --profile axiom-test plugins list --user --json
```

Use the profile creation command for a disposable installation. For an existing profile, use its name. To update a staged local Git source while retaining its URL, fetch the reviewed commit from a newly staged distribution into that source. Set `AXIOM_NEXT` to the new distribution and choose a local branch name that describes the release.

```sh
AXIOM_NEXT_PIN=$(git -C "$AXIOM_NEXT/hermes" rev-parse HEAD)
git --git-dir "$AXIOM_DIST/hermes" fetch --no-tags "$AXIOM_NEXT/hermes" "$AXIOM_NEXT_PIN:refs/heads/axiom-update"
hermes --profile axiom-test plugins install "$AXIOM_HERMES_URL" --force --ref "$AXIOM_NEXT_PIN" --enable
hermes --profile axiom-test plugins disable axiom
hermes --profile axiom-test plugins remove axiom
```

Start a new session in the selected profile after changing plugin state. Check the native inventory, then verify policy loading and a skill call in that session. [Hermes Agent plugin lifecycle](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)

## Verify the result

Record the artifact and policy digests, host version and surface, selected scope or profile, and native observations. Use the [compatibility matrix](compatibility.md) to check the tested configurations and qualification gaps.
