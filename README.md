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
MCP host's OAuth session, so use the same organization for both. Do not transfer
credentials between these clients. Managed CI execution is not available in
this release.

## Agent registration

For an agent acting on a person's behalf, follow
[Firedrill account access](https://app.firedrill.run/auth.md). This uses WorkOS's
hosted service-auth claim ceremony. The person signs in, selects an organization
and returns the displayed code. An email address alone never grants access.
When exchanging the resulting assertion for a token to call MCP, set the
resource to exactly `https://mcp.firedrill.run`. The default application audience
is not a substitute. Keep credentials in the client's private credential store.

This registration flow is separate from the MCP host's normal browser OAuth
connection and the CLI's device sign-in. Never copy credentials between them.

## First useful workflow

1. Read the tools advertised by the connected server. Call
   `firedrill_workspaces` and select the intended workspace explicitly.
2. Your coding agent reads the local project. Use `firedrill_register_agent`
   to register its descriptor. Use `firedrill_save_resource` to save personas,
   scenarios and evaluations, then `firedrill_create_world` to assemble them.
   Reuse existing cloud resources where appropriate rather than duplicating them.
3. Call `firedrill_review_world` to inspect preparation requirements and the
   estimate. Use `firedrill_prepare_world` with the reviewed inputs and the
   workspace's required authorization. Preserve its original request identity.
4. Use `firedrill_create_campaign` for the selected scenarios, repetitions and
   concurrency. The local Firedrill CLI companion runs the actual customer
   agent. MCP cannot launch a process on the laptop. Worlds and results stay
   cloud-owned.
5. Read progress and results with `firedrill_report`. Use `firedrill_discover`
   to find detailed conversation, score, action, state and evidence operations,
   read their exact schemas, then call them through `firedrill_operation`.
6. For standalone tools, use `firedrill_review_tools`, `firedrill_quote_tools`
   and `firedrill_start_tools` in that order. Inspect an instance with
   `firedrill_inspect_tool`. Discover the exact reset, checkpoint, preview and
   stop operations instead of guessing their names.

Use each tool's current input schema. These names describe the focused release
surface, not permission to skip dependency selection, approvals or cost limits.
Additional operations are available through discovery, not legacy quickstart
aliases or a second local MCP server.

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
