import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLocalOperatorServer } from "./local-login.js";

const apiUrl = process.env.FIREDRILL_API_URL, token = process.env.FIREDRILL_TOKEN;
if (!apiUrl) { console.error("Firedrill MCP requires FIREDRILL_API_URL. Sign in with firedrill login for that origin, or supply an authorized FIREDRILL_TOKEN."); process.exit(1); }
try {
  const server = await createLocalOperatorServer({ apiUrl, token, storeDirectory: process.env.FIREDRILL_LOGIN_STORE_DIRECTORY, readonly: process.env.FIREDRILL_MCP_READONLY === "true" });
  await server.connect(new StdioServerTransport());
} catch {
  console.error("Firedrill MCP could not confirm access. Run firedrill login status for the configured API origin, or check the scoped FIREDRILL_TOKEN. No browser was opened and no anonymous access was granted.");
  process.exitCode = 1;
}
