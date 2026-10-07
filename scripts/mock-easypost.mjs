// Stand-in for api.easypost.com: GET /v2/trackers/:id answers from a spec file
// (default test/demo-spec.json), with scan times relative to the request.
//   node scripts/mock-easypost.mjs [spec.json] [port]

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { buildTracker } from "../test/fixtures.js";

export function startMock(specPath = "test/demo-spec.json", port = 8788) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const server = createServer((req, res) => {
    const m = req.url.match(/^\/v2\/trackers\/([^/?]+)/);
    const pkg = m && spec.packages.find((p) => p.id === decodeURIComponent(m[1]));
    if (!req.headers.authorization) {
      res.writeHead(401).end();
    } else if (!pkg) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"code":"NOT_FOUND"}}');
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(buildTracker(spec, pkg)));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [spec, port] = process.argv.slice(2);
  await startMock(spec, Number(port ?? 8788));
  console.log(`mock EasyPost on http://127.0.0.1:${port ?? 8788}`);
}
