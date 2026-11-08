// Minimal static server that mounts dist/ under a sub-path, mimicking https://<user>.github.io/<repo>/.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const [base = "/python-intelligence/", port = "4173"] = process.argv.slice(2);
// fileURLToPath, not .pathname: the repo path contains a space ("My Porfolio") that .pathname leaves as %20.
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".wasm": "application/wasm", ".py": "text/plain" };

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (!url.startsWith(base)) { res.writeHead(404).end("not under base path"); return; }
  let p = normalize(join(root, url.slice(base.length)));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  try { if ((await stat(p)).isDirectory()) p = join(p, "index.html"); } catch { /* fall through */ }
  try {
    const body = await readFile(p);
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("not found"); }
}).listen(Number(port), "127.0.0.1", () => console.log(`serving dist at http://127.0.0.1:${port}${base}`));
