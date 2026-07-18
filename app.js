const STORAGE_KEY = "jappo-cotiz-clean-v2";
const ALLOWED_CONTRIBUTIONS = ["family", "death"];

const initialState = {
  settings: { slowSpeech: true },
  contributions: [
    { id: "family", name: "Caisse famille", description: "Cotisation familiale", amount: 0, paid: 0, due: null, status: "unconfigured", icon: "family" },
    { id: "death", name: "Caisse décès", description: "Fonds de solidarité", amount: 0, paid: 0, due: null, status: "unconfigured", icon: "shield" }
  ],
  payments: [],
  activities: []
};

let state = loadState();
let currentFilter = "all";
let deferredInstallPrompt = null;
let recognition = null;
let toastTimer = null;

const statusConfig = {
  unconfigured: { label: "Aucune échéance", tone: "upcoming" },
  paid: { label: "Versement reçu", tone: "paid" },
  due: { label: "À payer", tone: "due" },
  late: { label: "En retard", tone: "late" },
  partial: { label: "Partiellement versée", tone: "partial" }
};

function cloneInitialState() {
  return JSON.parse(JSON.stringify(initialState));
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.payments && saved?.contributions && saved?.activities) {
      const clean = cloneInitialState();
      clean.settings = { ...clean.settings, ...saved.settings };
      clean.payments = saved.payments.filter((payment) => payment.method === "Espèces" && ALLOWED_CONTRIBUTIONS.includes(payment.contributionId));
      clean.activities = saved.activities;
      clean.contributions = clean.contributions.map((base) => {
        const stored = saved.contributions.find(({ id }) => id === base.id);
        return stored ? { ...base, paid: Number(stored.paid) || 0, amount: Number(stored.amount) || 0, due: stored.due || null, status: stored.status || base.status } : base;
      });
      return clean;
    }
  } catch (error) {
    console.warn("Les données locales ont été réinitialisées.", error);
  }
  return cloneInitialState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value, decimals = 0) {
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: 2 }).format(value);
}

function totalCollected() {
  return state.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function outstandingTotal() {
  return state.contributions.reduce((sum, item) => sum + Math.max(0, item.amount - item.paid), 0);
}

function contributionStatus(item) {
  if (item.amount > 0 && item.paid >= item.amount) return "paid";
  if (item.paid > 0 && item.amount > item.paid) return "partial";
  if (item.paid > 0) return "paid";
  if (item.status === "late") return "late";
  if (item.amount > 0) return "due";
  return "unconfigured";
}

function iconSVG(type) {
  const icons = {
    family: '<path d="M4 20a6 6 0 0 1 12 0M10 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17 11a3 3 0 0 1 3 3v6M17 5a3 3 0 0 1 0 6"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v5M12 17h.01"/>',
    receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2V2Z"/><path d="M9 7h6M9 11h6M9 15h4"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[type] || icons.receipt}</svg>`;
}

function contributionAmountLabel(item) {
  const remaining = Math.max(0, item.amount - item.paid);
  if (remaining > 0) return `${formatMoney(remaining)} €`;
  if (item.paid > 0) return `${formatMoney(item.paid)} €`;
  return "0 €";
}

function contributionDetail(item) {
  if (item.amount > item.paid) return `Reste ${formatMoney(item.amount - item.paid)} € à payer`;
  if (item.paid > 0) return `${formatMoney(item.paid)} € versés en espèces`;
  return "Aucune échéance enregistrée";
}

function renderHomeContributions() {
  document.querySelector("#home-contribution-list").innerHTML = state.contributions.map((item) => {
    const statusKey = contributionStatus(item);
    const status = statusConfig[statusKey];
    return `
      <article class="contribution-row" aria-label="${escapeHTML(item.name)}">
        <span class="contribution-icon ${status.tone}">${iconSVG(item.icon)}</span>
        <span class="contribution-copy"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(contributionDetail(item))}</small></span>
        <span class="contribution-amount"><strong>${contributionAmountLabel(item)}</strong><em class="status-badge ${status.tone}">${status.label}</em></span>
      </article>`;
  }).join("");
}

function renderDetailedContributions() {
  const filtered = state.contributions.filter((item) => currentFilter === "all" || contributionStatus(item) === currentFilter);
  const container = document.querySelector("#detailed-contribution-list");
  if (!filtered.length) {
    container.innerHTML = '<div class="notice-card"><div><strong>Aucune cotisation dans cette catégorie</strong><p>Les échéances apparaîtront ici après leur configuration par un responsable.</p></div></div>';
    return;
  }
  container.innerHTML = filtered.map((item) => {
    const statusKey = contributionStatus(item);
    const status = statusConfig[statusKey];
    const progress = item.amount ? Math.min(100, (item.paid / item.amount) * 100) : 0;
    const progressMarkup = statusKey === "partial" ? `<div class="partial-bar" aria-label="${Math.round(progress)} pour cent versé"><span style="width:${progress}%"></span></div>` : "";
    return `
      <article class="detail-card">
        <div class="detail-card-main">
          <span class="contribution-icon ${status.tone}">${iconSVG(item.icon)}</span>
          <div class="contribution-copy"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.description)}</small>${progressMarkup}</div>
          <div class="contribution-amount"><strong>${contributionAmountLabel(item)}</strong><em class="status-badge ${status.tone}">${status.label}</em></div>
        </div>
        <div class="detail-footer"><span>${escapeHTML(contributionDetail(item))}</span><span>Consultation</span></div>
      </article>`;
  }).join("");
}

function renderTransactions() {
  const container = document.querySelector("#transaction-list");
  if (!state.payments.length) {
    container.innerHTML = '<div class="empty-state"><span>₣</span><strong>Aucune opération</strong><p>Les paiements en espèces enregistrés apparaîtront ici.</p></div>';
    return;
  }
  container.innerHTML = state.payments.slice(0, 8).map((payment) => `
    <article class="transaction"><span class="transaction-icon in">↓</span><div><strong>${escapeHTML(payment.contribution)}</strong><small>${escapeHTML(payment.member)} • ${escapeHTML(payment.dateLabel)}</small></div><b class="money-in">+ ${formatMoney(payment.amount)} €</b></article>`).join("");
}

function renderActivities() {
  const container = document.querySelector("#activity-list");
  if (!state.activities.length) {
    container.innerHTML = '<div class="empty-state"><span>✓</span><strong>Historique vide</strong><p>Aucune donnée de démonstration. Les prochaines opérations réelles seront tracées ici.</p></div>';
    return;
  }
  const grouped = state.activities.reduce((result, item) => {
    (result[item.group] ||= []).push(item);
    return result;
  }, {});
  container.innerHTML = Object.entries(grouped).map(([group, activities]) => `
    <section class="timeline-group"><h2>${escapeHTML(group)}</h2>${activities.map((item) => `
      <article class="timeline-item"><span class="timeline-dot paid">✓</span><div class="timeline-content"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.text)}</p><time>${escapeHTML(item.time)}</time></div></article>`).join("")}</section>`).join("");
}

function renderAdminPayments() {
  const container = document.querySelector("#admin-cash-payments");
  if (!state.payments.length) {
    container.innerHTML = '<div class="notice-card"><span class="feature-icon green">✓</span><div><strong>Aucun paiement enregistré</strong><p>La liste est vide et ne contient aucune donnée de démonstration.</p></div></div>';
    return;
  }
  container.innerHTML = state.payments.slice(0, 6).map((payment) => `
    <article class="pending-card cash-payment-card">
      <div class="pending-main"><span class="member-avatar">MC</span><div><strong>${escapeHTML(payment.member)}</strong><small>${escapeHTML(payment.contribution)} • Espèces • ${escapeHTML(payment.periodLabel)}</small></div><div class="pending-amount"><b>${formatMoney(payment.amount)} €</b><time>${escapeHTML(payment.dateLabel)}</time></div></div>
      <div class="pending-proof">${iconSVG("receipt")}<span>Enregistré par ${escapeHTML(payment.recordedBy)}</span></div>
    </article>`).join("");
}

function renderPaymentOptions() {
  document.querySelector("#payment-contribution").innerHTML = state.contributions.map((item) => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join("");
}

function renderSummaries() {
  const collected = totalCollected();
  const outstanding = outstandingTotal();
  const paidFunds = state.contributions.filter((item) => item.paid > 0).length;
  const late = state.contributions.filter((item) => contributionStatus(item) === "late").reduce((sum, item) => sum + Math.max(0, item.amount - item.paid), 0);

  document.querySelector("#balance-total").textContent = formatMoney(outstanding);
  document.querySelector("#welcome-status-text").textContent = late ? `${formatMoney(late)} € en retard` : "Aucune échéance en retard";
  document.querySelector("#progress-label").textContent = `${paidFunds}/2`;
  document.querySelector(".month-progress").setAttribute("aria-label", `${paidFunds} caisse sur 2 avec un versement enregistré`);
  document.querySelector(".month-progress .progress-value").style.strokeDasharray = `${Math.round((paidFunds / 2) * 145)} 145`;
  document.querySelector("#paid-summary").textContent = `${formatMoney(collected)} €`;
  document.querySelector("#late-summary").textContent = `${formatMoney(late)} €`;
  document.querySelector("#upcoming-summary").textContent = `${formatMoney(outstanding - late)} €`;
  document.querySelector("#home-collected").textContent = `${formatMoney(collected)} €`;
  document.querySelector("#home-available").textContent = `${formatMoney(collected)} €`;
  document.querySelector("#cash-balance").textContent = `${formatMoney(collected, 2)} €`;
  document.querySelector("#cash-in").textContent = `+ ${formatMoney(collected)} €`;
  document.querySelector("#cash-updated").textContent = state.payments.length ? "Mis à jour après le dernier paiement en espèces" : "Aucune opération enregistrée";
  document.querySelector("#admin-cash-total").textContent = `${formatMoney(collected)} €`;
  document.querySelector("#admin-payment-count").textContent = state.payments.length;
  document.querySelector("#admin-payment-count").nextElementSibling.textContent = state.payments.length ? `${state.payments.length} opération${state.payments.length > 1 ? "s" : ""}` : "Historique vide";
}

function renderAll() {
  renderHomeContributions();
  renderDetailedContributions();
  renderTransactions();
  renderActivities();
  renderAdminPayments();
  renderPaymentOptions();
  renderSummaries();
  document.querySelector("#slow-speech-toggle").checked = state.settings.slowSpeech;
}

function navigate(page) {
  if (!document.querySelector(`[data-page="${page}"]`)) return;
  closeSheets();
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("active", element.dataset.page === page));
  document.querySelectorAll(".bottom-nav [data-nav]").forEach((button) => button.classList.toggle("active", button.dataset.nav === page));
  document.querySelector("#app").classList.toggle("admin-mode", page === "gestion");
  document.querySelector("#main-content").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openSheet(id) {
  document.querySelectorAll(".bottom-sheet, .center-modal").forEach((sheet) => sheet.classList.add("hidden"));
  document.querySelector("#modal-backdrop").classList.remove("hidden");
  document.querySelector(`#${id}`).classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeSheets() {
  stopListening();
  document.querySelectorAll(".bottom-sheet, .center-modal").forEach((sheet) => sheet.classList.add("hidden"));
  document.querySelector("#modal-backdrop").classList.add("hidden");
  document.body.style.overflow = "";
}

function summarySpeech() {
  const outstanding = outstandingTotal();
  const late = state.contributions.filter((item) => contributionStatus(item) === "late");
  const paid = totalCollected();
  if (!outstanding && !paid) return "Vous n'avez aucune échéance enregistrée et aucun retard. Aucun paiement en espèces n'est encore enregistré dans la caisse famille ou la caisse décès.";
  let text = `Vous avez versé ${formatMoney(paid)} euros au total. Il vous reste ${formatMoney(outstanding)} euros à payer.`;
  text += late.length ? ` Vous avez ${late.length} cotisation en retard.` : " Vous n'avez aucun retard.";
  return text;
}

function contributionsSpeech() {
  const details = state.contributions.map((item) => {
    const remaining = Math.max(0, item.amount - item.paid);
    if (!item.paid && !remaining) return `${item.name} : aucune échéance et aucun versement enregistré`;
    return `${item.name} : ${formatMoney(item.paid)} euros versés${remaining ? `, et ${formatMoney(remaining)} euros restant à payer` : ""}`;
  }).join(". ");
  return `Voici votre situation. ${details}.`;
}

function fundSpeech() {
  return `Les deux caisses contiennent ${formatMoney(totalCollected())} euros enregistrés en espèces. Il n'y a aucune dépense enregistrée.`;
}

function speak(text) {
  if (!("speechSynthesis" in window)) {
    showToast("La lecture vocale n’est pas disponible sur ce navigateur.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "fr-FR";
  utterance.rate = state.settings.slowSpeech ? 0.82 : 1;
  const frenchVoice = window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("fr"));
  if (frenchVoice) utterance.voice = frenchVoice;
  window.speechSynthesis.speak(utterance);
}

function startListening() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setVoiceMessage("Votre situation", summarySpeech());
    speak(summarySpeech());
    return;
  }
  stopListening();
  recognition = new Recognition();
  recognition.lang = "fr-FR";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => setListeningState(true, "Je vous écoute…", "Demandez simplement : où en suis-je ?");
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    setListeningState(false, "Votre situation", `Vous avez demandé : « ${transcript} ». ${summarySpeech()}`);
    speak(summarySpeech());
  };
  recognition.onerror = (event) => {
    const message = event.error === "not-allowed" ? "Le micro n’est pas autorisé. Touchez Mon résumé pour écouter votre situation." : "Je n’ai pas entendu la question. Voici votre situation.";
    setListeningState(false, "Consultation vocale", message);
    speak(summarySpeech());
  };
  recognition.onend = () => setListeningState(false);
  try { recognition.start(); } catch (error) { console.warn(error); }
}

function stopListening() {
  if (recognition) {
    recognition.onend = null;
    try { recognition.stop(); } catch (error) { console.warn(error); }
    recognition = null;
  }
  setListeningState(false);
}

function setListeningState(active, title, detail) {
  document.querySelector("#big-mic")?.classList.toggle("listening", active);
  document.querySelector("#voice-fab")?.classList.toggle("listening", active);
  if (title) document.querySelector("#voice-status").textContent = title;
  if (detail) document.querySelector("#voice-transcript").textContent = detail;
}

function setVoiceMessage(title, detail) {
  document.querySelector("#voice-status").textContent = title;
  document.querySelector("#voice-transcript").textContent = detail;
}

function executeVoiceCommand(command) {
  const text = command === "details" ? contributionsSpeech() : summarySpeech();
  setVoiceMessage(command === "details" ? "Vos deux caisses" : "Votre résumé", text);
  speak(text);
}

function recordCashPayment(event) {
  event.preventDefault();
  const contributionId = document.querySelector("#payment-contribution").value;
  const contribution = state.contributions.find(({ id }) => id === contributionId);
  const amount = Number(document.querySelector("#payment-amount").value);
  const dateValue = document.querySelector("#payment-date").value;
  const periodValue = document.querySelector("#payment-period").value;
  const note = document.querySelector("#payment-note").value.trim();
  if (!contribution || !Number.isFinite(amount) || amount <= 0 || !dateValue || !periodValue) return showToast("Vérifiez les informations du paiement.");

  const date = new Date(`${dateValue}T12:00:00`);
  const period = new Date(`${periodValue}-01T12:00:00`);
  const payment = {
    id: uid("cash"),
    member: "Membre connecté",
    contributionId,
    contribution: contribution.name,
    amount,
    method: "Espèces",
    date: dateValue,
    dateLabel: new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(date),
    period: periodValue,
    periodLabel: new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(period),
    note,
    recordedBy: "Personne habilitée"
  };

  state.payments.unshift(payment);
  contribution.paid += amount;
  contribution.status = contributionStatus(contribution);
  state.activities.unshift({
    id: uid("activity"),
    group: "Aujourd’hui",
    title: "Paiement en espèces enregistré",
    text: `${payment.member} • ${payment.contribution} • ${formatMoney(amount)} €`,
    time: `Enregistré par ${payment.recordedBy}`
  });
  saveState();
  renderAll();
  event.target.reset();
  setDefaultPaymentDates();
  closeSheets();
  openSheet("confirm-modal");
  speak(`Le paiement en espèces de ${formatMoney(amount)} euros pour ${contribution.name} est enregistré.`);
}

function setDefaultPaymentDates() {
  const now = new Date();
  document.querySelector("#payment-date").valueAsDate = now;
  document.querySelector("#payment-period").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function handleAction(action) {
  const messages = {
    "family-switch": "Espace familial actif : Ma famille.",
    notifications: state.activities.length ? `${state.activities.length} activité récente.` : "Aucune notification pour le moment.",
    documents: state.payments.length ? `${state.payments.length} reçu${state.payments.length > 1 ? "s" : ""} disponible${state.payments.length > 1 ? "s" : ""}.` : "Aucun reçu disponible pour le moment.",
    "admin-profile": "Accès réservé à une personne habilitée."
  };
  if (messages[action]) return showToast(messages[action]);
  if (action === "record-cash") return openSheet("payment-sheet");
  if (action === "open-voice") return openSheet("voice-sheet");
  if (action === "close-sheets" || action === "close-confirm") return closeSheets();
  if (action === "start-listening") return startListening();
  if (action === "install-app") return installApp();
}

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast("Sur iPhone : Partager, puis « Sur l’écran d’accueil ».");
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.querySelector("#install-card").classList.add("hidden");
}

function setupEvents() {
  document.addEventListener("click", (event) => {
    const navButton = event.target.closest("[data-nav]");
    if (navButton) return navigate(navButton.dataset.nav);
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) return handleAction(actionButton.dataset.action);
    const voiceButton = event.target.closest("[data-voice-command]");
    if (voiceButton) return executeVoiceCommand(voiceButton.dataset.voiceCommand);
    const speakButton = event.target.closest("[data-speak]");
    if (speakButton) {
      const speech = speakButton.dataset.speak === "contributions" ? contributionsSpeech() : speakButton.dataset.speak === "fund" ? fundSpeech() : summarySpeech();
      return speak(speech);
    }
  });
  document.querySelector("#modal-backdrop").addEventListener("click", closeSheets);
  document.querySelector("#payment-form").addEventListener("submit", recordCashPayment);
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderDetailedContributions();
  }));
  document.querySelector("#slow-speech-toggle").addEventListener("change", (event) => {
    state.settings.slowSpeech = event.target.checked;
    saveState();
    speak(event.target.checked ? "La parole lente est activée." : "La vitesse normale est activée.");
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSheets(); });
}

function setupPWA() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker non enregistré", error));
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    document.querySelector("#install-card").classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => showToast("Jàppoo est installé sur votre appareil."));
}

function boot() {
  const now = new Date();
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(now);
  setDefaultPaymentDates();
  renderAll();
  setupEvents();
  setupPWA();
  if (new URLSearchParams(location.search).get("action") === "voice") openSheet("voice-sheet");
}

boot();
