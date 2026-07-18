import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
const staticFiles = ["index.html", "styles.css", "app.js", "supabase-client.js", "manifest.webmanifest", "sw.js"];

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
await Promise.all(staticFiles.map((file) => copyFile(join(root, file), join(output, file))));
await copyFile(join(root, "assets/icon.svg"), join(output, "assets/icon.svg"));
await copyFile(join(root, "assets/fflate.min.js"), join(output, "assets/fflate.min.js"));
await copyFile(join(root, "assets/fflate.LICENSE"), join(output, "assets/fflate.LICENSE"));

const publicConfig = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ""
};

await writeFile(
  join(output, "config.js"),
  `window.__JAPPO_CONFIG__ = Object.freeze(${JSON.stringify(publicConfig)});\n`,
  "utf8"
);

console.log(`Build statique généré dans ${output}`);
