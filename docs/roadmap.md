# Development roadmap

| Order | Deliverable | Done when |
|---|---|---|
| 1 | Evidence contract and offline fixtures | A correct guide, a mistyped filename and a simulated platform failure produce distinct receipts. A zero exit code with a missing promised outcome never passes. |
| 2 | Documentation-driven intake | Given a repository and revision, the agent follows README links, cites the first useful promise, and proposes the steps, prerequisites and observable check. An ambiguous guide yields a cited uncertainty. The user supplies no goal or profile. |
| 3 | Bounded eve + Sandbox experiment | With a separately approved account and budget, execute one dependency-free reviewed step in a disposable VM. Capture its excerpt and actual output, verify restricted tool access, and confirm teardown. |
| 4 | Terminal workflow across repositories | Two substantially different repositories use the same intake, approval, execution and reporting flow without per-repo runner changes or hand-written profiles. Exercise different outcome types, such as local file creation and a served page. Terminal and Markdown verdicts agree, including when model summarization fails. |
| 5 | Diagnosis and independent replay | On a known docs failure, propose a docs-only edit and replay in a fresh VM and session. Changed artifacts, unchanged broken instructions and carried-over state cannot yield a verified fix. |
| 6 | Challenge demo | Show a real receipt and the useful outcome. Label synthetic fixtures, redact logs and confirm entry rules before submitting. |

DevNet is one candidate for the cross-repository exercise. Use its worked example to evaluate what the agent derives from the guide. Keep the example's expected answer out of the agent's inputs. A baseline pass is a finished result.

**Before provisioning:** choose an approved nonproduction project, pin SDK/model/runtime, inspect available tools, cap time, model rounds and spend, and verify cleanup and egress rules. The dependency-free experiment can deny all networking. A documented install requires an approved download path and recorded artifact identities. Report unsupported access requirements explicitly.

**Verification status:** the offline suite and synthetic Docker demonstration exercise the implementation. A separately funded model and Vercel Sandbox attempt remains an operator milestone. See the [running guide](running.md).

The [implementation plan](implementation.md) records the agent, model and environment decisions and the acceptance work for each stage.
