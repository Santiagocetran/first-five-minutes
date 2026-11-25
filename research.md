# First Five Minutes: can a newcomer follow this README?

**Research decision · November 25, 2026.** Proceed to a separately approved, one-fixture feasibility test, not to a public repository scanner. The useful result is a maintainer-facing receipt: *at this revision, in this environment, this documented step produced this result*. A model can explain the first blocker; it must not invent the verdict, quietly repair the instructions, or try a second command. The organizer’s requirements and the SDK primitives are documented. No end-to-end result, five-minute latency, account entitlement or actual charge has been verified.

## Challenge fit and submission decision

The [eve Builder Challenge page and expanded FAQs][1] were read directly in a browser. The organizer accepts agents, extensions, integrations and apps built with eve. Publication requires a public code repository and a public X post: follow and tag `@eve`, name the Builder Challenge, describe the project and link the repository. The page’s draft helper has a 100-character description field; opening a draft is not publishing. A watchable YouTube demo is optional but prioritized. The page names **December 11, 2026** as the deadline and says to submit *before* December 11; no hour or time zone was displayed. If entering, plan to post by December 10 with margin. Ten winners receive $100 each in Vercel AI Gateway credits plus swag, with follow-up on X. These are prizes, not an execution budget. A hosted deployment is not listed as an entry requirement. Age, geography and other eligibility details were not established; do not infer them from an accessible page. Confirm with the organizer before committing to entry if they matter.

**Why this idea belongs:** usefulness is finding the exact point where a newcomer gets stuck; technical complexity is linking a README line to a controlled execution and verifiable evidence; creativity is replaying a first-time experience rather than offering another static README score. A short demo could show the README, one failing receipt, and a suggested one-line edit clearly marked *untested*. A polished chat UI contributes less to those judging criteria than a credible receipt. No entry, recording, or public post is authorized here. [1]

## Proposed product and architecture

**User and scope:** one maintainer with authority over one sample selects its pre-reviewed revision. The product asks whether one maintainer-defined user outcome can be reached by following the docs from a clean, specified Linux environment. Five minutes describes the experience, not a product pass/fail threshold. The smaller five-minute limit below applies only to the proposed infrastructure experiment. Start the clock at user confirmation, not after VM startup. Record setup, command and reporting time separately. This is not a claim about macOS, Windows, a novice’s comprehension, or the rest of the README.

| Stage | Design decision | What it buys / what it cannot prove |
|---|---|---|
| Intake | Bundle only a maintainer-owned, dependency-free sample and README, plus a separately reviewed manifest of file hashes, step IDs, expected output and allowed argument vectors. No URL field, branch name, private checkout or credentials. | The runner knows exactly what was approved. It cannot generalize to arbitrary repositories. |
| eve turn | Start in eve’s local terminal UI. A typed tool under `agent/tools/` accepts only an enumerated fixture/step ID; the agent identifies the relevant README excerpt, requests the mapped check and explains the returned evidence. Inspect the effective tool list before any real turn: no general shell, filesystem editing, web, self-modification or alternate tool route. [2][3] | eve performs a real task, but the model cannot choose an executable, rewrite a file or decide what counts as passing. If those capabilities cannot be restricted, stop. |
| Execution | Tool code runs in the **app runtime**, not inside a VM. Have it allocate one Vercel Sandbox via `@vercel/sandbox`, set explicit region, image, timeout, `persistent: false`, `networkPolicy: 'deny-all'` and no ports or mounts. Copy only approved bytes through SDK file operations; invoke a fixed executable and argument array with a fixed working directory. Never execute README text in the app process. [3][5] | Separates the credential-bearing controller from the sample. The SDK’s defaults otherwise permit egress and persist state. No network installs, preview URL, shell interpolation or repository writes. |
| Evidence and teardown | The controller owns an immutable run ID and one-create allowance. Compute verdict from exit status **and** expected milestone. Bound, redact and label excerpts before handing them to eve. Stop in a `finally` path, confirm terminal session state, record any cleanup error. [5] | A timeout, auth failure or failed cleanup remains visible; no automatic retry or substituted local result. |
| Presentation | Return Markdown in the local terminal. If later needed, the first-party client supports sessions, sending a turn and collecting the result; a web interface is optional. [4] | No deployment, GitHub app, webhook, database, Slack integration or public channel needed to test the idea. |

**Why not use the default eve sandbox?** eve has a native sandbox declaration and tools can get the session handle with `ctx.getSandbox()`. That path is attractive for ongoing workspace conversations. Its default provider can resolve to Vercel, Docker or just-bash, however, and session resumption deliberately reuses state. A local green run therefore would not establish clean Vercel execution. Prefer the explicit one-off SDK lifecycle for this narrow check. Do not also provision an eve session VM; verify the pinned eve configuration permits that before spending. If using eve’s native provider instead, select Vercel explicitly and re-prove freshness, cleanup and the effective tool list. [3][5][6]

## Evidence contract: what a maintainer gets

Keep the README excerpt with path, line range and content digest; fixture revision and approved file hashes; runtime image/version, region, SDK versions and working directory; actual executable/argv; expected milestone; elapsed times, exit code or timeout; bounded separate stdout/stderr; redaction/truncation flags; and teardown status. Link every finding to a step and run ID. Exclude environment dumps, raw credentials and account identifiers from shareable reports. Preserve the deterministic receipt even if the model’s explanation fails.

**Verdicts:** `pass` only if the documented command reaches its expected milestone within budget; `readme-blocker` only if the documented path was faithfully exercised in a supported environment and evidence identifies the mismatch; `unsupported` for interactive setup, dependencies or commands outside policy; `inconclusive` for platform errors, wrong runtime, truncation hiding the milestone, or insufficient evidence. A five-minute timeout is a measured miss, not automatically a documentation bug. Report the first blocker and leave downstream steps *not run*. A suggested correction is an inference unless separately exercised in a fresh authorized run.

## Cost and operating constraints

Vercel’s [Sandbox pricing table][7] uses `iad1` for its default rate illustration. Hobby includes 5 active CPU-hours, 420 GB-hours of provisioned memory and 5,000 creations per month, with 10 concurrent sandboxes and 45 minutes per session. Exhausting included usage can pause creation; check remaining quota and plan eligibility rather than promising a free run. Pro lists $0.128 per active CPU-hour, $0.0212 per GB-hour and $0.60 per million creations in this example. CPU is active time summed across vCPUs; memory accrues while idle, with a one-minute minimum. Each vCPU includes 2 GB of memory. Rates and limits vary by plan and region. [7]

**Worked example, not a quote:** one creation, 1 vCPU, 2 GB, `iad1`, five minutes at full CPU: `(0.128 + 2 × 0.0212) × 5/60 + 0.60/1,000,000 ≈ $0.0142` in metered Sandbox compute and creation charges before credits. Excludes model tokens, any hosting, transfers, drives, snapshots and taxes. Confirm the requested size is available; do not silently accept the 2-vCPU default. Model cost is separate: price input and output tokens at the selected model’s [AI Gateway rates][8], bound both token counts and model rounds, then compare actual usage to the estimate. No chosen model, token count, account balance or all-in price was observed.

## Risk register and evidence status

| Risk | Control / smallest evidence that settles it |
|---|---|
| README prompt injection, dependency scripts, malicious or changing sample | Treat prose and stdout as data, not authority. Match fixture hash and step ID against an owner-reviewed manifest. Refuse unknown steps; no installers, arbitrary URLs, shell strings, or model-authored repair commands. A microVM is not permission to run unrelated code. |
| Secret exposure or wrong billing project | Use the operator’s project-bound short-lived OIDC on the controller only. Verify intended team/project before creation. Local OIDC is documented as expiring after 12 hours; avoid pulling production environment files or placing `.env.local` in the sample. A team access token is an alternative, not a prerequisite. [9] |
| Durable retries, duplicates, persistence and surprise spend | Enforce one run ID, one create, one command; no retry on ambiguous create. Disable persistence explicitly, keep a provider timeout, verify teardown. If resource state is unknown, reconcile it before another run. [5][6][7] |
| False blame, fabricated success or leaked logs | Compare actual argv, image, runtime and expected marker to the manifest; do not accept exit zero alone. Redact before persistence or model ingestion. Have a human compare the explanation to the saved receipt, including the distinction between observed failure and proposed fix. |

**What was actually checked:** anonymous, read-only browser access to the organizer page and its expanded FAQs; public reads of the eve and Vercel documentation below. No repository was supplied or inspected as an approved executable fixture. No authenticated SDK endpoint was probed, no account or token was accessed, and no sample, model, sandbox, build or deployment was run. **Documented, not observed in execution:** eve local turns and typed tools, session sandbox provider differences, Vercel create/file/command/stop primitives, OIDC and billing. **Unverified:** exact pinned package compatibility, effective tool exposure, operator rights/quota, clean-room runtime, end-to-end time, teardown and billing. A docs example or anonymous HTTP response cannot settle those questions.

## Smallest authorized spike — proposal only

**Authorization gate:** obtain explicit approval for one named nonproduction team/project, `iad1`, one owned fixture revision and file manifest, the exact Node image and invocation, one remote VM for at most five minutes, one bounded eve turn and a total spend ceiling (suggest $0.25 after checking model rates). Require an operator authorized for both the sample and the account. If effective limits, credential isolation or model budget cannot be established, remain at desk research. Permission to research is not permission to provision or publish.

1. **Choose a discriminating fixture.** Proposed example, not existing evidence: the approved files contain `hello.mjs`; the README’s first command names `helo.mjs`. Record its actual README line and hashes when provided. Pre-register the expected blocker: the documented filename is absent. The proposed correction names `hello.mjs`; do not execute it in this run. No dependencies, build scripts, services or installs inside the VM.
2. **Exercise exactly one path.** Start the timer, open one local eve turn, invoke the allowlisted check once, stage approved bytes in one fresh restricted Vercel VM, and attempt only the documented Node invocation. Capture the result through the SDK. Any additional tool, extra creation, unapproved path, request for credentials, or budget breach aborts the test. The five-minute deadline covers the whole interaction; give the VM only the remaining execution budget and reserve time for cleanup.
3. **Decide from receipts.** Go to a second, separately approved positive control only if the report cites the right README line, records the actual missing-file result, identifies the first blocker without claiming the correction worked, returns within five minutes, and proves the VM stopped. Compare account usage when posted; mark it pending until then. If the tool cannot obtain an authorized VM or eve exposes a broader execution route, classify as inconclusive/no-go, not a broken README. No deployment or submission is needed to learn this.

## First-party sources

[1]: https://eve.dev/challenge
[2]: https://eve.dev/docs/getting-started
[3]: https://eve.dev/docs/tools
[4]: https://eve.dev/docs/guides/client
[5]: https://vercel.com/docs/sandbox/sdk/javascript
[6]: https://eve.dev/docs/sandbox
[7]: https://vercel.com/docs/sandbox/pricing
[8]: https://vercel.com/docs/ai-gateway/pricing
[9]: https://vercel.com/docs/sandbox/concepts/authentication

[Organizer brief and FAQ][1] · [eve setup][2] · [typed tools and execution context][3] · [client sessions][4] · [Sandbox JS SDK and network policy][5] · [eve sandbox lifecycle and providers][6] · [Sandbox rates and quotas][7] · [model pricing][8] · [Sandbox credential scope][9].
