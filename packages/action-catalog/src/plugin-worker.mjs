const [mode, entrypoint, handlerId] = process.argv.slice(2);
if (!mode || !entrypoint) process.exit(64);
try {
  const moduleExports = await import(entrypoint);
  const root = moduleExports && typeof moduleExports === "object" ? moduleExports : {};
  const defaults = root.default && typeof root.default === "object" ? root.default : {};
  const handlers = root.handlers && typeof root.handlers === "object" ? root.handlers : defaults.handlers && typeof defaults.handlers === "object" ? defaults.handlers : {};
  if (mode === "list") {
    process.stdout.write(`${JSON.stringify({ handlers: Object.entries(handlers).filter(([, value]) => typeof value === "function").map(([id]) => id) })}\n`);
    process.exit(0);
  }
  const handler = handlers[handlerId];
  if (typeof handler !== "function") throw new Error(`handler_not_exported:${handlerId}`);
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const result = await handler(JSON.parse(input || "{}"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
