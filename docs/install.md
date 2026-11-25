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

For the experimental development distribution, use an empty output path and select the profile explicitly.

```sh
AXIOM_DIST="$PWD/dist/axiom-0.1.0-praxis.1"
node packages/cli/dist/index.js bundle --out "$AXIOM_DIST" --version 0.1.0-praxis.1 --profile angular-nx
```

This version is intended for early Praxis development with Angular/Nx and inherited atomic UI policy. Use the native installation commands below with its staged directory and manifest. Its qualification status is experimental.

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

For the Angular/Nx distribution, the system prompt carries the full core and a profile index. Relevant work retrieves the complete canonical profiles through native `skill_view`. Use `name="axiom:profile-angular-nx", file_path="PROFILE.md"` and `name="axiom:profile-ui-atomic", file_path="PROFILE.md"`. The recorded policy remains incomplete until the provider-bound request contains both native tool results.

## Verify the result

Record the artifact and policy digests, host version and surface, selected scope or profile, and native observations. Use the [compatibility matrix](compatibility.md) to check the tested configurations and qualification gaps.

## Run a local behavioral benchmark

### Standard mode with an existing native login

Build from a clean reviewed checkout on Linux. Authorize the named host to use your account and its available quota with `--allow-native`. Native plan charges and usage limits are controlled by the host account. The standard mode requires no separate API key.

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js benchmark codex --mode standard --allow-native
node packages/cli/dist/index.js benchmark hermes --mode standard --allow-native
node packages/cli/dist/index.js benchmark claude --mode standard --allow-native
```

| Host | Native account route |
| --- | --- |
| Codex 0.172.0-alpha.2 | Use an existing ChatGPT login in Codex's file credential store. The runner lets Codex share and refresh the native login through a link in a disposable home. Its named tool sandbox guards that store and the evidence archive. If the current login exists only in an OS keyring, use a dedicated native benchmark home. |
| Hermes 0.23.3 | Use `hermes --profile default auth status openai-codex`. The runner creates a temporary named standalone profile with the `openai-codex` provider and requested model for each attempt. Hermes uses its native fallback to the default profile's OpenAI Codex OAuth. The foreground gateway belongs to that temporary profile, which the runner removes after use. To sign in first, use `hermes --profile default auth add openai-codex --browser`. |
| Claude Code 2.1.330 | Use an existing first-party Claude subscription login visible to `claude auth status`. The runner uses restricted file and skill tools with the native session-only plugin in the Axiom arm. |

For a dedicated Codex login, use the ordinary device login once, then keep using that home.

```sh
mkdir -p "$HOME/.codex-axiom"
CODEX_HOME="$HOME/.codex-axiom" codex -c 'cli_auth_credentials_store="file"' login --device-auth
node packages/cli/dist/index.js benchmark codex --mode standard --allow-native --auth-home "$HOME/.codex-axiom"
```

The default runs two serial attempts of `reuse-summary-formatter`, with and without Axiom. The time limit defaults to 120 seconds. Use `--timeout-seconds`, `--repetitions`, and `--max-attempts` to bound the plan. Ctrl+C cancels the run. Use `--program` to locate the pinned CLI, `--model` for an exact account-supported identifier, or `--auth-home` to select the native credential store. Codex and Hermes default to `gpt-5.4`. Claude defaults to `claude-haiku-4-5-20251001`. Codex records its requested identifier. Hermes matches the model echoed in native initialization and requires a terminal result for a native session. Claude checks the model reported by its native stream.

The benchmark report and archive retain only a fixed reason for recognized Codex provider model rejection, access refusal, or rate limits. An exit without a recognized terminal event retains the generic blocked reason. If the provider rejects the requested model, use `--model` with an exact identifier supported by the same signed-in account.

Hermes reports a fixed blocked reason for recognized failures before a session was established. The reasons can identify credential or agent initialization, local gateway access or connectivity, and gateway session startup. If Hermes reports a credential or agent initialization failure, check the selected auth root's default-profile login and the exact account-supported model. Raw native error text stays out of the archive.

An attempt can finish native execution and still block during fixture capture or verifier preparation. The attempt keeps those outcomes separate and reports a fixed reason for recognized capture failures. Blocked capture leaves that arm’s assertions ungraded. Replay verifies the recorded grading observations and remains blocked when an arm has no observation. Run the same reviewed pair again after resolving the capture issue to collect both grades.

The standard report retains available attempt counters and marks aggregate usage as unknown. Release qualification requires the full installed-host evidence. This case independently grades the delivered workspace using the canonical reuse and change-boundary assertions. The pinned standard Claude runner also supports `--case clarify-material-decision` and `--case resolve-format-decision`. The native `AskUserQuestion` callback withholds the project decision and the verifier records the confirmed question topic. The existing independent grader requires a focused question after the issue read and an unchanged fixture. Browser verification, profile application, delegated-worker cases, and clarification on the one-shot Codex and Hermes surfaces need additional observation channels. The runner rejects unsupported cases before model execution. [Claude authentication](https://code.claude.com/docs/en/authentication) · [Codex login](https://developers.openai.com/codex/auth) · [Hermes profile credentials](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/profiles.md#credential-sharing)

### Strict mode with isolated Claude Code

Run the built-in Claude Code 2.1.330 benchmark on Linux with Bubblewrap at `/usr/bin/bwrap` and working unprivileged namespaces. Use a clean reviewed checkout, the frozen lockfile, and freshly built grader and CLI outputs. If reusing a checkout across revisions, use `pnpm exec tsc --build tsconfig.build.json --force` before `pnpm build` to regenerate the JavaScript. Use an existing authorized Anthropic API key in the trusted operator environment as `ANTHROPIC_API_KEY`. The runner uses that key only for the official Anthropic endpoint. The native process receives a disposable profile and a placeholder key for the local broker.

```sh
node packages/cli/dist/index.js benchmark claude --allow-paid
```

The default runs one paired trial of `reuse-summary-formatter` on Claude Haiku 4.5 `claude-haiku-4-5-20251001`. The pair compares the same fixture with and without the native plugin. The runtime defaults to 120 seconds. The broker records available input, output and cache usage for reporting. Git baseline preparation has separate bounded subprocesses.

Use `--program /absolute/path/to/claude` for a binary outside `PATH`. Choose a reviewed commit via `--baseline FULL_SHA` or use the current commit. To run reuse and unavailable-preview together, add `--case reuse-summary-formatter --case report-unavailable-preview`. The second case checks whether the model accurately records that the isolated browser preview is unavailable. Adjust `--timeout-seconds` and `--repetitions` when authorizing the run. Use `--case clarify-material-decision` or `--case resolve-format-decision` to collect native clarification observations through the same broker. Only those reviewed cases include the native question tool. The runner rejects cases that require a missing observation channel, such as actual browser interaction or worker delivery, before it makes a provider call.

### Review the saved evidence

The CLI prints the private `evidenceDirectory` and the summary's `evidenceDigest`. Retain that digest separately. The directory defaults to a new subdirectory of `.axiom/runs`. Inspect `benchmark.json`, the saved grading observations, and the `acceptance/` evidence records. To replay the independent graders locally, use the clean source revision recorded in the summary and matching freshly built grader outputs. Supply the printed directory and digest.

```sh
node packages/cli/dist/index.js benchmark-review \
  --evidence /absolute/path/to/benchmark-directory --digest sha256:REPLACE_WITH_PRINTED_DIGEST
```

The review status covers evidence integrity and reproducibility. The replay includes the provider route, original benchmark disposition, and each replayed assertion. An `injected` provider route identifies fixture evidence. Keep this archive local unless you approve its workspace snapshots for sharing.
