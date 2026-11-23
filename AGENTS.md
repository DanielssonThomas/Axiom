# Contributor Instructions

## Establish the task

- Read `README.md`, `core/AXIOMS.md`, `docs/architecture.md`, and the assigned issue before changing files. Read relevant existing implementation and documentation next.
- Follow the user's requested scope. Planned architecture and issue descriptions do not imply that a feature already exists or authorize unrelated implementation.
- Resolve material uncertainty from repository sources first. Ask before consequential implementation when behavior, acceptance criteria, an interface, or scope remains unresolved.

## Coordinate parallel work

- The integration owner changes `blocked` to `ready` after prerequisite changes and their evidence have merged.
- Claim a `ready` issue with a comment identifying owned paths, branch/worktree, acceptance criteria, and validation; remove `ready` once claimed.
- The claim owner or integration owner must explicitly release a stale claim. Do not take over by elapsed time or broadly reassign other agents' ownership.
- Use an issue-specific branch/worktree against its merged prerequisite contracts; do not invent a competing contract.
- Keep edits within the issue's ownership boundary. Coordinate cross-lane changes with the responsible owner instead of silently expanding scope.
- One designated integration owner controls root manifests, lockfiles, shared contracts, central exports, and release assembly. Request those changes through that owner.
- Return the changed artifacts, tested revision, acceptance evidence, and remaining integration dependencies. Worker success does not replace verification of the combined result.

## Develop with meaningful TDD

- For new executable behavior or a reproducible bug, write an acceptance or regression test that fails for the intended missing behavior before implementing the change.
- Record the failing command and reason, make the smallest coherent implementation, then run the passing test and relevant regression checks.
- Test observable behavior and contracts, not implementation trivia. Reuse the repository's chosen test tools and fixtures.
- Changes with no executable behavior, such as prose corrections, do not require invented executable tests. Record the applicable review or structural checks instead.
- If a meaningful automated failing case cannot be produced, state why and identify the compensating verification. Do not claim TDD was performed.

## Preserve maintainability

- Apply the relevant AX principles through existing capabilities before adding new code, scripts, skills, or documents.
- Put maintained helpers in the owning module with defined inputs, outputs, lifecycle, and relevant tests. Avoid parallel one-off implementations of management operations.
- Keep temporary diagnostics explicitly temporary, outside maintained dependencies, and out of committed artifacts unless their inclusion is required by the task.
- Update canonical knowledge before adding another document. A new durable file needs a distinct purpose; incident logs and unverified explanations are not core instructions.
- Skills and profiles reference principle IDs. Native adapters reference or generate policy from its canonical source; do not maintain independent policy copies.

## Verify and report

- Use the repository's actual validation commands; do not present proposed commands as working capabilities.
- Bind evidence to the final relevant source state, including uncommitted changes. A later relevant edit requires affected checks to run again or their evidence to become stale.
- For runtime changes, verify the relevant flow in the running target application when required by the acceptance criteria. A build or screenshot alone does not prove interaction behavior.
- Record unavailable live verification explicitly. Required `failed`, `blocked`, or `not_run` checks prevent conforming completion; `not_applicable` needs a reason.
- Never weaken policy, tests, graders, required checks, or their baseline merely to obtain a pass. Legitimate changes to those controls require independent review from the implementation they assess.
- Summarize acceptance results, exact tested revision/state, relevant evidence, and remaining gaps. Distinguish implementation, automated validation, and live verification.

## Public artifacts

- Keep documentation generic and project-independent. Exclude personal history, private paths, credentials, and copied session transcripts.
- Follow `LICENSE` and preserve applicable notices. Native support and compatibility claims require executable evidence for the stated host, version, surface, and operating system.
