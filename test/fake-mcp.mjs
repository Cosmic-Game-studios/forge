// A minimal MCP server over stdio for the tests: two tools, newline-delimited JSON-RPC.
import readline from "node:readline";

const tools = [
  { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "now", description: "A fixed time.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

console.log("starting up (not JSON - a client must ignore this)");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (msg.method === "tools/list") reply({ tools });
  else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo") reply({ content: [{ type: "text", text: `echo: ${args.text}` }] });
    else if (name === "now") reply({ content: [{ type: "text", text: "12:00" }] });
    else reply({ content: [{ type: "text", text: "no such tool" }], isError: true });
  } else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
});
