# Product contract

A maintainer points the terminal agent at a repository and revision to answer one question. Can a newcomer follow the onboarding documentation and reach the first useful result it promises? Any repository can enter through the same workflow. The agent derives the instructions and check for each attempt. Intake requires no hand-written repository profile or maintainer-defined goal.

## From README to receipt

1. Resolve and record the exact revision. Start at its README and follow explicit links to getting-started instructions. Identify the documented prerequisites, the recommended newcomer path, and the earliest useful observable result on that path. Cite the excerpts supporting each choice. When several paths exist, use the one the docs recommend for the available environment. Record a material ambiguity if the docs give no basis for choosing.
2. Translate the promise into an observable check. If the guide tells the reader to open a local URL and see a welcome page, check the page at that URL. Show the derived path, environment, check and required access for approval before execution. Freeze the approved check. If the docs leave the expected result unclear, quote the limiting text and report what can actually be assessed.
3. Follow the documented steps in a clean, isolated environment. Preserve working directory and shell environment across steps. Keep observer knowledge separate from newcomer instructions. Restrict tools and access in the controller. Treat repository text and command output as untrusted input. Stop on material ambiguity, an undocumented prerequisite, or a request beyond approved access. Keep source inspection, CI knowledge, and guessed repairs out of the newcomer attempt.
4. Have the controller capture actual actions and evaluate the check. On success, return the receipt. After a supported failure, the agent may inspect source to explain the first blocker. Distinguish documentation gaps from application defects and offer a minimal docs-only diff when the evidence supports it.
5. Verify a proposed edit in a fresh agent session and VM with the same revision, check, runtime, dependency identities and access rules. Supply the revised documentation without the first transcript, cache or working state. Claim improvement only when the original failed and the independent replay passed under comparable conditions.

## Report contract

| Verdict | Required evidence |
|---|---|
| pass | The documented path reached the derived, approved outcome. |
| blocked | A cited instruction failed in a supported environment, the expected result was observably absent, or a specific documentation gap prevented the next step. Identify the likely cause and confidence separately. |
| unsupported | The documented path requires a capability outside the runner's supported environment or access rules. |
| inconclusive | Infrastructure failure, an unclear success condition, or incomplete evidence prevents a reliable judgment. A replay with changed artifacts also yields an inconclusive comparison. |

Lead with the verdict. Record revision, environment, check and its documentary basis, last successful action, first blocker, and steps left unrun. Include doc locations, actual commands and redacted output, relevant artifact identities, setup versus infrastructure time, and teardown status. Preserve the deterministic receipt if model summarization fails. Label proposed edits and replay-verified results separately.

## Scope

Terminal input and Markdown output. The runner supports repository-independent intake with bounded execution capabilities. The initial release excludes public hosted execution, automatic PRs, production credentials and write access to target repositories.
