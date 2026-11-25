# First Five Minutes

**Your CI is green. Can a newcomer follow your quickstart?**

Point the terminal agent at a repository and revision. It reads the README and linked setup docs, identifies the first useful result they promise, follows the documented steps in a clean environment, and checks whether that result occurs. The maintainer can review the proposed attempt without writing a profile, supplying a goal, or designing a test.

The Markdown receipt shows the instructions used, what actually ran, what the agent observed, and where a newcomer would get stuck. A documentation edit earns a verified result only after an independent replay.

**Status:** the terminal workflow is implemented. The offline demo runs two quickstarts and a broken guide in disposable Docker containers. Live model and Vercel Sandbox results depend on your configured accounts and images.

With Node.js 24 or newer, run `npm ci`, then `npm test`. Use `npm start -- --help` to see the CLI commands. Five minutes is a lens on onboarding.

| Start here | What it contains |
|---|---|
| [Run the tool](docs/running.md) | Offline demo, model and sandbox configuration, diagnosis and replay |
| [Product specification](docs/spec.md) | Repository intake, documentation interpretation, execution, verdicts and replay |
| [Implementation plan](docs/implementation.md) | Agent and sandbox decisions, approval order and acceptance tests |
| [Development roadmap](docs/roadmap.md) | Offline acceptance examples, sandbox experiment and cross-repository validation |
| [Feasibility research](research.md) | Earlier infrastructure proposal, sources, assumptions and challenge logistics |
