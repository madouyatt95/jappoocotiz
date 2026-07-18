import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["index.html", "styles.css", "app.js", "supabase-client.js", "sw.js", "manifest.webmanifest", "assets/icon.svg", "vercel.json", "scripts/build.mjs", "config.js", "supabase/migrations/202607180001_initial_schema.sql", "supabase/migrations/202607180002_member_approval_and_activity.sql", "supabase/migrations/202607180003_member_fund_schedules.sql"];
const contents = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), "utf8")])));

const checks = [
  ["manifest standalone", contents["manifest.webmanifest"].includes('"display": "standalone"')],
  ["orientation mobile", contents["manifest.webmanifest"].includes('"orientation": "portrait-primary"')],
  ["viewport et safe-area", contents["index.html"].includes("viewport-fit=cover") && contents["styles.css"].includes("env(safe-area-inset-bottom)")],
  ["mode plein écran", contents["styles.css"].includes("100dvh")],
  ["service worker v9", contents["app.js"].includes("serviceWorker.register") && contents["sw.js"].includes("jappo-cotiz-v9")],
  ["cache de lecture sans démo", contents["app.js"].includes("jappo-cotiz-read-cache-v3") && contents["app.js"].includes("payments: []") && contents["app.js"].includes("activities: []")],
  ["deux caisses uniquement", contents["app.js"].includes('ALLOWED_CONTRIBUTIONS = ["family", "death"]') && !contents["app.js"].includes("Projet maison") && !contents["app.js"].includes("Fête familiale")],
  ["aucune identité fictive", !contents["index.html"].includes("Mahamadou") && !contents["app.js"].includes("Aminata") && !contents["app.js"].includes("Ousmane")],
  ["aucune déclaration membre", !contents["index.html"].includes("Déclarer un paiement") && !contents["app.js"].includes("openPayment")],
  ["paiement réservé à la gestion", contents["index.html"].includes('data-action="record-cash"') && contents["index.html"].includes("Réservé aux personnes habilitées") && contents["app.js"].includes("canRecordCash()")],
  ["espèces uniquement", contents["index.html"].includes('value="Espèces" readonly') && contents["supabase-client.js"].includes('recordCashPayment') && contents["supabase/migrations/202607180001_initial_schema.sql"].includes("check (method = 'cash')")],
  ["micro informatif uniquement", contents["index.html"].includes("Consultation vocale uniquement") && !contents["index.html"].includes('data-voice-command="payment"') && !contents["app.js"].includes('executeVoiceCommand("payment")')],
  ["reconnaissance et synthèse vocales", contents["app.js"].includes("SpeechRecognition") && contents["app.js"].includes("SpeechSynthesisUtterance")],
  ["configuration Vercel", contents["vercel.json"].includes("X-Content-Type-Options")]
];

checks.push(["build statique Vercel", contents["vercel.json"].includes('"outputDirectory": "dist"') && contents["scripts/build.mjs"].includes("Build statique")]);
checks.push(["configuration Supabase publique séparée", contents["index.html"].includes("config.js?v=1") && !contents["config.js"].includes("supabase.co")]);
checks.push(["client Supabase authentifié", contents["index.html"].includes("supabase-client.js?v=6") && contents["supabase-client.js"].includes("Authorization: `Bearer") && contents["app.js"].includes("syncFromBackend")]);
checks.push(["connexion admin par mot de passe", contents["index.html"].includes('id="auth-password"') && contents["supabase-client.js"].includes('grant_type=password') && contents["app.js"].includes("signInWithPassword(email, password)")]);
checks.push(["création du mot de passe admin", contents["index.html"].includes('id="admin-password-form"') && contents["supabase-client.js"].includes("updatePassword") && contents["app.js"].includes("submitAdminPassword")]);
checks.push(["lien de connexion de secours", contents["index.html"].includes('data-action="send-login-link"') && contents["app.js"].includes("sendLoginLink") && contents["supabase-client.js"].includes("sendMagicLink")]);
checks.push(["RLS activée sur les paiements", contents["supabase/migrations/202607180001_initial_schema.sql"].includes("alter table public.cash_payments enable row level security") && contents["supabase/migrations/202607180001_initial_schema.sql"].includes("cash_payments_select_scope")]);
checks.push(["aucune écriture financière locale", !contents["app.js"].includes("state.payments.unshift") && contents["app.js"].includes("recordCashPayment")]);
checks.push(["mensualités de 5 euros depuis 2021", contents["supabase/migrations/202607180001_initial_schema.sql"].includes("monthly_amount numeric") && contents["supabase/migrations/202607180001_initial_schema.sql"].includes("date '2021-01-01'")]);
checks.push(["allocation sur les plus anciennes échéances", contents["supabase/migrations/202607180001_initial_schema.sql"].includes("record_cash_payment") && contents["supabase/migrations/202607180001_initial_schema.sql"].includes("cash_payment_allocations")]);
checks.push(["affichage séparé des caisses", contents["index.html"].includes('data-fund-view="family"') && contents["index.html"].includes('data-cash-fund="death"')]);
checks.push(["paiement rapide immédiatement visible aux habilités", contents["index.html"].includes('id="quick-payment-fab"') && contents["index.html"].includes("Ajouter un paiement") && contents["app.js"].includes('classList.toggle("hidden", !canRecordCash())') && contents["index.html"].includes('data-month-count="all"')]);
checks.push(["configuration administrateur des caisses", contents["index.html"].includes("fund-config-form") && contents["supabase-client.js"].includes("configureFund")]);
checks.push(["paramétrage caisse accessible depuis les caisses", contents["index.html"].includes('id="fund-config-shortcut"') && contents["app.js"].includes('classList.toggle("hidden", !isAdministrator())') && contents["app.js"].includes("shortcut.dataset.editFund = fund.id")]);
checks.push(["nouveaux comptes en attente", contents["supabase/migrations/202607180002_member_approval_and_activity.sql"].includes("'pending', 'read'") && contents["app.js"].includes("Compte en attente de validation")]);
checks.push(["validation administrateur des droits", contents["supabase/migrations/202607180002_member_approval_and_activity.sql"].includes("review_member_access") && contents["index.html"].includes("Comptes et droits") && contents["supabase-client.js"].includes("reviewMemberAccess")]);
checks.push(["lecture seule ou saisie par caisse", contents["supabase/migrations/202607180002_member_approval_and_activity.sql"].includes("access_level in ('read', 'write')") && contents["index.html"].includes("lecture seule, saisie sur la caisse Famille")]);
checks.push(["activité générale sécurisée", contents["supabase/migrations/202607180002_member_approval_and_activity.sql"].includes("list_payment_activity") && contents["supabase/migrations/202607180002_member_approval_and_activity.sql"].includes("case when reveal_names") && contents["index.html"].includes("Mouvements généraux")]);
checks.push(["écriture limitée par caisse", contents["supabase/migrations/202607180003_member_fund_schedules.sql"].includes("write_fund_codes") && contents["supabase/migrations/202607180003_member_fund_schedules.sql"].includes("can_record_fund") && contents["app.js"].includes('data-write-funds="family,death"')]);
checks.push(["admin avec écriture sur les deux caisses", contents["supabase/migrations/202607180003_member_fund_schedules.sql"].includes("member.role = 'admin' or fund.code = any(member.write_fund_codes)") && contents["app.js"].includes("ALLOWED_CONTRIBUTIONS.slice()")]);
checks.push(["mensualités rétroactives par membre et caisse", contents["index.html"].includes('id="member-schedule-form"') && contents["supabase-client.js"].includes("setMemberFundSchedule") && contents["supabase/migrations/202607180003_member_fund_schedules.sql"].includes("member_fund_schedules")]);
checks.push(["paiements existants préservés", contents["supabase/migrations/202607180003_member_fund_schedules.sql"].includes("amount_paid = 0") && contents["index.html"].includes("Les paiements existants sont conservés")]);

for (const file of ["app.js", "supabase-client.js", "sw.js", "server.mjs", "scripts/build.mjs", "scripts/check.mjs"]) {
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
