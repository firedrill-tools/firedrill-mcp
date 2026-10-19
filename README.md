# Firedrill operator MCP

Operate Firedrill from a coding agent: discover schemas, prepare simulations,
inspect retained evidence, compare runs and manage authorized synthetic Tools.
This is the **operator → Firedrill** connection on the human's behalf. It does
not sign in to the coding-agent provider or the application being simulated.

## Connect directly

Use Firedrill's remote Streamable HTTP endpoint:

```text
https://api.firedrill.run/mcp
```

No local MCP package, Firedrill CLI or Node.js installation is required for this
connection. Configure it through your host's native commands. For Codex:

```sh
codex mcp add firedrill --url https://api.firedrill.run/mcp
codex mcp login firedrill
```

For Claude Code project scope:

```sh
claude mcp add --scope project --transport http firedrill https://api.firedrill.run/mcp
claude mcp login firedrill
```

Codex writes user-wide MCP settings. Claude uses the selected project's
`.mcp.json` and asks for project approval. In Cursor, add
`"firedrill": { "url": "https://api.firedrill.run/mcp" }` under `mcpServers` in
`.cursor/mcp.json` and use its browser sign-in. In Kimi Code, use `/mcp-config`
to add a project HTTP server at that URL, then `/mcp-config login firedrill`.
Preserve other servers. Skills/plugin installation is a separate native action.

The browser authorization uses WorkOS. Review the identity and intended
organization, and let the host store its OAuth credential privately. Do not paste
tokens into chat or repository configuration. Account creation, email verification,
invitations and host trust remain explicit human steps when required; never
bypass them with another identity or replacement organization.

Remote MCP can prepare work and read retained results; it cannot execute a repo
on the customer's machine. Actual target execution uses a separately authorized
customer-owned CLI/SDK runner. CLI sign-in is separate from the MCP host's OAuth
session. CI supplies its own scoped credential through a secret store and never
opens browser approval. Do not transfer credentials between these clients.

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

## Repository contents

`server.json` describes the remote Streamable HTTP endpoint for the official MCP
Registry. Connecting uses that endpoint, not an npm MCP installation. Registry
metadata does not deploy a server or prove that browser authorization works.

Previously distributed client source, exact dependency records and their license
notices remain in this repository. They contain no Firedrill engine, service,
database or managed HTTP server. Their presence is not an onboarding step, and
local environment settings do not configure the managed remote connection.

## License

The client is proprietary under [the client use permission](LICENSE.md).
Third-party code retains its own notices under `notices/` and bundled package
licenses. A readable source export does not make the private service open-source.
