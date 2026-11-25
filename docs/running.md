# Running First Five Minutes

Use Node.js 24 or newer and Git. Run the following from this checkout.

```sh
npm ci
npm test
npm start -- --help
```

## Offline demonstration

The demo creates three small synthetic Git repositories. A scripted reader uses their README text. The normal approval, execution, observation and receipt code runs against isolated local Docker containers. The demo requires a running Docker daemon and the two images below. The demo itself uses local images by digest, disables container networking and removes each container.

```sh
docker pull python:3.12-slim
docker pull node:20-bookworm
npm start -- demo
```

The terminal prints the path of each receipt in `.first-five/`. Open a receipt to see the selected image, the actual documented command, its output, the check and teardown. The Python example creates a file. The Node example serves a welcome message on loopback. A third guide misspells the Python filename. Its receipt records the failure. A fourth attempt changes that one line and independently checks the result in a fresh container.

## Run against a repository

Use a nonproduction Vercel project and an immutable custom Sandbox image available to that project. The image needs Bash, coreutils and grep. HTTP checks and measured downloads also need curl. The initial runtime probes support Node and Python. The image catalog describes reusable starting environments. Each entry declares the runtime actually preinstalled in that image. An empty catalog lets you exercise intake and receive an unsupported verdict without creating a VM.

Create a local JSON config. Replace the illustrative identifiers and image digest with real values for your account.

```json
{
  "model": "openai/gpt-5.4-mini",
  "modelConnection": "openai",
  "teamId": "team_YOUR_TEAM",
  "projectId": "prj_YOUR_PROJECT",
  "externalHosts": [],
  "catalog": [
    {
      "provider": "vercel",
      "image": "YOUR_IMAGE@sha256:YOUR_64_CHARACTER_HEX_DIGEST",
      "runtimes": { "python": "3.12.8" },
      "region": "iad1"
    }
  ]
}
```

Supply `OPENAI_API_KEY` for the direct OpenAI connection. To use Vercel AI Gateway, select `"modelConnection": "gateway"` and supply `AI_GATEWAY_API_KEY`. Choose the model ID available to your account. The sandbox controller uses `VERCEL_TOKEN` when it creates the VM. These credentials stay outside the target repository and VM. Provider billing applies to model calls during intake, including plans that are later declined.

```sh
npm start -- run /path/to/local/git/repo HEAD --config ./config.json
npm start -- run https://github.com/OWNER/REPO.git COMMIT --config ./config.json
```

Review the printed image, commands, citations, outbound access and observer. Answer the approval prompt to create one VM. Noninteractive runs print the plan and decline by default. Automation can pass `--approve DIGEST` for a previously reviewed identical plan. A different plan requires a fresh review. To save receipts outside the current directory, specify `--out /path/to/receipts`.

Each attempt uses a fresh VM with a bounded lifetime. Set account-side spending controls for live work. Optional `modelLimits` and `limits` fields tune local ceilings. The controller permits up to 24 model calls per invocation by default, configurable with `modelLimits.modelRounds` up to 32. Model usage checks take effect between calls and the final call can cross a session usage threshold. Confirm cleanup in the receipt. A resource with unconfirmed teardown needs operator reconciliation.

Only explicitly linked external documentation on hosts listed in `externalHosts` is eligible for intake. VM egress is approved separately. The current observers support a repository-relative file or a loopback HTTP response with optional expected text. Unavailable checks and environments are reported in the receipt. The supported online path starts with a documented `curl -o NAME https://HOST/PATH` (optionally `-fsS` before `-o`). The controller closes outbound access after that step and records the SHA-256 of the actual downloaded file. Later steps can install the captured bytes offline. Open-ended registry installs are reported as unsupported before provisioning because the runner cannot establish their complete artifact identities.

## Diagnose and replay

Provide a saved blocked receipt to the diagnosis command. The diagnosis session can read bounded excerpts from files at the original revision. It writes an unverified explanation and proposed documentation edits next to the receipt. Review those edits before replay.

```sh
npm start -- diagnose ./runs/BASE/receipt.md --config ./config.json
npm start -- replay ./runs/BASE/receipt.md --edits ./runs/BASE/receipt.md.diagnosis.json --config ./config.json
```

Replay passes the edited guide to a new reader session and stages the original source in a fresh VM. The comparison checks both outcomes and the recorded identities. The target repository stays untouched. Keep the Markdown receipt and adjacent JSON evidence together. CLI exit status is 0 for a pass, 1 for a reported non-pass or an inconclusive replay comparison, and 2 for a declined plan or invocation error.
