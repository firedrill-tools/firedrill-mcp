# Firedrill operator MCP

Operate Firedrill from a coding agent: discover schemas, prepare simulations,
inspect retained evidence, compare runs and manage authorized synthetic Tools.
This is the **operator → Firedrill** connection on the human's behalf. It does
not sign in to the coding-agent provider or the application being simulated.

## Connect directly

Use Firedrill's remote Streamable HTTP endpoint:

```text
https://mcp.firedrill.run
```

No local MCP package, Firedrill CLI or Node.js installation is required for this
connection. Configure it through your host's native commands. For Codex:

```sh
codex mcp add firedrill --url https://mcp.firedrill.run
codex mcp login firedrill
```

For Claude Code project scope:

```sh
claude mcp add --scope project --transport http firedrill https://mcp.firedrill.run
claude mcp login firedrill
```

Codex writes user-wide MCP settings. Claude uses the selected project's
`.mcp.json` and asks for project approval. In Cursor, add
`"firedrill": { "url": "https://mcp.firedrill.run" }` under `mcpServers` in
`.cursor/mcp.json` and use its browser sign-in. In Kimi Code, use `/mcp-config`
to add a project HTTP server at that URL, then `/mcp-config login firedrill`.
Preserve other servers. Skills/plugin installation is a separate native action.

For one-click setup links and host-specific instructions, open
[Connect your agent](https://firedrill.run/agents).

The browser authorization uses WorkOS. Review the identity and intended
organization, and let the host store its OAuth credential privately. Do not paste
tokens into chat or repository configuration. Account creation, email verification,
invitations and host trust remain explicit human steps when required; never
bypass them with another identity or replacement organization.

The MCP server cannot read your files or start processes. A drill against a
local target, meaning your agent running on your machine, runs through the
Firedrill CLI (`npm install --global firedrill-run`, then `firedrill init`).
Hosted cloud worlds run on Firedrill's side. CLI sign-in is separate from the
MCP host's OAuth session, so use the same organization for both. CI supplies
its own scoped credential through a secret store and never opens browser
approval. Do not transfer credentials between these clients.

## First useful workflow

1. Call `firedrill_discover` and `firedrill_projects` to see what the server
   supports and which workspaces you can use.
2. Read the repository, pick scenarios with `firedrill_scenarios`, and check a
   small plan with `firedrill_preview` before anything is saved.
3. With a person's approval, start the drill with `firedrill_create_batch`,
   against a local target through the CLI or a hosted cloud world. Actions
   that use credits need that approval.
4. Track progress with `firedrill_follow`, then inspect results with
   `firedrill_summary` and `firedrill_report`.
5. Synthetic tool sessions start with `firedrill_tools_start`; services are
   managed with the `firedrill_service_*` tools.

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
