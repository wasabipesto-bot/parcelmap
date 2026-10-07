// Local preview: mock EasyPost + `wrangler dev`, no real data or keys involved.
//   node scripts/dev.mjs [spec.json] [-- extra wrangler dev args]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildConfig } from "./config.mjs";
import { startMock } from "./mock-easypost.mjs";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const [specPath = "test/demo-spec.json"] = split >= 0 ? argv.slice(0, split) : argv;
const extra = split >= 0 ? argv.slice(split + 1) : [];

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const MOCK_PORT = 8788;
await startMock(specPath, MOCK_PORT);
const config = buildConfig(spec.origin, spec.packages);

const wrangler = spawn(
  "npx",
  [
    "wrangler", "dev", "--local", "--persist-to", ".wrangler/dev-state",
    "--var", `PACKAGES:${JSON.stringify(config)}`,
    "--var", "EASYPOST_API_KEY:mock",
    "--var", `EASYPOST_BASE:http://127.0.0.1:${MOCK_PORT}`,
    "--var", "CACHE_TTL_SECONDS:15",
    ...extra,
  ],
  { stdio: "inherit" },
);
wrangler.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => wrangler.kill(sig));
