import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLocalOperatorServer } from "./local-login.js";
import { FiredrillError } from "../sdk/index.js";
try {
    const server = await createLocalOperatorServer({ token: process.env.FIREDRILL_TOKEN, storeDirectory: process.env.FIREDRILL_LOGIN_STORE_DIRECTORY, readonly: process.env.FIREDRILL_MCP_READONLY === "true" });
    await server.connect(new StdioServerTransport());
}
catch (error) {
    console.error(error instanceof FiredrillError ? JSON.stringify(error.toJSON()) : "Firedrill MCP could not confirm access. Run firedrill login status or check the scoped FIREDRILL_TOKEN. No browser was opened and no anonymous access was granted.");
    process.exitCode = 1;
}
