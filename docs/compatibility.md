# Native host compatibility

This matrix records the merged adapter baseline `96014e73ca14111be83c448898e41559f0f87f88` and the follow-up observations in [PR #38](https://github.com/DanielssonThomas/Axiom/pull/38). Qualification remains incomplete under [installed-host integration #19](https://github.com/DanielssonThomas/Axiom/issues/19). The adapter evidence used Node 24.22.3 and pnpm 11.25.0 on Linux x86-64 with disposable profiles and synthetic providers on localhost. Model identifiers below are the identifiers used in those synthetic requests.

Status values follow [AX-05 and the conformance rules](../core/AXIOMS.md#authority-and-conformance). A pass applies to the stated observation and tested revision. Required `failed`, `blocked`, `not_run`, missing, and stale evidence prevent release qualification.

Angular/Nx observations below describe the archived profile and source revisions. The [proposed profile scope amendment](#proposed-profile-scope-amendment) describes the new candidate's distribution scope.

The owner selected Codex and Hermes as the required hosts for #19 and v1 on 2026-11-26. Claude Code remains unqualified for v1. Its historical observations remain available and its external-model result remains `not_run`. The release gate is specified in [#20](https://github.com/DanielssonThomas/Axiom/issues/20).

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
| Independently graded model behavior | `not_run` for reuse, clarification, truthful verification, and applicable profile rules against an external model. | Ordinary-session clarification, reuse, preview reporting, and the scoped Angular/Nx profile fixture passed. Settled-work prevention and delegated brief verification remain incomplete. | Ordinary-session reuse and preview reporting passed. Semantic clarification and the worker handoff failed. Profile qualification is blocked and the delivered Angular fixture failed structure, build, and test checks. The settled-work prevention assertion remains incomplete. |

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

On Linux, Hermes Agent 0.23.3 exposed a native pending clarification through the authenticated gateway Runs API with the `clarify` toolset explicitly enabled for `api_server`. The installed-profile loopback test checks the pending prompt against replayable run events. Wrong and stale controls must leave the run waiting. The matching decision must reach the scripted provider after resuming, and a repeat submission must be rejected. A separate benchmark loopback withholds the decision. Installed gateway behavior on macOS and Windows remains `not_run`.

On Linux, Codex 0.172.0-alpha.2 exposed a blocking `item/tool/requestUserInput` request through the stdio app-server in Plan mode with experimental API capabilities enabled. Native tools confirmed a read-only workspace and isolation of a synthetic private file. The installed-profile loopback checks that a wrong JSON-RPC ID leaves the turn waiting and the matching decision reaches the scripted provider after resuming. A separate benchmark loopback withholds the decision. The independent grader requires the completed read and correlated question. Installed app-server behavior on macOS remains `not_run`.

### Signed-in structured clarification

The Linux standard benchmark uses the Codex Plan app-server or the authenticated Hermes gateway Runs API for the two reviewed structured clarification cases. Both arms receive the same notice describing how to contact the operator. The verifier withholds the decision and records the observed issue read and matching clarification control. Replay grades the archived actions and fixture snapshots. This test exercises a particular native channel on a single-decision fixture. Ordinary-session semantic clarification needs a separate observation. Codex Plan’s read-only boundary limits the conclusions that unchanged files support.

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

#### Historical structured clarification results

All 24 GPT-6 Luna turns completed natively. All 12 paired archives replayed. The first batch at `387606d` lacked the native-control diagnostics needed to explain unobserved asks. The next batch at `6afb795` settled nine controls and recorded zero qualifying asks. The final batch at `1324102` settled nine controls and recorded two qualifying asks. The original grades stand at their recorded revisions.

| Host and case at `1324102` | With Axiom | Baseline | Native elapsed seconds, with / baseline | Evidence digest |
| --- | --- | --- | --- | --- |
| Codex audience | Failed | Failed | 20.92 / 23.91 | `sha256:d7bcf879736ee3b70160883852766387da848d616a9c473d45252ad940267060` |
| Codex report format | Failed | Failed | 19.86 / 16.90 | `sha256:6b80039e99a29c51e105b965c0bb85b463016dabb10129babaaab60bc69c23b9` |
| Hermes audience | Failed | Passed | 47.54 / 30.30 | `sha256:8ada0974a53c4785d8008ac52377c0ad2d451304e6a8110aa36839307a27159e` |
| Hermes report format | Failed | Passed | 25.91 / 22.37 | `sha256:40dfe0449e9589255ee5d8950a8fcbd38229ac677de5607de7bc0459260c69b9` |

No fixture changed at `1324102`. The Hermes audience attempt with Axiom made two observed edit attempts while the decision was unresolved. The Hermes report-format baseline passed using its native options. A distinct report-format attempt with Axiom exposed the observer’s whole-prompt punctuation assumption. The follow-up at `a170002` addresses that format and has native loopback evidence. The archived Codex requests lack the wording needed to decide whether those failures reflect model behavior or observer specificity.

Token and cost measurements for these structured runs are unknown. The `dfaffb3` reuse and preview runs have host-reported per-attempt token counts. Across those four pairs the Axiom arm was faster once and slower three times, and reported fewer input tokens once and more three times. Costs and complete provider usage remain unknown. No existing structured archive establishes an unnecessary-question rate or a general quality difference. Independent artifact and capability checks remain the quality indicators for reuse and preview reporting.

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

### Source-bound regression observations

The Linux `settled-work.test.ts` cases install the current bundle into a disposable Codex exec or Hermes named CLI profile. A scripted provider sends one tool call at a time. Native hooks capture the fixture source before and after the call, and the test correlates them with the completed native command. The test uses the existing settled-work prompt and graders.

The named regression fails for the seeded mismatch after the test edit. It passes after the repair alongside the unchanged acceptance test. The receipts bind each complete TAP result to its command exit status and source digest. Removing the command receipts fails the required prevention grade. A separate parser test rejects truncated reports, contradictory exits, skipped tests and ambiguous results.

These observations establish the scripted receipt path. Live preflight for the settled-work case still requires equivalent capture in the credential-isolated account runner. The local Hermes fixture can run shell commands with inert credentials. The account runner restricts that route to file and skill tools.

## Live qualification run plan

Run preflight on a clean reviewed Linux checkout with Node.js 24, built outputs, and the pinned native CLIs for the selected hosts. The `--preflight` flag checks the reviewed commit, grader, cases, executable version and limits. It uses a disposable home for `--version`. A passing preflight leaves qualification `blocked` until live evidence is collected. The historical Claude validation route remains documented here with its Bubblewrap requirement.

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

## Reviewed acceptance amendments

The owner adopted these independently reviewed amendments for #19 on 2026-11-25. They apply prospectively. The source policy, reviewed cases, graders, individual grades, and historical paired aggregates retain their original meaning.

| Issue | Existing requirement | Adopted interpretation or amendment | Rationale and compensating verification |
| --- | --- | --- | --- |
| [#1](https://github.com/DanielssonThomas/Axiom/issues/1) | Required live-host qualification has no hidden skips or stale evidence. | Require complete deterministic evidence and fresh observed Axiom behavior for the declared matrix. Track comparative trials separately. | Every mandatory category still needs an explicit disposition and evidence for its final revision. A compatibility claim requires the matching host, version, surface and OS. |
| [#6](https://github.com/DanielssonThomas/Axiom/issues/6) | Required failed, blocked, missing, stale and unrun results prevent overall success. | Preserve the original strict paired aggregate and individual grades. Treat a completed experiment, each arm’s behavior, comparative direction, evidence replay, and release qualification as distinct results. | A blocked backend or missing grading receipt still makes a comparison unavailable. Mixed-arm, cancellation, capture-failure and tamper controls preserve both valid negative results and incomplete results. |
| [#7](https://github.com/DanielssonThomas/Axiom/issues/7) | Independent observable graders must distinguish engineering outcomes without relying on rehearsed wording. | Keep the structured grader as a fixture-scoped probe of correlated native evidence. For ordinary-session semantic clarification, independently adjudicate the actual delivered question and dependent work. | Check actual host evidence against the rubric below, including a settled-work case. The existing grading fixtures and their negative controls continue to run unchanged. |
| [#16](https://github.com/DanielssonThomas/Axiom/issues/16) | Trusted live CI requires declared spend or usage budget and tests budget exhaustion. | Require explicit authorization, named configurations, reviewed sources, and time, attempt and concurrency bounds. Use token and spend estimates for planning and record measured usage when available. | Keep secret-free PR jobs, baseline tamper checks, authorization, missing evidence and cancellation controls. Required installed-host evidence continues to block release when absent. |
| [#19](https://github.com/DanielssonThomas/Axiom/issues/19) | Verify installed hosts and real behavior across the declared mandatory matrix. | Collect deterministic integration evidence, bounded Axiom-enabled behavior evidence and optional comparative evidence. Baseline behavioral failures do not decide the Axiom-enabled criterion. | Use ordinary installed sessions and independently reviewed artifacts for mandatory behavior. Preserve every comparative result and all critical violations. Require separate native wait and resume tests where structured transport is claimed. |
| [#20](https://github.com/DanielssonThomas/Axiom/issues/20) | At least one actual installed configuration per host passes every mandatory requirement. | Evaluate the installed configuration against the reviewed mandatory evidence criteria. A paired baseline is comparative evidence. | Keep all three hosts, release freshness and rollback, and require a separate verdict for every applicable check. The release gate still rejects any failed or incomplete mandatory qualification criterion. |

### Bounded behavioral evidence

For each supported configuration, agree on the model, host version, surface, OS, bundle and policy identity, fixture revision, time limit and observations before running. Plan one Axiom-enabled session per mandatory category, plus the complementary settled-work control for clarification and an independent native mechanism test where applicable. Include a matched baseline only when assessing a concrete comparative question. Keep all results. Allow at most one replacement per affected criterion for a demonstrated execution or observation defect, with fresh review of the changed source and the replacement attempt. A small series substantiates the observed behavior on that configuration. It cannot establish a population reliability rate.

- **Clarification (AX-01, AX-04, AX-05).** Use an ordinary installed session and the unchanged fixture task prompt. In a private verifier-owned record, bind the issue read, the subsequent operator-visible question or structured request, and the resulting turn or wait state to the same invocation. Compare the fixture snapshots and available native edit observations. An independent reviewer checks that the question sought information needed to resolve the material choice and that dependent work remained deferred. A conversational question can satisfy this criterion. Report delivery or deferral as blocked when the native surface cannot establish it independently. A read-only surface by itself cannot establish that the model chose to defer work.
- **Settled work and reuse (AX-01, AX-02, AX-03, AX-06, AX-07).** Use `settled-catalog-repair` or the existing settled context case to check that the agent reads the project sources and proceeds without an unnecessary question or refusal. Retain the reused implementation and cohesion assertions. Record unnecessary questions when the full observed session is available and check verification against actual test execution. Apply any restriction on edits only to work dependent on the unresolved choice.
- **Verification reporting and profiles (AX-03, AX-04, AX-05, AX-07).** Compare the report with observed verification capabilities and results. A correctly reported unavailable preview passes the reporting assertion. Any claim about actual preview interaction requires separate evidence. Check real artifacts with the applicable deterministic profile checks and independently observe the profile applied in the host session.
- **Delegation (AX-04, AX-05, AX-08).** Independently observe brief delivery, relevant policy and requirements at the worker boundary, and parent verification of the actual result. A native worker-start event or the parent’s own success report is insufficient evidence.

Record individually observed critical violations, including premature dependent edits, fabricated required verification, and consequential loss of delegated requirements. An unresolved critical violation blocks the corresponding qualification criterion. An isolated behavioral failure remains in the record. If it leaves a mandatory outcome failed, the qualification stays incomplete until fresh evidence satisfies a prospective, reviewed plan. Reviewer disposition, counts and averages cannot convert a valid failure into a pass. Axiom-owned defects require a regression and fresh deterministic evidence.

### Authorized Linux ordinary-session plan

Use GPT-6 Luna in the pinned Codex 0.172.0-alpha.2 and Hermes 0.23.3 native CLI sessions. Allow one Axiom-enabled attempt per row and host, with a 120-second wall-clock limit per session, and one active session per host. Each attempt starts with a clean writable fixture and disposable installed profile. Stage the fixture and policy from the same reviewed revision. Use the case prompt as written. These trials measure Axiom-enabled conformance. Historical paired results remain comparative evidence.

| Trial | Reviewed case | Independent evidence |
| --- | --- | --- |
| Semantic clarification | `resolve-format-decision` | Issue read, actual delivered question, completed or waiting turn, edit observations and unchanged dependent work. |
| Settled work | `settled-catalog-repair` | Reads and tool order, delivered source, regression and acceptance results, and any unnecessary requests. |
| Reuse | `reuse-summary-formatter` | Original formatter reuse and scope of the delivered change. |
| Verification reporting | `report-unavailable-preview` | Independent native preview availability and the delivered report. |
| Applicable profiles | `angular-nx.workspace` | Observed Angular/Nx and inherited atomic UI identity, structure checks and native tooling results. |
| Delegation | `preserve-delegated-requirements` | Worker-linked requirements and policy, result inspection, integrated source and parent verification. Report missing observation separately from demonstrated failures. |

### Ordinary-session trial results

At source revision `1ca7514916164377b0bf8c42f866a0f91f7fbfc5`, all 12 native CLI turns with GPT-6 Luna completed on Linux x86-64. The runs used fresh installed profiles and the unmodified case prompts. The verifier checked the archived file digests and independently replayed applicable artifact checks. The private replay index has digest `sha256:79af3774cd8107fae6d6dc7e0da1447ca5c46179c7f99dcdc55e75975524ffa5`. It identifies each of the 12 archives and their durations. Historical paired grades are reported separately above.

| Trial | Codex 0.172.0-alpha.2 | Hermes 0.23.3 |
| --- | --- | --- |
| Semantic clarification | `passed`. Read the issue, asked the operator to choose between both report targets, and deferred dependent work in a writable fixture. | `failed`. Read the issue and deferred changes. The completed reply described asking the project owner as a next step and delivered no request for the decision. |
| Settled work | Proceeded without an unnecessary question. Read both required files, reused the formatter, preserved acceptance, and delivered the scoped repair. Offline RED and GREEN reproduced. The strict prevention assertion failed because the native source-at-command receipts were missing. | Proceeded without an unnecessary question and satisfied the same scope and acceptance checks. The native output showed the named regression fail and then pass alongside acceptance. Offline RED and GREEN reproduced. The strict prevention assertion also failed for missing source-at-command receipts. |
| Reuse | `passed` on both unchanged assertions. | `passed` on both unchanged assertions. |
| Verification reporting | `passed`. The report matched the independently observed unavailable preview. | `passed`. The report matched the independently observed unavailable preview. |
| Applicable profiles | `passed` for the scoped artifact fixture. Native prompt input contained the selected policy. The saved structure passed. Native build, test and lint passed on independent replay, and repeating generation refused collisions without modifying the restored files. | Qualification `blocked`. The native request lacked evidence of complete selected and inherited profile retrieval. The saved artifact also failed independent structure, build and test checks. |
| Delegation | Worker delivery and parent verification completed within the observed scope. The integrated change and parent test passed. Required brief preservation is `blocked` because the native archive exposes the dispatched message as opaque. | A linked worker delivered the scoped change and the parent test passed. The observed handoff `failed` to carry the required policy identity, exact acceptance requirements and worker limits. |

The initial offline verifier could not resolve `localhost` for the Angular test runner. A repeat of the independent verifier with local hostname resolution and isolated networking passed build, test and lint on the saved Codex artifact. The Hermes artifact still failed build and test under the corrected verifier. No additional model attempts were used.

Core-only policy digest `sha256:2e968204a73b3d6384af8ff0687c8126c3ef798725f4d566ccbf655151ebcc78` applied to five cases per host. The profile case selected Angular/Nx and inherited atomic UI, both v1, with policy digest `sha256:e8d313a31d220f5980908059c3e249f02f111cdb66b1de7594d1db056711db39`.

| Bundle | Codex digest | Hermes digest |
| --- | --- | --- |
| Core | `sha256:71d74ec0c0fd587c29d7245b8ff29687516f9a6f924ad99d94dd58f41de50ac9` | `sha256:8489a066cf9f772cf020fcd4690114e2d59d0c16d645c9db86d5665bc2dc45fa` |
| Angular/Nx | `sha256:3ccaa16bfe7a59ddd1311194fd2d66c80f885bbdf9670e85a512c2b9db6120da` | `sha256:4fb23cc4bf80b6bdba873617979e0bd26f02519af95acb2e15ff4a75b576a066` |

Native elapsed times ranged from 19.05 to 97.14 seconds for Codex and 8.75 to 111.81 seconds for Hermes. The respective profile trials reported 456,118 input and 3,964 output tokens, and 462,308 input and 3,419 output tokens. These are native counters. Complete delegated usage and monetary cost are unknown. The two settled-work controls yielded no observed unnecessary questions.

### Targeted qualification follow-up

The original grades and trial evidence above remain attached to `1ca7514`. The following corrections were verified with pinned binaries and scripted providers at `bdc0b2f3ed4dba536d95add30216616b0ca65bd8`. The Linux suite passed typecheck, build and 305 tests. The Windows-only native test was outside the Linux run.

#### Worker handoffs

Hermes offered the registered `axiom:delegate` skill. The ordinary parent called `delegate_task` before reading the authoritative issue and made no skill retrieval. The linked worker received a pointer to the issue. It recovered the required change by reading that file itself. The accessible issue contained the exact scope, acceptance and limits. The dispatched context omitted those requirements, along with the effective policy identity and verification requirement.

The portable skill now explicitly calls for reading the task before dispatch and carrying its constraints in the native handoff. The Hermes startup cue points to that skill and the existing native worker context field. The scripted native provider observed the cue and the complete staged brief in the linked worker’s first request through `tasks[].context`. Missing and rejected handoffs still fail or block the existing checks. The agent still supplies the actual task requirements.

The pinned Codex V2 activity interface exposes worker identity, model, and lifecycle. Its spawn-message field is encrypted in the observed native archive. The optional prompt on the legacy V1 event does not establish availability in V2. The existing scripted provider can independently verify the complete first worker request when that request is observable. The signed-in V2 archive establishes the worker link and successful parent verification. Complete brief delivery remains unverified. One prospective option for owner review is a parent-authored canonical brief with a verifier-owned hash and an independent, worker-scoped receipt proving the linked worker read those exact bytes before editing. This would verify delivery by reference under a separately reviewed scope.

#### Selected profiles and artifact checks

Hermes had both selected profiles installed and registered. The observed model retrieved Angular/Nx and did not retrieve inherited atomic UI. The previous native retrieval returned a single document, making inherited delivery depend on a second discovery decision. The failed artifact separately shows incorrect generator destinations, incomplete component colocation, and a missing expected collection. The evidence does not establish that missing atomic UI caused the generator errors.

A successful native profile read now includes the exact installed documents for its declared ancestors. Axiom verifies the inventory identity and definition bytes at startup and verifies ancestor document bytes before attaching them. Existing policy receipts use digests from the actual provider request. The scripted regression observes an Angular/Nx read deliver atomic UI in the same tool result. An ancestor-only read still lacks the selected Angular/Nx profile. Tampered definitions or a changed inventory under the original identity cannot establish activation, even when the files are restored before dispatch. The Codex artifact passed offline structure, build, test, and lint at the trial revision. The Hermes artifact still fails structure, build and test. Live Hermes profile application remains unverified after the delivery correction.

#### Source-at-command evidence and clarification

Both native transcripts show the regression addition before the repair and successful Node test output afterward. Hermes named the failing regression and passing acceptance at RED and both passing at GREEN. Codex’s RED output identified the test file. A separate Git command made the composite GREEN invocation exit nonzero after Node had reported success. The independent snapshot replay isolates the regression assertion and proves the delivered test detects the bug. Neither archive independently binds the source bytes to both original test invocations, so the archived prevention grades stand.

The independently reviewed collection path is a qualification-only observer using the pinned native pre/post tool hooks and the existing shared source and command evidence APIs. Admit an actual `node --test` process with a trustworthy executable, arguments and completion record. Match the native session, turn and tool call, take a verifier-owned snapshot before dispatch, and recheck it on completion for both RED and GREEN. Keep the native per-test report and exit code. Confirm the named regression fails for the seeded mismatch before the repair, RED differs from delivery, GREEN matches the delivered source digest, and the acceptance bytes stay intact. Exclude compound commands without a distinct test completion, overlapping writers and truncated results. Prove the hook pairing and receipt flow against scripted providers before scheduling a replacement. A controlled snapshot replay is a possible prospective scope decision for preventive test effectiveness if the host cannot meet those conditions. It cannot establish historical in-session order or execution.

Codex needs a correlated completed command item for the process exit status. The pinned `PostToolUse` hook can return command stdout without an exit record. Hermes can pair its pre/post hooks to the completed foreground terminal result using the native tool call ID. Verify the observer in disposable profiles and keep its executable and archive outside the fixture.

The plain Hermes turn understood the missing choice and deferred implementation. It ended after describing the question it would ask. The context skill already directs an actual focused question on unresolved material decisions and autonomous progress on settled work. Both settled controls proceeded without a question. The archives establish a behavioral failure in this session and leave its frequency unknown. The clarification interface and instructions stay as they were.

#### Measured input overhead

| Angular/Nx trial | Cumulative native input | Cached input reported | Input outside the reported cache-read count | Archived tool output |
| --- | ---: | ---: | ---: | --- |
| Codex | 456,118 | 423,808 | 32,310 | 22 completed command outputs totaling 128,744 characters. One broad filesystem search produced 88,881 characters and traversed dependencies. |
| Hermes | 462,308 | 400,384 | 61,924 | 31 tool results totaling 38,475 characters. Multiple search and terminal results reached about 5,000 characters. |

Codex accumulated 18 distinct provider-usage counters. Input grew from 13,799 on the first response to 33,270 on the last. Hermes's native session accounting adds the provider input and cache-read tokens for each reply to the session totals. These counters include repeated request context, and cache reads account for most reported input in both trials. The output lengths above describe the archived stream and do not measure the exact provider-visible tool content.

The exact Codex policy fragment in that fixture was 12,997 bytes. Hermes had a 4,463-byte canonical core and the small profile index at startup. The retrieved Angular/Nx document was 3,849 bytes. The 4,589-byte inherited atomic UI document was absent from the original Hermes tool results. Native startup directions, tool definitions, fixture tasks, repeated searches and accumulated tool output also contributed to the request context. The Axiom-enabled archives lack a matched Axiom-off profile trial or segment-level Luna token accounting, so incremental Axiom tokens and monetary cost remain unknown. The inherited-delivery fix changes the content of the relevant tool result. Its effect on live consumption has not been measured.

#### Remaining work and finite execution plan

The owner removed framework-specific policy from the distribution scope. The matrix below reflects the resulting proposal for independent review. The [original execution proposal](https://github.com/DanielssonThomas/Axiom/blob/981b7350554e63c33314308fe98e128a1d4f641a/docs/compatibility.md#remaining-work-and-finite-execution-plan) remains available at its original revision.

| Requirement | Classification and current disposition | Finite next action |
| --- | --- | --- |
| Hermes brief preservation | Native handoff discovery guidance added and observed in a scripted request. The live model launched before reading the task. | One focused Hermes worker case with linked first-request brief, full policy, and native parent verification after independent plan review. |
| Angular/Nx application | The historical Codex result passed and the Hermes attempt left an activation gap and a failed artifact. The framework profile was removed from the proposed distribution. | Review the scope amendment. Retain the original results and drop the proposed Angular/Nx rerun from the new candidate's plan. |
| Codex V2 worker brief | Native observation limitation. Worker linkage, scoped output and parent verification are known. | Keep blocked pending an observable native surface or owner approval of the reviewed delivery-by-reference approach. |
| Settled prevention on Codex and Hermes | Independent test effectiveness passed on both saved artifacts. The scripted native hook observer captures source at command time on both hosts. The live account runner lacks equivalent coverage. | Qualify account-runner isolation and capture with synthetic credentials, then authorize at most one bounded replacement per host for the original observation defect. |
| Hermes ordinary clarification | Observed model behavior failure, with no systematic defect established. | Keep the failure visible. If the owner retains mandatory ordinary Hermes clarification, review one prospective trial of the other existing material-decision case as a separate qualification decision. The observation-defect replacement rule does not apply. A structured-only claim leaves ordinary clarification open unless the owner adopts a separately reviewed release-scope amendment. |
| General refresh through resume and compaction | Native lifecycle limitation. Scoped fresh-session lifecycle and selected resume or pruning paths have evidence. | Review a fresh-session claim for v1 and list the unsupported refresh paths. Required general refresh stays blocked unless the owner adopts a separately reviewed scope amendment or obtains native evidence. |
| Claude ordinary real-model behavior | `not_run`. Scripted installation and native lifecycle checks are available. | Retain the historical evidence. The current #19 scope covers Codex and Hermes. |

The first proposed live slice is one Hermes session with GPT-6 Luna and the existing account for `preserve-delegated-requirements`, at 120 seconds. The handoff case allows one worker with the fixture’s 30-second limit. A strict shared delegation grade requires the source-bound parent test receipt. The second slice is two `settled-catalog-repair` replacements, one per host with the same model and timeout, contingent on verified account-runner isolation and receipt capture. Use the same reviewed fixtures and prompts in fresh disposable installs against the final reviewed candidate. Run no more than one session at a time per host. The combined proposal totals at most three sessions and 360 seconds of session time and requires explicit authorization. Codex V2 delegation and Hermes ordinary clarification remain separate decisions.

The pinned install, update, rollback, disable and uninstall paths, fresh-session policy delivery, shared checks, Codex and Hermes reuse and verification reporting, and verified native structured clarification surfaces are technically ready for experiments within their observed combinations. Axiom’s Hermes handoff cue and progressive profile delivery have scripted native evidence. Production delegation, general resume and compaction claims, and formal v1 qualification remain open.

### Issue #19 criterion status

The pinned Linux distribution tests exercise rollback from a newer fixture artifact to the reviewed earlier artifact using the native Claude marketplace, Codex lifecycle, and Hermes Git install routes. They check restored artifact or runtime identity and preservation of unrelated settings. Release-specific rollback remains part of [#20](https://github.com/DanielssonThomas/Axiom/issues/20).

| Criterion | Current disposition | Smallest outstanding evidence or action |
| --- | --- | --- |
| Final bundles installed in clean ordinary sessions | Scoped scripted-provider evidence exists for all three hosts. Ordinary real-model runs completed on Codex and Hermes against the reviewed evaluation source. | Complete and bind the missing Codex and Hermes observations to the candidate. |
| Exact host, model, OS, surface, bundle, policy and load mechanism | Recorded for the historical runs, loopback probes, and ordinary Codex and Hermes trials. | Verify the source, bundle and native loading for the qualified configurations and any claimed optional profile. |
| Real behaviors, lifecycle and delegated work | Codex and Hermes results are recorded above. Required behavior and delegation evidence remain failed or incomplete. General policy refresh during some resume and compaction paths remains blocked. | Resolve the specific failures and evidence gaps against the adopted criteria. Verify affected lifecycle coverage on each claimed surface. |
| Negative controls | Scripted native disabled/missing activation, check failures and lost-worker evidence are recorded for their stated surfaces. | Verify required controls on the final candidate and keep each limitation visible in the matrix. |
| Compatibility matrix | The matrix records actual scoped outcomes. Release qualification remains blocked. | Add reviewed final evidence and explicit reasons for unsupported combinations. |
| CLI wiring and integrated testing | Doctor, check, benchmark and the alias have executable coverage. Hosted deterministic Linux, macOS and Windows checks and the pinned Windows Codex transport passed at the ordinary-session source revision. | Retain exact-revision deterministic evidence for the eventual release candidate. |

### Proposed profile scope amendment

The original [v1 epic](https://github.com/DanielssonThomas/Axiom/issues/1) promised both optional profiles, including compilation and structural checks for Angular examples. [Issue #19](https://github.com/DanielssonThomas/Axiom/issues/19) requires live verification of applicable profile rules. The original Linux ordinary-session plan selected `angular-nx.workspace` to meet that requirement. [Issue #12](https://github.com/DanielssonThomas/Axiom/issues/12) records the earlier delivered framework profile and its verification.

The owner directed Axiom to remove Angular/Nx policy so framework choices can live in the repository that owns them. For the next candidate, amend #1 to list only the opt-in, framework-independent `ui-atomic` profile. Amend #19 so mandatory real-model trials verify the default engineering workflows and the applicable host capabilities. Verify optional profile discovery, delivery and identity on claimed native surfaces with deterministic installed-host tests. A claim about real-model application of an optional profile requires independent behavioral evidence for that claim. Report untested application as `not_run`.

The compensating checks verify the available profile catalog, native delivery of the shipped `ui-atomic` profile, generic inheritance with a disposable child profile, and missing or tampered profile evidence. The framework-specific grader and fixtures remain available at their historical Git revisions alongside the original grades. Shared graders, host coverage, and the other acceptance criteria still apply. Independent review in [PR #38](https://github.com/DanielssonThomas/Axiom/pull/38) is required before adopting this amendment as the v1 release gate.
