# Firedrill operator MCP

Operate Firedrill from a coding agent: discover schemas, prepare simulations,
inspect retained evidence, compare runs and manage authorized synthetic Tools.
This is the **operator → Firedrill** connection on the human's behalf. It does
not sign in to the coding-agent provider or the application being simulated.

This repository contains a standalone stdio client, its TypeScript source and its exact
client dependencies. It contains no Firedrill engine, service, database or
HTTP server. Customer applications execute in their own runner; MCP admission
alone never launches code on a laptop.

## Install the client

Use Node 22 or newer. From your application repository:

```sh
npm install --save-dev --save-exact --ignore-scripts @firedrill-run/mcp@2.0.0
```

The CLI package also includes the same `firedrill-mcp` binary: install one owner
of that binary per application, not both packages.

In a host that supports stdio MCP, configure command `npx`, arguments
`["--no-install", "firedrill-mcp"]` and the application's working directory.
Production is automatic; no API-address environment variable is needed.
If the host cannot set a working directory, use the absolute installed binary
path instead. Alternate API addresses are rejected. Do not put a credential in the config.

The client reuses the protected Firedrill login for that exact origin. Otherwise
`firedrill_authenticate` starts an explicit device approval: show the human its
URL/code, observe `status`, and select an authorized organization with `choose`
only when needed. Tokens are not returned to the model. External verification,
invitation or administrator actions must be completed by the human; they cannot
be bypassed by creating another organization. A later account/organization
change requires an explicit reconnect, not silently switched authority.

For CI, supply an authorized scoped `FIREDRILL_TOKEN` through the environment
from your secret store. It takes precedence over saved login; CI never prompts
or opens a browser. `FIREDRILL_MCP_READONLY=true` removes mutation tools while
the API still checks current authority on every request.

## First useful workflow

1. Read `firedrill_discover`, then the advertised `firedrill_schema` definitions.
2. Read `firedrill_context` and deliberately choose the project/environment.
3. Inspect the application's real command, HTTP or native invocation seam.
   Preview a small authored recipe before admitting it. Checks and Tools are
   optional; evaluation is a separate explicit choice.
4. If authorized to execute, preserve the creation key and exact arguments.
   Follow the returned continuation through the CLI or native SDK to attach a
   customer-owned runner to that same batch. Do not create a second batch.
5. Read reports/evidence using exact scope and returned cursors. Keep execution,
   outcome, assessment and CI gate separate; missing evidence is not zero.

Mutations require saved idempotency keys. After an uncertain reply, reconcile
the same action/key; never repeat a target merely to recover its evidence.
Synthetic Tool grants are separate, short-lived target credentials. Never copy
operator tokens into target input or model context. Native/ordinary command
execution is not a sandbox, and Tool rewind does not reset the external app.

The companion `firedrill-skills` repository supplies optional task-oriented
instructions. Installing instructions is not permission to run a simulation,
upload customer source, change workspace trust or authorize another account.

## Build this source export

```sh
npm install --ignore-scripts
npm run build
```

The explicit build compiles `src/mcp/main.ts` and its local client-only closure
into `dist/`. The binary starts `dist/mcp/main.js`. No private checkout,
workspace alias, global installation or automatic lifecycle build is needed.
`package.json` pins runtime and build dependencies; `PACKAGING.json` records the
reviewed artifact's source/file hashes and original dependency notices. A local
rebuild is a new artifact, not automatically the reviewed release.

`server.json` describes the npm transport and version for the official MCP
Registry. Directory availability is independent of installing the client directly.

## License

The client is proprietary under [the client use permission](LICENSE.md).
Third-party code retains its own notices under `notices/` and bundled package
licenses. A readable source export does not make the private service open-source.
