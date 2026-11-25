# Native host compatibility

This matrix records the merged adapter baseline `96014e73ca14111be83c448898e41559f0f87f88` and the follow-up observations in [PR #38](https://github.com/DanielssonThomas/Axiom/pull/38). Qualification remains incomplete under [installed-host integration #19](https://github.com/DanielssonThomas/Axiom/issues/19). The adapter evidence used Node 24.22.3 and pnpm 11.25.0 on Linux x86-64 with disposable profiles and synthetic providers on localhost. Model identifiers below are the identifiers used in those synthetic requests.

Status values follow [AX-05 and the conformance rules](../core/AXIOMS.md#authority-and-conformance). A pass applies to the stated observation and tested revision. Required `failed`, `blocked`, `not_run`, missing, and stale evidence prevent release qualification.

## Linux CLI observations

| Requirement | Claude Code 2.1.330, print CLI | Codex 0.172.0-alpha.2, exec CLI | Hermes Agent 0.23.3, named-profile CLI |
| --- | --- | --- | --- |
| Installation and preservation | `passed` for the disposable local marketplace lifecycle. Repeated install, update, disable, and removal preserved unrelated settings and project instructions. Native probes also observed versioned cache updates in project and user scopes. | `passed` for the disposable local Codex configuration. Repeated install, update while disabled, disable, and removal preserved other TOML settings and user and project instructions. | `passed` for the adapter-managed lifecycle and the pinned native Git lifecycle, with two-profile isolation. |
| Core policy loading | `passed` for native startup hooks delivering complete policy to the localhost Messages request. Native inventory and request-derived observations establish selection and loading. | `passed` for the owned profile instruction fragment and all six skills in the native prompt-input inspection. The installed backend ran one localhost Responses request. | `passed` for the selected named profile. Native plugin inventory, registered prompt sections, and the actual localhost chat request independently establish installation and loading. |
| Canonical skill discovery and use | `passed` for discovery of all six canonical names. Individual skill execution across the full catalog is `not_run`. | `passed` for discovery of all six canonical names. Individual skill execution across the full catalog is `not_run`. | `passed` for discovery and native `skill_view` returning the canonical content of all six skills. |
| Optional architecture profiles | `passed` for loading Angular/Nx with inherited atomic UI policy in the same native request. Model behavior under these profiles is `not_run`. | `passed` for Angular/Nx with inherited atomic UI reaching ordinary installed-session input. Model behavior is `not_run`. | `passed` for complete core, a profile index, and exact retrieval of Angular/Nx and atomic UI on the pinned chat-completions surface. A scripted native read and write corrected the seeded structure and an independent check passed. Real-model selection and application are `not_run`. |
| Delegated requirements | `passed` for one native Task worker receiving the staged brief and selected policy, including the Angular/Nx trial. Multiworker coverage is `not_run`. | `passed` in the scoped native localhost probe with linked worker IDs, exact observed first provider input, and an independently staged policy and brief. Missing brief evidence fails. On the pinned build, native subagent hooks identify lifecycle events and do not report the provider-bound task brief. Generic CLI delivery remains `blocked`. | `passed` for the scoped native loopback observer. The worker's completed first request contained the exact brief and core. A separate completed request from the same worker contained both exact native profile results for Angular/Nx and inherited atomic UI. Missing brief or profile evidence fails. First-request delivery of the full profile text remains `blocked`, and production delegation qualification remains `blocked`. |
| Required hooks and negative controls | `passed` for startup and subagent hook observations. Disabled or missing activation and missing worker requirements block conformance. An intentionally damaged skill caused a native startup check to report `failed`. | `passed` for the disabled control and shared-check failure fixture. Native hook enforcement, resume, and compaction coverage are `blocked`. | `passed` for the ordinary and resumed pre-tool checks, plus policy observation after committed deterministic tool-result pruning. The missing-checker control reported `blocked`, the damaged-policy control reported `failed`, and reinstall invalidated prior observations. General resume and compaction enforcement remain `blocked`. |
| Native benchmark transport | `passed` with synthetic model ID `claude-sonnet-4-6`, 9 input and 3 output fixture tokens, and an archive-relative trace checked by the evidence store. | `passed` with synthetic model ID `gpt-5.4`, 10 input and 3 output fixture tokens, and an archive-relative trace checked by the evidence store. | `passed` with synthetic model ID `fixture-model`, 9 input and 2 output fixture tokens, and a normalized tool-event trace. Independent action-trace grading is `blocked` on this surface. |
| Independently graded model behavior | `not_run` for reuse, clarification, truthful verification, and applicable profile rules against an external model. | Reuse and preview reporting passed in the [live trials](#archived-live-benchmark-results). Live clarification and applicable profile rules are `not_run`. | Reuse and preview reporting passed in the [live trials](#archived-live-benchmark-results). Live clarification and applicable profile rules are `not_run`. |

Adapter results and validation details are recorded in [Claude Code PR #36](https://github.com/DanielssonThomas/Axiom/pull/36), [Codex PR #34](https://github.com/DanielssonThomas/Axiom/pull/34), and [Hermes PR #37](https://github.com/DanielssonThomas/Axiom/pull/37).

## Platform coverage

| Platform | Deterministic validation | Installed native CLI qualification |
| --- | --- | --- |
| Linux x86-64 | `passed` on the adapter convergence tree. | Loopback observations above. Final behavioral qualification remains incomplete. |
| macOS | `passed` on the hosted adapter convergence checks. | `not_run` for Claude Code, Codex, and Hermes. |
| Windows | `passed` on the hosted adapter convergence checks. | Claude Code and Hermes `not_run`. The separate [Windows Codex workflow](../.github/workflows/windows-codex.yml) reports the pinned x64 native loopback disposition. The production Axiom installer remains `blocked` for Windows. |

The reviewed combined adapter tree passed 191 Linux tests with the pinned native agent and Angular/Nx fixtures enabled. Hosted checks passed on all three operating systems. Those jobs leave the native agent probes opt-in and establish deterministic platform coverage. IDE, desktop, and other host versions and surfaces are `not_run`. [Combined validation](https://github.com/DanielssonThomas/Axiom/pull/36) · [Hosted matrix](https://github.com/DanielssonThomas/Axiom/actions/runs/45236340604)

## Hermes native Git installation

On Linux x86-64, Hermes Agent 0.23.3 installed, enabled, updated, disabled, and removed the assembled artifacts through its native plugin CLI. The installed profile was `alpha` and the comparison profile was `beta`. The artifacts carried policy version `1` with no optional architecture profile and policy digest `sha256:2e968204a73b3d6384af8ff0687c8126c3ef798725f4d566ccbf655151ebcc78`. The Git commits identify the disposable artifact repository used by the probe.

| Stage | Fixture version | Git ref | Bundle digest |
| --- | --- | --- | --- |
| Install and enable | `0.1.0` | `1f98a0126ea794e0500fa828978129b121f5bdc1` | `sha256:1c8490c639d37160b46ac8946ba008839f5043103178afee32f8423c79d7b4cf` |
| Pinned update | `0.2.0` | `2b4a62978212cc00620cb84d3c939846c242bd0b` | `sha256:dc83d82dbb0cb4a48b59b33bb0752b7c942591016a974fbdab20b2d804dd0785` |

Native inventory and new localhost chat sessions confirmed each selected version. Both active sessions delivered the canonical policy alongside the profile's `SOUL.md` and the workspace's `AGENTS.md`. The initial session advertised all six skills. Native `skill_view` returned each canonical skill's content and recorded six passing pre-tool checks in the shared evidence store. The disabled session retained the ordinary instructions and omitted Axiom policy and skills. Activation reported `blocked` for that session.

The pinned update invalidated the earlier activation observation. After removal, inventory omitted the plugin and activation for the updated session reported `not_run`. Both profiles' `SOUL.md` and `AGENTS.md` bytes, the second profile's configuration bytes, and unrelated settings in the selected profile were preserved. [Lifecycle commands](install.md#hermes-agent)

## Reproduce the adapter observations

Build from the stated revision with the frozen pnpm lockfile. Point the opt-in variables at the pinned installed binaries. Each suite manages its own disposable profile and localhost provider.

```sh
pnpm install --frozen-lockfile
pnpm build
AXIOM_TEST_CLAUDE_BINARY=/absolute/path/to/claude pnpm test -- tests/adapters/claude
AXIOM_TEST_CODEX_BINARY=/absolute/path/to/codex pnpm test -- tests/adapters/codex
AXIOM_HERMES_CLI=/absolute/path/to/hermes pnpm test -- tests/adapters/hermes
```

The Hermes CLI was built from upstream commit `caafe5389ae585ef77387a962aee05b1bcf17029` with its frozen uv lock and Python 3.14.10. See [installation](install.md) for profile selection and lifecycle commands.

For the Linux Hermes gateway Runs API probe, run `uv sync --frozen --extra messaging --python 3.14.10` in that upstream checkout. The `messaging` extra installs `aiohttp`, which the Runs API requires. Point `AXIOM_HERMES_CLI` at the resulting `.venv/bin/hermes`.

The scoped Hermes worker probe uses the installed named profile and native `delegate_task` and `skill_view` tools. The first child request carries the canonical core, selected profile index, and independently staged brief. The profile observation requires the exact selected and inherited documents together in a subsequent completed provider request from that same child and installation. A rejected first request leaves the initial receipt unavailable. A rejection after both profile results reach the provider cannot promote the earlier partial receipt. The provider is scripted and local. Real-model profile selection, application, and production worker behavior remain `not_run`.

On Linux, Hermes 0.23.3 resumed the same named-profile CLI session after restarting its gateway. The native requests carried persisted history and the installed Axiom core. The resumed file read produced a fresh shared pre-tool record. With proactive tool-result pruning enabled in the disposable profile, Hermes emitted a `post_compaction` event for that session, archived the original result, and sent the shortened result alongside the complete Axiom core. This covers the deterministic prune path. Summarization, rotating continuations, and general transition enforcement remain `blocked`.

After Axiom was disabled, resuming the existing session still sent the cached policy in the system prompt. The disabled resume produced no new Axiom observation or pre-tool check. A targeted Hermes `sessions refresh-prompts --session <id>` removed that cached policy on the next turn while keeping the session and history. A fresh disabled session also omitted the policy. The probe used a scripted localhost provider.

Both Codex and Hermes omit child usage from the tested parent terminal totals. Observed delegation makes Axiom's parent-only aggregate metering unavailable. Claude's isolated paid route uses independent broker totals. The broker and evidence replay passed against synthetic provider responses. External provider execution is `not_run`. The trusted route currently preflights out required cases whose observation channels are unavailable. [Benchmark commands and limits](install.md#run-a-local-behavioral-benchmark)

## Standard benchmark coverage

The pinned Linux CLIs completed subscription-shaped tests against synthetic providers. Claude used a restricted session-only plugin. Codex reused a synthetic file-store login through its native auth path and confirmed a restricted tool filesystem. Hermes used native default-profile auth discovery, standalone named gateways, and a fail-closed workspace hook. The paired Hermes test made native file edits and the shared reuse grader and offline replay passed. The root credential store and root configuration bytes stayed intact. The installed Hermes observer also detected the policy on the native Responses wire path with a synthetic provider.

Standard evidence reports aggregate usage as unknown. External-model behavior is recorded in the [archived live trials](#archived-live-benchmark-results). The standard Claude runner uses restricted streaming and the native stdio permission callback for the two reviewed clarification cases. Native loopback exercises the matching tool use, permission request and rejected tool result after the verifier withholds a decision. The independent grader passes the unchanged fixture and fails the premature edit. Replay reproduces both outcomes. The Codex and Hermes one-shot surfaces lack an observed ask-and-wait channel. The isolated Linux Claude runner uses the same callback for those two cases inside its installed-profile sandbox. Its injected localhost test checks provider usage reporting, successful clarification replay, and the unchanged preview capability check. Actual profile behavior still needs independent profile checks and tool observations. [Standard benchmark commands](install.md#standard-mode-with-an-existing-native-login) · [Claude host callback](https://code.claude.com/docs/en/agent-sdk/user-input)

## Archived live benchmark results

The Linux CLI trials used GPT-6 Luna and no optional profile. Each listed trial passed with and without Axiom, and offline replay reproduced both grades. The integrated trial used revision `dfaffb3ea5cd4b0aa62282ff914a81c0650b1e70`. Both hosts reported the unavailable preview as a single JSON object with status `blocked` and the independently observed reason.

| Host | Case | Evidence digest |
| --- | --- | --- |
| Codex 0.172.0-alpha.2 | `reuse-summary-formatter` | `sha256:89bfd0b754e33aac12d6e0de695fdaebd28caaf52369f04f4a244d019603e1a2` |
| Codex 0.172.0-alpha.2 | `report-unavailable-preview` | `sha256:113e0a8918467556496b08e53bfa8355947bf1dd147fe32e3efedcc7bb075c6d` |
| Hermes 0.23.3 | `reuse-summary-formatter` | `sha256:16497de74f8cce79faa1d44b752b8885f657a2fb68f6f0783ea37d186962aedd` |
| Hermes 0.23.3 | `report-unavailable-preview` | `sha256:812d1803aed13889555b0a4b8cf9a25b557ce59fbfca9d5a1c349ef1197971d2` |

The earlier passing archives remain tied to their tested revisions.

| Host | Case | Tested revision | Replay |
| --- | --- | --- | --- |
| Codex 0.172.0-alpha.2 | `reuse-summary-formatter` | `15d9ee1` | `passed` |
| Hermes 0.23.3 | `reuse-summary-formatter` | `a6a780b` | `passed` |
| Codex 0.172.0-alpha.2 | `report-unavailable-preview` | `45d91a1` | `passed` |
| Hermes 0.23.3 | `report-unavailable-preview` | `1a9db25` | `passed` |

## Interactive clarification transport

On Linux, Hermes Agent 0.23.3 exposed a native pending clarification through the authenticated gateway Runs API with the `clarify` toolset explicitly enabled for `api_server`. A disposable Axiom profile and scripted localhost provider exercised the reviewed target-audience fixture. The pending prompt and execution generation matched the replayable run events. Wrong and stale controls left the run waiting, the matching skip resumed it, and a repeat submission was rejected. The fixture stayed unchanged, and the independent grader required the correlated question. External-model clarification and installed gateway behavior on macOS and Windows remain `not_run`.

On Linux, Codex 0.172.0-alpha.2 exposed a blocking `item/tool/requestUserInput` request through the stdio app-server in Plan mode with experimental API capabilities enabled. A disposable Axiom profile and a scripted localhost provider exercised the reviewed report-format fixture. Native tools confirmed that the workspace was read-only and that they could not read a synthetic private file in the profile. A response with a wrong JSON-RPC ID left the turn waiting. The matching response carried no answers and resumed the turn without changing the fixture. The independent grader passed the completed issue read and correlated question and failed the observation with the question removed. External-model clarification and installed app-server behavior on macOS remain `not_run`.

### Signed-in clarification

The Linux standard benchmark uses the Codex Plan app-server or the authenticated Hermes gateway Runs API for the two reviewed clarification cases. Run these cases separately from CLI reuse and preview reporting. The verifier withholds the project decision and records the independently observed issue read and the matching native clarification control. Replay runs the existing grader on the archived actions and fixture snapshots.

```sh
BASELINE=$(git rev-parse HEAD)
for host in codex hermes; do
  for case in clarify-material-decision resolve-format-decision; do
    node packages/cli/dist/index.js benchmark "$host" --mode standard --preflight \
      --baseline "$BASELINE" --model gpt-6-luna --case "$case" \
      --repetitions 1 --max-attempts 2 --timeout-seconds 120
  done
done
```

Use the existing account roots and select the pinned executables with `--auth-home` and `--program` where needed. Authorize four case pairs with two attempts per pair, eight attempts total, and 120 seconds per pair. After approval, replace `--preflight` with `--allow-native` and replay each private archive. [Benchmark replay](install.md#review-the-saved-evidence)

The same pinned Linux app-server resumed a persisted thread after the Axiom bundle was updated. The actual provider input carried the previous conversation and the updated installed policy. A native `thread/compact/start` completed in the same thread, and the next turn carried the updated policy. After disabling Axiom and restarting the app-server, the previously active thread still sent that policy to the provider. A fresh thread in the disabled profile omitted it. This retained context blocks general resume and compaction enforcement. The fixture used a scripted localhost provider.

The hosted Windows job runs that same Plan-mode probe and a separate native `exec` lifecycle fixture with the pinned Windows executable. It stages assembled Axiom artifacts through Codex's local marketplace in a disposable profile. Only a run that observes the installed and updated policy, the corresponding missing-activation and disabled controls, removal, and blocking Plan-mode clarification emits both Windows receipts. The fixtures use a scripted localhost provider. The production Axiom installer, model behavior, and production worker evidence stay outside this check.

## Run the installed-host matrix

The integration suite assembles versioned native artifacts from the checkout. It checks ordinary sessions, update, disable, removal, configuration preservation, and a broken-install control for each available host. It reports the source, bundle and policy identities alongside the observed mechanism.

```sh
AXIOM_TEST_CLAUDE_BINARY=/absolute/path/to/claude \
AXIOM_TEST_CODEX_BINARY=/absolute/path/to/codex \
AXIOM_HERMES_CLI=/absolute/path/to/hermes \
pnpm test -- tests/integration/hosts
```

An unconfigured host reports blocked installation. The suite uses synthetic localhost providers and leaves external model behavior unrun. The isolated Claude benchmark probe runs two pairs through the independently metered provider broker. The independent graders fail the unchanged reuse artifact and the missing preview disposition in both arms, even when all four native processes complete. The preview check records the unavailable capability using the sandbox configuration and the tool surface observed at the broker. The offline replay reproduces the assertion outcomes.

## Live qualification run plan

Run preflight on a clean reviewed Linux checkout with Node.js 24, built outputs, and the three pinned native CLIs on `PATH`. The `--preflight` flag checks the reviewed commit, grader, cases, executable version, limits, and Bubblewrap for Claude. It uses a disposable home for `--version`. A passing preflight leaves qualification `blocked` until live evidence is collected.

```sh
BASELINE=$(git rev-parse HEAD)
node packages/cli/dist/index.js benchmark claude --preflight --baseline "$BASELINE" \
  --model claude-haiku-4-5-20251001 \
  --timeout-seconds 600 --repetitions 1 --case reuse-summary-formatter \
  --case report-unavailable-preview --case clarify-material-decision --case resolve-format-decision
node packages/cli/dist/index.js benchmark codex --mode standard --preflight --baseline "$BASELINE" \
  --model gpt-6-luna --case reuse-summary-formatter --repetitions 1 --max-attempts 2 --timeout-seconds 120
node packages/cli/dist/index.js benchmark hermes --mode standard --preflight --baseline "$BASELINE" \
  --model gpt-6-luna --case reuse-summary-formatter --repetitions 1 --max-attempts 2 --timeout-seconds 120
```

Use `--program` to select a pinned executable outside `PATH`. For Codex and Hermes, select an exact model available to the authorized account. After approval, use the same reviewed revision and limits and replace `--preflight` with the authorization flag for that route. Store credentials through the provider or host login flow. [Native authentication and evidence replay](install.md#run-a-local-behavioral-benchmark)

| Host and route | Credentials | Approval for the initial run |
| --- | --- | --- |
| Claude Code 2.1.330, strict | An Anthropic API key with paid API access to `claude-haiku-4-5-20251001` in the trusted Linux operator environment as `ANTHROPIC_API_KEY`. The owner-only hosted workflow on `main` reads `AXIOM_ANTHROPIC_API_KEY` from Actions secrets. | `--allow-paid` for one pair per case, eight native attempts total, and 600 seconds. |
| Codex 0.172.0-alpha.2, standard | A dedicated Codex Linux home with a ChatGPT file-store login that can use the approved model. Select it with `--auth-home`. | `--allow-native` for one pair, two attempts, and 120 seconds using the signed-in account's quota. |
| Hermes 0.23.3, standard | An OpenAI Codex OAuth login in the `default` profile of a dedicated Hermes Linux auth root, with access to the approved model. Select that root with `--auth-home`. | `--allow-native` for one pair, two attempts, and 120 seconds using the signed-in account's quota. |

Authorize the provider or native-account usage for the requested attempts and duration. Use measured usage where available for cost planning. The standard Codex and Hermes routes report aggregate usage as unknown. Review the local, private evidence after each run. [Benchmark replay](install.md#review-the-saved-evidence)

The pinned Linux Codex sandbox uses a protected `.git` mount. An interrupted sandbox can leave its empty mount directory on disk. The native-account adapter creates the mount directory before launch and removes it only when its identity still matches and it is empty. The verifier continues to reject Git metadata in delivered fixtures. Hermes gateway control requires private Linux permissions. On WSL, sign into Hermes using an auth root on the Linux filesystem so the disposable gateway can use these permissions.

The Hermes account benchmark supports the native file toolset's `patch` in both arms. The benchmark hook confines single-file replacements to the fixture. V4A patches use the pinned Hermes path checks with `HERMES_WRITE_SAFE_ROOT` set to that same fixture. The native regression exercises both patch forms and confirms that an outside patch target stays unchanged.

### Next live case for Codex and Hermes

Use the reviewed `report-unavailable-preview` case for one with/without-Axiom pair per host. Codex verifies the empty native MCP inventory and a separate sandbox network namespace. Hermes verifies that only file and skill toolsets are enabled and that browser automation is disabled in its native inventory. The archive ties each observation to the host and attempt. The existing grader compares `verification.json` with the saved observation and detects a false `passed` report. The case checks how an unavailable preview is reported. Actual browser interaction remains outside its scope.

```sh
BASELINE=$(git rev-parse HEAD)
node packages/cli/dist/index.js benchmark codex --mode standard --preflight --baseline "$BASELINE" \
  --model gpt-6-luna --case report-unavailable-preview --repetitions 1 --max-attempts 2 --timeout-seconds 120
node packages/cli/dist/index.js benchmark hermes --mode standard --preflight --baseline "$BASELINE" \
  --model gpt-6-luna --case report-unavailable-preview --repetitions 1 --max-attempts 2 --timeout-seconds 120
```

Use `--program` for the pinned executables and `--auth-home` for the existing Codex and private Linux Hermes logins if they are outside the default locations. The preview pair needs authorization for two GPT-6 Luna attempts and 120 seconds per host using the signed-in account's quota. After approval, replace `--preflight` with `--allow-native` and replay each private evidence archive. The standard routes have time and attempt limits. Aggregate provider usage is unknown. [Benchmark replay](install.md#review-the-saved-evidence)

Claude still needs independently observed profile application, delegated-worker delivery and parent verification, and remaining ordinary-session lifecycle evidence. Codex and Hermes still need independently graded live evidence for interactive clarification, profile application, delegated execution, and remaining lifecycle behavior. The native clarification, profile, and worker probes above establish scoped transport evidence with scripted providers. Full qualification depends on the real-model and installed-session evidence in [#19](https://github.com/DanielssonThomas/Axiom/issues/19).
