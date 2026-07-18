import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["index.html", "styles.css", "app.js", "sw.js", "manifest.webmanifest", "assets/icon.svg", "vercel.json"];
const contents = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), "utf8")])));

const checks = [
  ["manifest standalone", contents["manifest.webmanifest"].includes('"display": "standalone"')],
  ["orientation mobile", contents["manifest.webmanifest"].includes('"orientation": "portrait-primary"')],
  ["viewport et safe-area", contents["index.html"].includes("viewport-fit=cover") && contents["styles.css"].includes("env(safe-area-inset-bottom)")],
  ["mode plein écran", contents["styles.css"].includes("100dvh")],
  ["service worker v3", contents["app.js"].includes("serviceWorker.register") && contents["sw.js"].includes("jappo-cotiz-v3")],
  ["nouvelle persistance sans démo", contents["app.js"].includes("jappo-cotiz-clean-v2") && contents["app.js"].includes("payments: []") && contents["app.js"].includes("activities: []")],
  ["deux caisses uniquement", contents["app.js"].includes('ALLOWED_CONTRIBUTIONS = ["family", "death"]') && !contents["app.js"].includes("Projet maison") && !contents["app.js"].includes("Fête familiale")],
  ["aucune identité fictive", !contents["index.html"].includes("Mahamadou") && !contents["app.js"].includes("Aminata") && !contents["app.js"].includes("Ousmane")],
  ["aucune déclaration membre", !contents["index.html"].includes("Déclarer un paiement") && !contents["app.js"].includes("openPayment")],
  ["paiement réservé à la gestion", contents["index.html"].includes('data-action="record-cash"') && contents["index.html"].includes("Réservé aux personnes habilitées")],
  ["espèces uniquement", contents["index.html"].includes('value="Espèces" readonly') && contents["app.js"].includes('method: "Espèces"')],
  ["micro informatif uniquement", contents["index.html"].includes("Consultation vocale uniquement") && !contents["index.html"].includes('data-voice-command="payment"') && !contents["app.js"].includes('executeVoiceCommand("payment")')],
  ["reconnaissance et synthèse vocales", contents["app.js"].includes("SpeechRecognition") && contents["app.js"].includes("SpeechSynthesisUtterance")],
  ["configuration Vercel", contents["vercel.json"].includes("X-Content-Type-Options")]
];

for (const file of ["app.js", "sw.js", "server.mjs", "scripts/check.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  checks.push([`syntaxe ${file}`, result.status === 0]);
  if (result.status !== 0) process.stderr.write(result.stderr);
}

let failed = false;
for (const [label, passed] of checks) {
  console.log(`${passed ? "✓" : "✗"} ${label}`);
  if (!passed) failed = true;
}

if (failed) process.exit(1);
console.log(`\n${checks.length} contrôles réussis.`);
