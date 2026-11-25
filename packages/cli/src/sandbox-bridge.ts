import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, createServer } from "node:net";

// This process runs inside the isolated network namespace. Its only route outside is the provider Unix socket.
const bridge = createServer((client) => {
  const provider = connect("/axiom/provider.sock");
  client.on("error", () => provider.destroy());
  provider.on("error", () => client.destroy());
  client.on("close", () => provider.destroy());
  provider.on("close", () => client.destroy());
  client.pipe(provider).pipe(client);
});
bridge.listen(43181, "127.0.0.1");
await once(bridge, "listening");
const [program, ...args] = process.argv.slice(2);
if (program !== "/axiom/claude") throw new Error("Invalid sandbox entrypoint.");
const native = spawn(program, args, { stdio: "inherit" });
native.once("error", () => process.exit(1));
native.once("exit", (code) => process.exit(code ?? 1));
