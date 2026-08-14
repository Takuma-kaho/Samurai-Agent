import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (!output || output.startsWith("-")) {
  console.error("Usage: pnpm server:02:account -- --output ./owner-identity.json");
  process.exitCode = 1;
} else {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const accountId = `account_${createHash("sha256").update(publicDer).digest("hex").slice(0, 40)}`;
  const identity = {
    format_version: 1,
    account_id: accountId,
    public_key: `base64:${publicDer.toString("base64")}`,
    private_key_pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  };
  const target = path.resolve(output);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ account_id: accountId, public_key: identity.public_key, identity_file: target }, null, 2));
}
