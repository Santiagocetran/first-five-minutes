# Development roadmap

| Order | Deliverable | Done when |
|---|---|---|
| 1 | Evidence contract and offline fixtures | An already-correct guide, a mistyped filename and a simulated platform failure produce distinct receipts. A zero exit code without the approved outcome never passes. |
| 2 | Bounded eve + Sandbox experiment | With a separately approved account and budget, run one dependency-free reviewed step in a disposable VM. Capture its excerpt and actual output; verify the VM stops. Confirm eve cannot bypass the restricted tools. No second command to hide a failure. |
| 3 | Terminal vertical slice | Maintainer selects a profile, states the outcome and approves the concrete observer before execution. Terminal and Markdown report agree; deterministic evidence survives a model error. |
| 4 | DevNet profile and first baseline | Validate a Python 3.12 image, observer paths and a narrowly permitted artifact-download path. Keep credentials outside the VM. Record wheel and dependency identities. Stop after local init. A pass is a finished result; an infrastructure failure is not a docs finding. |
| 5 | Diagnosis and independent replay | On a known docs failure, produce a docs-only suggestion and replay it in a clean VM and session. Negative controls: changed wheel, unchanged broken README and carried-over state must not yield a verified fix. |
| 6 | Challenge demo | Show a real receipt, not a scripted verdict. Redact logs; label any synthetic fixture. Demonstrate the useful outcome and why startup alone was insufficient. Confirm the entry rules before submitting. |

**Before provisioning:** choose an approved nonproduction project, pin SDK/model/runtime, inspect available tools, cap time, model rounds and spend, check cleanup and egress rules. The offline spike's deny-all networking cannot be reused unchanged for the DevNet wheel install. If install traffic cannot be isolated and identified, leave that case unsupported rather than testing on the host.

**Next work session:** start at item 1. Write the pass, blocker and inconclusive receipts as acceptance examples before wiring in a provider. No live accounts are required for this step.
