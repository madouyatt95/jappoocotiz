import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.JAPPO_PORT || 4173);
const host = process.env.JAPPO_HOST || "127.0.0.1";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || host}`).pathname);
  const requested = normalize(pathname).replace(/^[/\\]+/, "");
  let filePath = join(root, requested || "index.html");
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end("Accès interdit");
    return;
  }
  try {
    if ((await stat(filePath)).isDirectory()) filePath = join(filePath, "index.html");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    response.end(body);
  } catch {
    try {
      const body = await readFile(join(root, "index.html"));
      response.writeHead(200, { "Content-Type": types[".html"], "Cache-Control": "no-cache" });
      response.end(body);
    } catch {
      response.writeHead(404).end("Introuvable");
    }
  }
}).listen(port, host, () => {
  console.log(`Jàppoo Cotiz est disponible sur http://${host}:${port}`);
});
