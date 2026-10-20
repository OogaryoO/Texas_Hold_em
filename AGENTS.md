# Deploying an app to BellD (staging)

Audience: a coding agent that must build an app and deploy it to BellD staging on behalf of
a developer. Read this file completely before you write code or call anything.

Staging endpoints:

| Purpose | URL |
| --- | --- |
| Console (web UI) | `https://console.staging.belld.ai` |
| Control API | `https://api.staging.belld.ai` |
| Sign-in (OIDC issuer) | `https://auth.staging.belld.ai/realms/belld` |
| Developer docs | `https://docs.staging.belld.ai` |

The docs site is the authority. If this file and the docs site disagree, the docs site wins;
fetch `https://docs.staging.belld.ai/getting-started/` and say so.

---

## 1. The model you are deploying into

A deploy is a chain. Each stage produces an identifier you pass to the next one. Nothing here
is guessable: always copy identifiers from a response.

```
workspace (ws_)
  └── service / Product (prod_)        created from a git repository
        └── revision (rev_)            one frozen commit + a detected descriptor
              └── qualification run (pipe_)  build + checks → verdict
                    └── version (ver_)        a qualified revision
                          └── release (rel_)   what you choose to ship
                                └── deployment (dep_)
                                      └── Surface (srf_)  the public URL
```

The **descriptor** is how BellD decided to build and run your app. BellD detects it; you
confirm it. It is returned to you (Console and API) and contains `build_plan`
(`runtime`, `workdir`, `install`, `build`, `start`, `port`, `health`, `env`), `runtime`,
`entrypoint`, `ports`, and `field_sources` marking each field `detected` or `developer`.
**Read the detected descriptor instead of assuming.** That is the one reliable way to confirm
how your app will run.

---

## 2. Rules for a deployable app

These are hard requirements. Breaking one does not fail fast — it usually fails later, during
qualification, and a revision allows **at most 3 qualification runs**. Check them before import.

### 2.1 Node server app (an app with a backend — this is supported)

- Put `package.json` in the service root (the repository root, or the subdirectory you set).
- Provide a start command: `scripts.start` in `package.json`. Without it, BellD looks for
  `main`, `index.js` or `server.js`.
- **Listen on `process.env.PORT`.** Do not hardcode a port. The detected default port is 3000.
  To declare a different one, set `belld.port` in `package.json`.
- **Answer the health path with a success response, quickly after start.** The detected default
  is `/` with a short timeout. Override the path with `belld.health.path`. An app that only
  answers `/api/...` and returns an error on `/` fails its health check.
- Bind all interfaces (omit the host argument, or use `0.0.0.0`). Do not bind `127.0.0.1` only.
- **The runtime environment is an allowlist.** Expect `PORT` and `NODE_ENV` to be present.
  Every other value must be set as a variable (section 4). Do not expect your shell
  environment, a `.env` file, or `process.env.HOME` to carry anything.
- Node version comes from `engines.node`; the default is 22.
- **Commit a lockfile that matches `package.json`.** BellD installs from the committed lockfile
  and does not update it. The package manager follows the lockfile: `pnpm-lock.yaml` → pnpm,
  `yarn.lock` → yarn, otherwise npm. `packageManager` in `package.json` is ignored.
- `scripts.build` runs before start if it exists.

Minimal app that satisfies every rule above:

```js
// server.js
import { createServer } from 'node:http';
const port = process.env.PORT ?? 3000;
createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(404); res.end();
}).listen(port);
```

```json
{
  "name": "hello-belld",
  "private": true,
  "type": "module",
  "engines": { "node": "22.x" },
  "scripts": { "start": "node server.js" }
}
```

Generate and commit the lockfile (`npm install`) even with zero dependencies.

### 2.2 Static site (Vite)

If a Node project has **no** server entrypoint (no `scripts.start`, `main`, `index.js` or
`server.js`), **has** a build script, and has `index.html` and a `vite.config` file in the
service root, BellD builds it and serves `dist/`. Then:

- A path with no file extension falls back to `index.html`. A missing path whose last segment
  contains a dot (for example `/u/john.doe`) returns 404.
- Each file: 10 MiB maximum. The page at the health path (default `/`): 64 KiB maximum.
- A Vite `base` other than `/` makes assets return 404.
- Build-time variables such as `VITE_*` are not settable yet. Do not design around them without
  checking the Console first.
- If the build writes to another folder, edit the start command in the descriptor to
  `node /belld/static-server.mjs <folder>`.

### 2.3 Network during build

- Dependency install can reach **only the public npm registry** (`registry.npmjs.org`).
- The build command can additionally reach Google Fonts (`fonts.googleapis.com`,
  `fonts.gstatic.com`), so `next/font/google` works.
- Every other download fails. This includes install scripts that fetch binaries (Prisma
  engines, for example), package files hosted outside npm, and build scripts that fetch from
  other hosts. Choose dependencies accordingly.

### 2.4 Network at runtime (outbound)

- **By default a deployed app has no outbound network.** The Free plan blocks all outbound
  connections.
- On a paid plan, declare the hosts you need in `package.json`:

  ```json
  { "belld": { "egress": ["api.openai.com", "*.example.com", "db.example.com:5432"] } }
  ```

- Each entry is a host name, optionally with `:443` or `:5432`; without a port it means 443.
  Only those two ports are open.
- `*.example.com` matches subdomains but not `example.com` itself. Wildcards over a public
  suffix (`*.com`) are rejected. Hosts served by a shared front end are rejected.
- At most 50 entries. **Invalid entries make descriptor confirmation fail.**
- Port 5432 is PostgreSQL over TLS only (`sslmode=require` or stricter; `ssl: true` with
  node-postgres), SNI required, plain text refused. **IPv4 only** — a host that publishes only
  IPv6 (such as a Supabase direct database host) is unreachable; use an IPv4 pooler.
- Connections can be closed when the platform restarts its network proxy. Handle connection
  errors in your pool.
- Declarations are frozen with each revision, so changing them needs a new revision and deploy.
- An entry opens the whole service behind that host, not only your account. Third-party costs
  are not covered by BellD spending limits.
- In the Console, **Outbound** shows declared hosts of the active deployment and hosts blocked
  in the last 24 hours (registrable domain only).

If the app needs a database or a third-party API, confirm the plan allows egress **before**
writing the integration. Otherwise the app deploys and then fails at runtime.

### 2.5 Repository and secrets

- A public GitHub repository needs no credential. A **private** repository needs the ID of a
  `source.read` credential in the workspace.
- Never commit secrets. Never put a secret in a command-line argument. Set secrets as variables
  (section 4); secret values are write-only and read back as `null`.
- In a monorepo, set the subdirectory at creation time (**Subdirectory** in the Console,
  `--root` in the CLI). It cannot be changed afterwards. BellD reads `package.json`, its scripts
  and the Node version from that subdirectory. If that subdirectory has no lockfile and the
  repository root has one, dependencies install at the root and the subdirectory must be a
  workspace of the root project. Every `.npmrc` in the repository is removed before install, so
  settings such as `node-linker` or `shamefully-hoist` do not apply.

---

## 3. How to deploy

Two paths. They do the same thing. Use the Console unless the developer asks for the CLI.

### 3.1 Console (no install required)

1. Open `https://console.staging.belld.ai` and sign in. The token lives in memory only;
   reloading the page signs in again.
2. Select the workspace. If the Console shows **No workspaces**, use **Become a developer** —
   it creates a workspace you own and states the current credit offer.
3. Open the **Services** page and use the form **1. Create service from repository**:
   Repository URL, Git ref (`main`), Subdirectory (empty unless monorepo), Source credential ID
   (empty for a public repository). Select **Create service**.
4. Wait for **2. Source freeze** to reach `frozen`. BellD then runs the chain automatically:
   `descriptor → qualification → release → deployment → surface`. The page shows the current
   step and per-stage progress.
5. When the run state is `completed`, use the **Open Surface** link.

If a step reports `stopped`, the page shows the step and a reason code, with **Continue**,
**Cancel**, and (at the descriptor step) a switch to the manual flow.

### 3.2 CLI / MCP

The `belld` CLI is distributed from the BellD repository checkout; the published setup block is
in `https://docs.staging.belld.ai/getting-started/`. If you do not already have the `belld`
command, use the Console — do not try to install it from a package registry.

```bash
belld login --api-url https://api.staging.belld.ai \
  --issuer https://auth.staging.belld.ai/realms/belld --client-id belld-cli
belld workspace list
belld workspace use ws_REPLACE
export BELLD_API_URL=https://api.staging.belld.ai

belld init --repo https://github.com/OWNER/APP.git --ref main --json   # or: belld link prod_REPLACE
belld status --json
belld doctor

belld revision list --product prod_REPLACE --json
belld revision get rev_REPLACE --json          # read the detected descriptor here
belld revision confirm rev_REPLACE --product prod_REPLACE --json

belld evaluate rev_REPLACE --intent qualification --json
belld pipeline-run get pipe_REPLACE --json     # until qualification.status == qualified

belld release create --product prod_REPLACE --revision rev_REPLACE --json
belld deploy rel_REPLACE --environment staging --json
belld deployment get dep_REPLACE --json
belld surface get srf_REPLACE --json
```

`belld init` writes `.belld/project.json` in the current directory (workspace and Product IDs,
never a credential). `--repo`/`--ref` select the source; the working directory only selects
where the mapping is written.

For agent use, `belld mcp` starts a local stdio MCP gateway. Useful read-only tools:
`belld_requirements` (detects requirements from local project evidence; no API calls),
`belld_context`, `belld_doctor`, `belld_next_step`, `belld_status`, `belld_explain`,
`belld_capabilities`. The published tool list is at `https://docs.staging.belld.ai/mcp/`.

---

## 4. Variables

Set runtime variables per App or per service in the Console (**Variables**) or with
`belld variables list|set|unset`. Secrets are write-only: listing returns `null` for the value.
Supply secret values through stdin or `--from-env NAME`, never as a visible argument.
Build-time variables are a separate, narrower feature — verify support in the Console before
depending on them (see 2.2).

---

## 5. Rules for you, the agent

Correctness rules, not style preferences. Most failed deploys come from breaking one of these.

1. **Never invent an identifier, hostname or Surface URL.** Copy them from responses. IDs are
   prefixed (`ws_`, `prod_`, `rev_`, `pipe_`, `ver_`, `rel_`, `dep_`, `srf_`) and several CLI
   commands reject an argument with the wrong prefix.
2. **Exit code 0 is not a pass.** Qualification passed only when the response field
   `qualification.status` equals `qualified`. Read it from `belld evaluate` or
   `belld pipeline-run get`.
3. **Do not read the verdict from `belld status`.** Its `pipeline_runs` entries are summaries:
   no `qualification`, no `evidence`, unreliable timestamps.
4. **`deployment get`, `surface get` and `pipeline-run get` read once.** They do not poll. Loop
   yourself with a deadline and report a timeout as a timeout.
5. **A revision allows at most 3 qualification runs.** Fix the app and create a new revision
   from a new commit rather than burning runs. `--rerun` starts a new run only when the last one
   was blocked by a usage limit or stopped by a platform failure. Evaluating an
   already-evaluated revision is idempotent and returns the existing run.
6. **Exit codes:** 0 success, 1 general error / 429 / 5xx / timeout, 2 usage error,
   3 unauthenticated, 4 not found, 5 forbidden. Exit 3 during polling does not mean the run
   failed — the run continues on the platform; re-read it with `pipeline-run get`.
7. **Replay instead of duplicating.** On a failed write the CLI prints the key it used on stderr
   as `idempotency-key KEY`; rerun with `--idempotency-key KEY`.
8. When qualification stops, read the findings and use `belld explain rev_REPLACE` or
   `belld explain dep_REPLACE` before changing anything. Fix the cause, not the symptom.
9. `belld revision confirm --edits JSON` overrides detected descriptor fields. Only
   `build_plan`, `runtime`, `entrypoint` and `ports` are accepted, and the API validates them.
   Prefer fixing `package.json` so detection is right.
10. Opening the Surface URL still goes through the release access policy. A URL is not a bypass.
11. Report what happened. If a stage stopped, say which stage and quote the reason code. Do not
    describe a deploy as finished before the Surface answers.
