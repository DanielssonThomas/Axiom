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
| Delegated requirements | `passed` for one native Task worker receiving the staged brief and selected policy, including the Angular/Nx trial. Multiworker coverage is `not_run`. | `passed` in the scoped native localhost probe with linked worker IDs, exact observed first provider input, and an independently staged policy and brief. Missing brief evidence fails. On the pinned build, native subagent hooks identify lifecycle events and do not report the provider-bound task brief. Generic CLI delivery remains `blocked`. | `passed` for the installed scoped core observer correlating a native parent and child to the exact brief and completed first provider request. Missing or wrong brief evidence fails. An unrelated parent or rejected request blocks. Live provider, profile and full delegation qualification remain `blocked`. |
| Required hooks and negative controls | `passed` for startup and subagent hook observations. Disabled or missing activation and missing worker requirements block conformance. An intentionally damaged skill caused a native startup check to report `failed`. | `passed` for the disabled control and shared-check failure fixture. Native hook enforcement, resume, and compaction coverage are `blocked`. | `passed` for the ordinary pre-tool check. The missing-checker control reported `blocked`, the damaged-policy control reported `failed`, and reinstall invalidated prior observations. Resume and compaction coverage are `blocked`. |
| Native benchmark transport | `passed` with synthetic model ID `claude-sonnet-4-6`, 9 input and 3 output fixture tokens, and an archive-relative trace checked by the evidence store. | `passed` with synthetic model ID `gpt-5.4`, 10 input and 3 output fixture tokens, and an archive-relative trace checked by the evidence store. | `passed` with synthetic model ID `fixture-model`, 9 input and 2 output fixture tokens, and a normalized tool-event trace. Independent action-trace grading is `blocked` on this surface. |
| Independently graded model behavior | `not_run` for reuse, clarification, truthful verification, and applicable profile rules against an external model. | `not_run` for those behavioral cases. | `not_run` for those behavioral cases. |

Adapter results and validation details are recorded in [Claude Code PR #36](https://github.com/DanielssonThomas/Axiom/pull/36), [Codex PR #34](https://github.com/DanielssonThomas/Axiom/pull/34), and [Hermes PR #37](https://github.com/DanielssonThomas/Axiom/pull/37).

## Platform coverage

| Platform | Deterministic validation | Installed native CLI qualification |
| --- | --- | --- |
| Linux x86-64 | `passed` on the adapter convergence tree. | Loopback observations above. Final behavioral qualification remains incomplete. |
| macOS | `passed` on the hosted adapter convergence checks. | `not_run` for Claude Code, Codex, and Hermes. |
| Windows | `passed` on the hosted adapter convergence checks. | `not_run` for Claude Code, Codex, and Hermes. |

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

Both Codex and Hermes omit child usage from the tested parent terminal totals. Observed delegation makes Axiom's parent-only aggregate metering unavailable. Claude's isolated paid route uses independent broker totals. The broker and evidence replay passed against synthetic provider responses. External provider execution is `not_run`. The trusted route currently preflights out required cases whose observation channels are unavailable. [Benchmark commands and limits](install.md#run-a-local-behavioral-benchmark)

## Standard benchmark coverage

The pinned Linux CLIs completed subscription-shaped tests against synthetic providers. Claude used a restricted session-only plugin. Codex reused a synthetic file-store login through its native auth path and confirmed a restricted tool filesystem. Hermes used native default-profile auth discovery, standalone named gateways, and a fail-closed workspace hook. The paired Hermes test made native file edits and the shared reuse grader and offline replay passed. The root credential store and root configuration bytes stayed intact. The installed Hermes observer also detected the policy on the native Responses wire path with a synthetic provider.

Standard evidence reports aggregate usage as unknown and hard budget enforcement as unavailable. Paid and subscription-backed model behavior remain `not_run`. The one-shot Codex and Hermes surfaces do not provide an observed ask-and-wait channel for the clarification case. Actual profile behavior needs the corresponding independent profile checks and tool observations. [Standard benchmark commands](install.md#standard-mode-with-an-existing-native-login)

## Run the installed-host matrix

The integration suite assembles versioned native artifacts from the checkout. It checks ordinary sessions, update, disable, removal, configuration preservation, and a broken-install control for each available host. It reports the source, bundle and policy identities alongside the observed mechanism.

```sh
AXIOM_TEST_CLAUDE_BINARY=/absolute/path/to/claude \
AXIOM_TEST_CODEX_BINARY=/absolute/path/to/codex \
AXIOM_HERMES_CLI=/absolute/path/to/hermes \
pnpm test -- tests/integration/hosts
```

An unconfigured host reports blocked installation. The suite uses synthetic localhost providers and leaves external model behavior unrun. The isolated Claude benchmark probe runs two pairs through the independently metered provider broker. The independent graders fail the unchanged reuse artifact and the missing preview disposition in both arms, even when all four native processes complete. The preview check records the unavailable capability using the sandbox configuration and the tool surface observed at the broker. The offline replay reproduces the assertion outcomes.
