# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/wizzy-bounty/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/wizzy-bounty/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Anvil — a GitHub-compatible git forge that lives entirely in memory and in
two TypeScript files, with no dependencies beyond Node's built-ins. It speaks
the smart-HTTP git protocol (v0 and v2: advertisement, ls-refs, fetch with
shallow/deepen, receive-pack with fast-forward enforcement), the REST API
under `/api/v3` (repositories, contents, git refs, branches, commits, labels,
issues, comments, pull requests with a real three-way squash merge), GraphQL
at `/api/graphql` (viewer, repository, node, introspection, connections with
cursors, and the create/close/merge mutations), and an MCP endpoint at `/mcp`
— all over one shared store, so an object created on any surface is the same
object on every other. Commit timestamps derive from `MAKEFUN_TRIAL_NOW`, so
a run replays byte for byte; hot paths serve cached JSON bodies and a cached
depth-1 pack per branch tip.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

The entry binds an ephemeral port, registers it with the env at
`MAKEFUN_ENV_URL`, serves until the env reports the trial is done, and exits
0. It needs Node 22 or newer and nothing else — no install step, no build
step, no network calls of its own.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g31fe1mw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
