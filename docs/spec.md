# Product contract

**Audience:** a maintainer auditing onboarding for their own project. **Question:** Can someone who knows a terminal and has the declared runtime reach one useful outcome without knowing this codebase?

1. The maintainer selects a reviewed commit and describes the outcome in a sentence. Display the exact observable check for approval before the attempt. Freeze the check, environment and revision. The maintainer does not need to write a test.
2. The newcomer gets the quickstart and explicitly linked instructions, not CI, source inspection or prior diagnoses. Cite each setup action to a documentation excerpt. Stop on material ambiguity; no guessed migrations, flags or missing commands. Restrict tools rather than trusting the prompt alone.
3. A controller records what ran and determines whether the approved outcome happened. A successful command or a model's explanation cannot substitute for the outcome. On pass, return the receipt; do not manufacture a fix.
4. After a supported failure, eve may inspect source to diagnose it. Distinguish a docs gap from an application defect. Offer the smallest docs-only diff supported by the evidence. Mark it unverified until replay. Do not modify the app or upstream repository.
5. Replay in a fresh agent session and VM, using the same check, revision, runtime, dependency identities and access rules. Provide only the revised documentation; no transcript, cache or working state from attempt one. A changed artifact invalidates a causal claim. Report an improvement only when the original failed and the independent replay passed under comparable conditions.

## Report contract

Lead with `pass`, `blocked`, `unsupported`, or `inconclusive`. For `blocked`, say what stopped progress and separately label the likely cause and confidence. Never default to a documentation defect. Show revision, environment, approved check, last successful action, first blocker and steps not run. Include doc locations, observed output with secrets redacted, install artifact hashes, setup time versus infrastructure time, and teardown status. Distinguish observed facts, proposed edits and replay-verified results. Preserve the receipt even when model summarization fails.

## Scope

Terminal input and Markdown output; one reviewed target initially. No public arbitrary-URL runner, web UI, automatic PR, AgentCard, production credentials or write access to target repos. A second supported repository should add a reviewed profile/check, not require rewriting the runner.
