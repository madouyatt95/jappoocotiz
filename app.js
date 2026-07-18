const STORAGE_KEY = "jappo-cotiz-read-cache-v3";
const ALLOWED_CONTRIBUTIONS = ["family", "death"];
const AUTHORIZED_ROLES = ["admin", "treasurer", "cash_collector"];

const initialState = {
  settings: { slowSpeech: true },
  contributions: [
    { id: "family", name: "Caisse famille", description: "Cotisation familiale mensuelle", monthlyAmount: 5, startDate: "2021-01-01", dueDay: 10, amount: 0, paid: 0, due: null, missingMonths: 0, status: "unconfigured", icon: "family" },
    { id: "death", name: "Caisse décès", description: "Fonds de solidarité mensuel", monthlyAmount: 5, startDate: "2021-01-01", dueDay: 10, amount: 0, paid: 0, due: null, missingMonths: 0, status: "unconfigured", icon: "shield" }
  ],
  payments: [],
  activities: []
};

let state = loadState();
let currentFilter = "all";
let currentFundView = "family";
let cashFundView = "family";
let adminFundView = "family";
let paymentMonthCount = 1;
let deferredInstallPrompt = null;
let recognition = null;
let toastTimer = null;
let authMode = "member";
let workspace = null;
let backendSession = null;
let syncing = false;

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
      clean.activities = saved.activities.filter((activity) => activity.source === "supabase");
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
  // Cache de lecture uniquement : aucune écriture financière n'est validée localement.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  const payments = canRecordCash() ? state.payments.filter((payment) => canWriteFund(payment.contributionId)) : state.payments;
  return payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function personalCollected() {
  if (!workspace?.membership) return 0;
  return state.payments
    .filter((payment) => payment.memberId === workspace.membership.id)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
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
  if (item.amount > item.paid) return `${item.missingMonths || 0} mensualité${item.missingMonths === 1 ? "" : "s"} manquante${item.missingMonths === 1 ? "" : "s"} • reste ${formatMoney(item.amount - item.paid)} €`;
  if (item.paid > 0) return `${formatMoney(item.paid)} € versés en espèces`;
  return "Aucune échéance enregistrée";
}

function canRecordCash() {
  const member = workspace?.membership;
  return Boolean(
    member
    && member.active
    && member.approval_status === "approved"
    && member.access_level === "write"
    && AUTHORIZED_ROLES.includes(member.role)
  );
}

function writableFundCodes(member = workspace?.membership) {
  if (!member) return [];
  if (member.role === "admin" && member.approval_status === "approved") return ALLOWED_CONTRIBUTIONS.slice();
  return Array.from(new Set(member.write_fund_codes || [])).filter((code) => ALLOWED_CONTRIBUTIONS.includes(code));
}

function canWriteFund(code) {
  return canRecordCash() && writableFundCodes().includes(code);
}

function isAdministrator() {
  return Boolean(canRecordCash() && workspace.membership.role === "admin");
}

function approvedMembers() {
  return (workspace?.members || []).filter((member) => member.active && member.approval_status === "approved");
}

function roleLabel(role) {
  return ({ admin: "Administrateur", treasurer: "Trésorier", cash_collector: "Encaisseur", member: "Membre" })[role] || "Membre";
}

function accessLabel(member) {
  if (!member) return "Accès protégé";
  if (member.approval_status === "pending") return "En attente";
  if (member.approval_status === "rejected") return "Accès refusé";
  if (member.role === "admin") return "Administrateur • deux caisses";
  if (member.access_level !== "write") return "Lecture seule";
  const codes = writableFundCodes(member);
  if (codes.length === 2) return "Saisie • Famille + Décès";
  if (codes[0] === "family") return "Saisie • Caisse famille";
  if (codes[0] === "death") return "Saisie • Caisse décès";
  return "Lecture seule";
}

function initials(name) {
  const parts = String(name || "Utilisateur").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "UT";
}

function formatDate(value) {
  if (!value) return "Date inconnue";
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function formatPeriod(value) {
  if (!value) return "Période inconnue";
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(new Date(`${value.slice(0, 7)}-01T12:00:00`));
}

function periodsFor(memberId, fundId) {
  return (workspace?.periods || []).filter((period) => period.member_id === memberId && period.fund_id === fundId && !["exempt", "cancelled"].includes(period.status));
}

function fundSituation(memberId, fundId) {
  const periods = periodsFor(memberId, fundId);
  const amount = periods.reduce((sum, period) => sum + Number(period.amount_due || 0), 0);
  const paid = periods.reduce((sum, period) => sum + Number(period.amount_paid || 0), 0);
  const unpaid = periods.filter((period) => Number(period.amount_paid || 0) < Number(period.amount_due || 0));
  const late = unpaid.filter((period) => period.due_date && period.due_date < new Date().toISOString().slice(0, 10));
  return {
    amount,
    paid,
    outstanding: Math.max(0, amount - paid),
    missingMonths: unpaid.length,
    lateMonths: late.length,
    nextDue: unpaid.map((period) => period.due_date).filter(Boolean).sort()[0] || null
  };
}

function applyWorkspace(nextWorkspace) {
  workspace = nextWorkspace;
  if (!workspace?.membership) {
    state = cloneInitialState();
    return;
  }

  const memberNames = new Map((workspace.members || []).map((member) => [member.id, member.full_name]));
  memberNames.set(workspace.membership.id, workspace.membership.full_name);
  const fundById = new Map(workspace.funds.map((fund) => [fund.id, fund]));

  state.contributions = cloneInitialState().contributions.map((base) => {
    const fund = workspace.funds.find((item) => item.code === base.id);
    const situation = fund ? fundSituation(workspace.membership.id, fund.id) : { amount: 0, paid: 0, missingMonths: 0, lateMonths: 0, nextDue: null };
    return {
      ...base,
      backendId: fund?.id || null,
      name: fund?.name || base.name,
      description: fund?.description || base.description,
      monthlyAmount: Number(fund?.monthly_amount || base.monthlyAmount),
      startDate: fund?.start_date || base.startDate,
      dueDay: Number(fund?.due_day || base.dueDay),
      amount: situation.amount,
      paid: situation.paid,
      due: situation.nextDue,
      missingMonths: situation.missingMonths,
      status: situation.lateMonths ? "late" : situation.amount ? "due" : situation.paid ? "paid" : "unconfigured"
    };
  });

  state.payments = workspace.payments.map((payment) => {
    const fund = fundById.get(payment.fund_id);
    return {
      id: payment.id,
      memberId: payment.member_id,
      member: memberNames.get(payment.member_id) || "Membre",
      contributionId: fund?.code || "family",
      contribution: fund?.name || "Caisse",
      amount: Number(payment.amount || 0),
      method: "Espèces",
      date: payment.payment_date,
      dateLabel: formatDate(payment.payment_date),
      period: payment.period_start,
      periodLabel: formatPeriod(payment.period_start),
      note: payment.note || "",
      recordedBy: payment.recorded_by === workspace.user.id ? workspace.membership.full_name : "Responsable habilité"
    };
  });
  state.activities = (workspace.activityPayments || []).map((movement) => {
    const reversed = Boolean(movement.reversed_at);
    const movementDate = reversed ? String(movement.reversed_at).slice(0, 10) : movement.payment_date;
    const person = movement.member_name || "Mouvement familial";
    const responsible = reversed
      ? movement.reversed_by_name || "Responsable habilité"
      : movement.recorded_by_name || "Responsable habilité";
    return {
      id: `activity-${movement.payment_id}`,
      source: "supabase",
      group: movementDate === new Date().toISOString().slice(0, 10) ? "Aujourd’hui" : formatDate(movementDate),
      title: reversed ? "Paiement annulé" : "Paiement en espèces reçu",
      text: `${movement.fund_name || "Caisse"} • ${person} • ${reversed ? "−" : "+"} ${formatMoney(Number(movement.amount || 0))} €`,
      time: reversed ? `Annulé par ${responsible}` : `Enregistré par ${responsible}`,
      tone: reversed ? "expense" : "paid",
      reversed,
      amount: Number(movement.amount || 0)
    };
  });
  saveState();
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
  const filtered = state.contributions.filter((item) => item.id === currentFundView && (currentFilter === "all" || contributionStatus(item) === currentFilter));
  const container = document.querySelector("#detailed-contribution-list");
  if (!filtered.length) {
    container.innerHTML = '<div class="notice-card"><div><strong>Aucune cotisation dans cette catégorie</strong><p>Les échéances apparaîtront ici après leur configuration par un responsable.</p></div></div>';
    return;
  }
  container.innerHTML = filtered.map((item) => {
    const statusKey = contributionStatus(item);
    const status = statusConfig[statusKey];
    const progress = item.amount ? Math.min(100, (item.paid / item.amount) * 100) : 0;
    const progressMarkup = `<div class="partial-bar" aria-label="${Math.round(progress)} pour cent versé"><span style="width:${progress}%"></span></div>`;
    const fundPeriods = item.backendId && workspace?.membership ? periodsFor(workspace.membership.id, item.backendId).slice().sort((a, b) => b.period_start.localeCompare(a.period_start)).slice(0, 12) : [];
    const monthHistory = fundPeriods.length ? `<div class="month-history">${fundPeriods.map((period) => {
      const paid = Number(period.amount_paid || 0) >= Number(period.amount_due || 0);
      const partial = Number(period.amount_paid || 0) > 0 && !paid;
      return `<span class="${paid ? "paid" : partial ? "partial" : "late"}"><b>${formatPeriod(period.period_start).slice(0, 3)}</b><small>${String(period.period_start).slice(2, 4)}</small></span>`;
    }).join("")}</div>` : '<p class="empty-periods">Aucune mensualité générée pour ce membre.</p>';
    return `
      <article class="detail-card fund-detail-card">
        <div class="detail-card-main">
          <span class="contribution-icon ${status.tone}">${iconSVG(item.icon)}</span>
          <div class="contribution-copy"><strong>${escapeHTML(item.name)}</strong><small>${formatMoney(item.monthlyAmount)} € par mois depuis ${formatPeriod(item.startDate)}</small>${progressMarkup}</div>
          <div class="contribution-amount"><strong>${contributionAmountLabel(item)}</strong><em class="status-badge ${status.tone}">${status.label}</em></div>
        </div>
        <div class="fund-stat-grid"><div><small>Versé</small><strong>${formatMoney(item.paid)} €</strong></div><div><small>Reste</small><strong>${formatMoney(Math.max(0, item.amount - item.paid))} €</strong></div><div><small>Mois manquants</small><strong>${item.missingMonths || 0}</strong></div></div>
        ${monthHistory}
        <div class="detail-footer"><span>${escapeHTML(contributionDetail(item))}</span><span>Lecture seule</span></div>
      </article>`;
  }).join("");
}

function renderTransactions() {
  const container = document.querySelector("#transaction-list");
  const payments = state.payments.filter((payment) => payment.contributionId === cashFundView);
  if (!payments.length) {
    container.innerHTML = '<div class="empty-state"><span>₣</span><strong>Aucune opération</strong><p>Les paiements en espèces enregistrés apparaîtront ici.</p></div>';
    return;
  }
  container.innerHTML = payments.slice(0, 8).map((payment) => `
    <article class="transaction"><span class="transaction-icon in">↓</span><div><strong>${escapeHTML(payment.contribution)}</strong><small>${escapeHTML(payment.member)} • ${escapeHTML(payment.dateLabel)}</small></div><b class="money-in">+ ${formatMoney(payment.amount)} €</b></article>`).join("");
}

function renderFundAccount() {
  const fund = state.contributions.find((item) => item.id === cashFundView) || state.contributions[0];
  const fundPayments = state.payments.filter((payment) => payment.contributionId === fund.id);
  const collected = fundPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const shortcut = document.querySelector("#fund-config-shortcut");
  shortcut.dataset.editFund = fund.id;
  document.querySelector("#fund-config-shortcut-title").textContent = `Paramétrer ${fund.name}`;
  document.querySelector("#cash-balance").textContent = `${formatMoney(collected, 2)} €`;
  document.querySelector("#cash-in").textContent = `+ ${formatMoney(collected)} €`;
  document.querySelector("#cash-updated").textContent = fundPayments.length ? `${fundPayments.length} encaissement${fundPayments.length > 1 ? "s" : ""} en espèces` : "Aucune opération enregistrée";
  document.querySelector("#fund-period-card").innerHTML = `
    <div><span class="contribution-icon ${fund.id === "family" ? "green" : "indigo"}">${iconSVG(fund.icon)}</span><div><small>Caisse sélectionnée</small><strong>${escapeHTML(fund.name)}</strong></div></div>
    <div class="fund-config-facts"><span><small>Mensualité</small><b>${formatMoney(fund.monthlyAmount)} €</b></span><span><small>Depuis</small><b>${formatPeriod(fund.startDate)}</b></span><span><small>Échéance</small><b>Le ${fund.dueDay}</b></span></div>`;
}

function renderActivities() {
  const container = document.querySelector("#activity-list");
  const activePayments = state.activities.filter((item) => !item.reversed);
  const collected = activePayments.reduce((sum, item) => sum + item.amount, 0);
  document.querySelector("#activity-movement-count").textContent = String(state.activities.length);
  document.querySelector("#activity-collected-total").textContent = `${formatMoney(collected)} €`;
  document.querySelector("#activity-latest").textContent = state.activities[0]?.group || "Aucun mouvement";
  if (!state.activities.length) {
    container.innerHTML = '<div class="empty-state"><span>↕</span><strong>Aucun mouvement général</strong><p>Les prochains paiements réels de la famille seront tracés ici.</p></div>';
    return;
  }
  const grouped = state.activities.reduce((result, item) => {
    (result[item.group] ||= []).push(item);
    return result;
  }, {});
  container.innerHTML = Object.entries(grouped).map(([group, activities]) => `
    <section class="timeline-group"><h2>${escapeHTML(group)}</h2>${activities.map((item) => `
      <article class="timeline-item"><span class="timeline-dot ${item.tone}">${item.reversed ? "−" : "+"}</span><div class="timeline-content"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.text)}</p><time>${escapeHTML(item.time)}</time></div></article>`).join("")}</section>`).join("");
}

function renderAdminPayments() {
  const container = document.querySelector("#admin-cash-payments");
  const writablePayments = state.payments.filter((payment) => canWriteFund(payment.contributionId));
  if (!writablePayments.length) {
    container.innerHTML = '<div class="notice-card"><span class="feature-icon green">✓</span><div><strong>Aucun paiement enregistré</strong><p>La liste est vide et ne contient aucune donnée de démonstration.</p></div></div>';
    return;
  }
  container.innerHTML = writablePayments.slice(0, 6).map((payment) => `
    <article class="pending-card cash-payment-card">
      <div class="pending-main"><span class="member-avatar">MC</span><div><strong>${escapeHTML(payment.member)}</strong><small>${escapeHTML(payment.contribution)} • Espèces • ${escapeHTML(payment.periodLabel)}</small></div><div class="pending-amount"><b>${formatMoney(payment.amount)} €</b><time>${escapeHTML(payment.dateLabel)}</time></div></div>
      <div class="pending-proof">${iconSVG("receipt")}<span>Enregistré par ${escapeHTML(payment.recordedBy)}</span></div>
    </article>`).join("");
}

function renderMemberStatuses() {
  const container = document.querySelector("#member-status-list");
  const members = approvedMembers();
  if (!canRecordCash() || !members.length) {
    container.innerHTML = '<div class="empty-state compact-empty"><span>👥</span><strong>Aucun membre</strong><p>Les membres rattachés apparaîtront ici.</p></div>';
    return;
  }
  if (!canWriteFund(adminFundView)) adminFundView = writableFundCodes()[0] || "family";
  const fund = workspace.funds.find((item) => item.code === adminFundView && canWriteFund(item.code));
  if (!fund) return;
  container.innerHTML = members.map((member) => {
    const situation = fundSituation(member.id, fund.id);
    const upToDate = situation.outstanding <= 0;
    return `<article class="member-status-row">
      <span class="member-avatar">${initials(member.full_name)}</span>
      <div><strong>${escapeHTML(member.full_name)}</strong><small>${upToDate ? "À jour" : `${situation.missingMonths} mois manquant${situation.missingMonths > 1 ? "s" : ""}`}</small></div>
      <div class="member-due ${upToDate ? "paid" : "late"}"><b>${formatMoney(situation.outstanding)} €</b><small>${upToDate ? "Payé" : "À encaisser"}</small></div>
    </article>`;
  }).join("");
}

function renderMemberAccess() {
  const section = document.querySelector("#member-access-section");
  const container = document.querySelector("#member-access-list");
  section.classList.toggle("hidden", !isAdministrator());
  if (!isAdministrator()) {
    container.innerHTML = "";
    return;
  }

  const members = (workspace.members || []).slice().sort((a, b) => {
    const rank = { pending: 0, approved: 1, rejected: 2 };
    return (rank[a.approval_status] ?? 3) - (rank[b.approval_status] ?? 3)
      || String(a.full_name).localeCompare(String(b.full_name), "fr");
  });
  const pendingCount = members.filter((member) => member.approval_status === "pending").length;
  document.querySelector("#pending-member-count").textContent = String(pendingCount);

  if (!members.length) {
    container.innerHTML = '<div class="empty-state compact-empty"><span>✓</span><strong>Aucune demande</strong></div>';
    return;
  }

  container.innerHTML = members.map((member) => {
    const pending = member.approval_status === "pending";
    const rejected = member.approval_status === "rejected";
    const protectedAdmin = member.role === "admin" && member.approval_status === "approved";
    const status = pending ? "En attente de validation" : rejected ? "Accès refusé" : accessLabel(member);
    const identity = member.pseudo ? `${member.full_name} • @${member.pseudo}` : member.full_name;
    const memberCodes = writableFundCodes(member).slice().sort().join(",");
    const controls = protectedAdmin
      ? '<span class="protected-access">Écriture permanente sur les deux caisses</span>'
      : `<div class="access-choice" role="group" aria-label="Droits de ${escapeHTML(member.full_name)}">
          <button class="${!pending && !rejected && member.access_level === "read" ? "active" : ""}" type="button" data-review-member="${member.id}" data-access-level="read" data-write-funds="">Lecture seule</button>
          <button class="${!pending && !rejected && member.access_level === "write" && memberCodes === "family" ? "active" : ""}" type="button" data-review-member="${member.id}" data-access-level="write" data-write-funds="family">Famille</button>
          <button class="${!pending && !rejected && member.access_level === "write" && memberCodes === "death" ? "active" : ""}" type="button" data-review-member="${member.id}" data-access-level="write" data-write-funds="death">Décès</button>
          <button class="${!pending && !rejected && member.access_level === "write" && memberCodes === "death,family" ? "active" : ""}" type="button" data-review-member="${member.id}" data-access-level="write" data-write-funds="family,death">Les deux</button>
        </div>
        ${!pending && !rejected && member.pseudo ? `<button class="reset-code-button" type="button" data-reset-member-code="${member.id}">Créer un nouveau code</button>` : ""}
        ${pending ? `<button class="reject-access" type="button" data-reject-member="${member.id}">Refuser</button>` : ""}`;
    return `<article class="access-member-card ${pending ? "pending" : rejected ? "rejected" : "approved"}">
      <div class="access-member-head"><span class="member-avatar">${initials(member.full_name)}</span><div><strong>${escapeHTML(identity)}</strong><small>${escapeHTML(status)}</small></div><em>${pending ? "Nouveau" : rejected ? "Refusé" : "Validé"}</em></div>
      <div class="access-member-controls">${controls}${protectedAdmin ? "" : `<button class="delete-member-button" type="button" data-delete-member="${member.id}">Supprimer le membre et ses transactions</button>`}</div>
    </article>`;
  }).join("");
}

function renderFundSettings() {
  const container = document.querySelector("#fund-settings-list");
  if (!workspace?.funds?.length) {
    container.innerHTML = '<div class="empty-state compact-empty"><span>⚙</span><strong>Caisses non synchronisées</strong></div>';
    return;
  }
  container.innerHTML = workspace.funds.map((fund) => `
    <article class="fund-setting-row">
      <span class="contribution-icon ${fund.code === "family" ? "green" : "indigo"}">${iconSVG(fund.code === "family" ? "family" : "shield")}</span>
      <div><strong>${escapeHTML(fund.name)}</strong><small>${formatMoney(Number(fund.monthly_amount))} € / mois • depuis ${formatPeriod(fund.start_date)}</small></div>
      ${workspace.membership.role === "admin" ? `<button type="button" data-edit-fund="${escapeHTML(fund.code)}" aria-label="Modifier ${escapeHTML(fund.name)}">Modifier</button>` : ""}
    </article>`).join("");
}

function renderPaymentOptions() {
  const previousFund = document.querySelector("#payment-contribution").value || currentFundView;
  const previousMember = document.querySelector("#payment-member").value;
  document.querySelector("#payment-contribution").innerHTML = state.contributions
    .filter((item) => item.backendId && canWriteFund(item.id))
    .map((item) => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join("");
  const members = canRecordCash() ? approvedMembers() : [];
  document.querySelector("#payment-member").innerHTML = members.length
    ? members.map((member) => `<option value="${escapeHTML(member.id)}">${escapeHTML(member.full_name)}</option>`).join("")
    : '<option value="">Aucun membre disponible</option>';
  if (members.some((member) => member.id === previousMember)) document.querySelector("#payment-member").value = previousMember;
  const writableContributions = state.contributions.filter((item) => item.backendId && canWriteFund(item.id));
  document.querySelector("#payment-contribution").value = writableContributions.some((item) => item.id === previousFund) ? previousFund : writableContributions[0]?.id || "";
  document.querySelector("#quick-fund-grid").innerHTML = writableContributions.map((item) => `
    <button class="${document.querySelector("#payment-contribution").value === item.id ? "active" : ""}" type="button" data-quick-fund="${item.id}">
      <span class="contribution-icon ${item.id === "family" ? "green" : "indigo"}">${iconSVG(item.icon)}</span><strong>${escapeHTML(item.name)}</strong><small>${formatMoney(item.monthlyAmount)} € / mois</small>
    </button>`).join("");
  updateQuickPaymentSummary();
}

function currentMonthValue() {
  return new Date().toISOString().slice(0, 7);
}

function scheduleFor(memberId, fundId) {
  return (workspace?.schedules || []).find((schedule) => schedule.member_id === memberId && schedule.fund_id === fundId);
}

function updateSchedulePreview() {
  const memberId = document.querySelector("#schedule-member")?.value;
  const fundId = document.querySelector("#schedule-fund")?.value;
  const start = document.querySelector("#schedule-start")?.value;
  const end = document.querySelector("#schedule-end")?.value;
  const member = approvedMembers().find((item) => item.id === memberId);
  const fund = workspace?.funds?.find((item) => item.id === fundId);
  const preview = document.querySelector("#schedule-preview");
  if (!preview) return;
  if (!member || !fund || !start || !end || start < "2021-01" || start > end || end > currentMonthValue()) {
    preview.innerHTML = "<span>Période</span><strong>Sélectionnez une période valide</strong><small>Du mois de début au mois de fin inclus.</small>";
    return;
  }
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const count = (endYear - startYear) * 12 + endMonth - startMonth + 1;
  preview.innerHTML = `<span>${escapeHTML(member.full_name)} • ${escapeHTML(fund.name)}</span><strong>${count} mensualité${count > 1 ? "s" : ""} • ${formatMoney(count * Number(fund.monthly_amount))} € dus</strong><small>${formatPeriod(start)} à ${formatPeriod(end)} inclus • paiements existants conservés</small>`;
}

function hydrateScheduleForm() {
  const memberId = document.querySelector("#schedule-member")?.value;
  const fundId = document.querySelector("#schedule-fund")?.value;
  const member = approvedMembers().find((item) => item.id === memberId);
  const fund = workspace?.funds?.find((item) => item.id === fundId);
  if (!member || !fund) return updateSchedulePreview();
  const existing = scheduleFor(memberId, fundId);
  const defaultStart = ["2021-01", String(fund.start_date || "2021-01").slice(0, 7), String(member.joined_on || "2021-01").slice(0, 7)].sort().at(-1);
  document.querySelector("#schedule-start").max = currentMonthValue();
  document.querySelector("#schedule-end").max = currentMonthValue();
  document.querySelector("#schedule-start").value = existing ? String(existing.start_month).slice(0, 7) : defaultStart;
  document.querySelector("#schedule-end").value = existing ? String(existing.end_month).slice(0, 7) : currentMonthValue();
  updateSchedulePreview();
}

function renderScheduleOptions() {
  const section = document.querySelector("#member-schedule-section");
  section.classList.toggle("hidden", !canRecordCash());
  if (!canRecordCash()) return;
  const memberSelect = document.querySelector("#schedule-member");
  const fundSelect = document.querySelector("#schedule-fund");
  const previousMember = memberSelect.value;
  const previousFund = fundSelect.value;
  const members = approvedMembers();
  const funds = (workspace?.funds || []).filter((fund) => canWriteFund(fund.code));
  memberSelect.innerHTML = members.map((member) => `<option value="${escapeHTML(member.id)}">${escapeHTML(member.full_name)}</option>`).join("");
  fundSelect.innerHTML = funds.map((fund) => `<option value="${escapeHTML(fund.id)}">${escapeHTML(fund.name)}</option>`).join("");
  if (members.some((member) => member.id === previousMember)) memberSelect.value = previousMember;
  if (funds.some((fund) => fund.id === previousFund)) fundSelect.value = previousFund;
  hydrateScheduleForm();
}

function paymentAllocationFor(memberId, fundId, amount) {
  const unpaidPeriods = periodsFor(memberId, fundId)
    .filter((period) => Number(period.amount_paid || 0) < Number(period.amount_due || 0))
    .sort((a, b) => String(a.period_start).localeCompare(String(b.period_start)));
  const outstanding = unpaidPeriods.reduce((sum, period) => sum + Math.max(0, Number(period.amount_due || 0) - Number(period.amount_paid || 0)), 0);
  let remaining = Math.max(0, Number(amount) || 0);
  const touched = [];
  let settledMonths = 0;

  unpaidPeriods.forEach((period) => {
    if (remaining <= 0) return;
    const periodRemaining = Math.max(0, Number(period.amount_due || 0) - Number(period.amount_paid || 0));
    const applied = Math.min(remaining, periodRemaining);
    if (applied <= 0) return;
    const complete = applied >= periodRemaining - 0.001;
    touched.push({ period, applied, complete });
    if (complete) settledMonths += 1;
    remaining -= applied;
  });

  return {
    outstanding,
    settledMonths,
    touched,
    partialMonth: touched.some((item) => !item.complete),
    overpayment: Math.max(0, Number(amount || 0) - outstanding),
    remainingAfter: Math.max(0, outstanding - Number(amount || 0))
  };
}

function updatePaymentAllocationPreview({ syncChips = false } = {}) {
  const memberId = document.querySelector("#payment-member")?.value;
  const code = document.querySelector("#payment-contribution")?.value;
  const fund = workspace?.funds?.find((item) => item.code === code);
  const amount = Number(document.querySelector("#payment-amount")?.value);
  const preview = document.querySelector("#payment-allocation-preview");
  if (!preview) return null;

  preview.classList.remove("error");
  if (!memberId || !fund) {
    preview.innerHTML = "<span>Affectation automatique</span><strong>Sélectionnez un membre et une caisse</strong><small>Les arriérés seront régularisés du mois le plus ancien au plus récent.</small>";
    return null;
  }

  const allocation = paymentAllocationFor(memberId, fund.id, amount);
  if (syncChips) {
    const suggestions = { "1": Number(fund.monthly_amount), "3": Number(fund.monthly_amount) * 3, "6": Number(fund.monthly_amount) * 6, all: allocation.outstanding };
    document.querySelectorAll("[data-month-count]").forEach((button) => {
      button.classList.toggle("active", Number.isFinite(amount) && Math.abs(amount - suggestions[button.dataset.monthCount]) < 0.001);
    });
  }

  if (!allocation.outstanding) {
    preview.innerHTML = "<span>Affectation automatique</span><strong>Ce membre est à jour</strong><small>Définissez une période plus longue si de nouvelles mensualités doivent être dues.</small>";
    return allocation;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    preview.innerHTML = `<span>Affectation automatique</span><strong>Saisissez un montant</strong><small>${allocation.touched.length ? "" : "Les arriérés seront régularisés du mois le plus ancien au plus récent."}</small>`;
    return allocation;
  }
  if (allocation.overpayment > 0.001) {
    preview.classList.add("error");
    preview.innerHTML = `<span>Montant à corriger</span><strong>${formatMoney(allocation.overpayment)} € dépassent le reste dû</strong><small>Montant maximum accepté : ${formatMoney(allocation.outstanding)} €.</small>`;
    return allocation;
  }

  const first = allocation.touched[0]?.period;
  const last = allocation.touched.at(-1)?.period;
  const settledLabel = allocation.settledMonths
    ? `${allocation.settledMonths} mensualité${allocation.settledMonths > 1 ? "s" : ""} régularisée${allocation.settledMonths > 1 ? "s" : ""}${allocation.partialMonth ? " + 1 mois partiel" : ""}`
    : `Paiement partiel sur ${formatPeriod(first?.period_start)}`;
  const range = first && last
    ? first.id === last.id ? formatPeriod(first.period_start) : `${formatPeriod(first.period_start)} → ${formatPeriod(last.period_start)}`
    : "Aucune échéance couverte";
  preview.innerHTML = `<span>Affectation automatique • arriérés d’abord</span><strong>${settledLabel}</strong><small>${range} • reste après paiement : ${formatMoney(allocation.remainingAfter)} €</small>`;
  return allocation;
}

function updateQuickPaymentSummary({ setSuggestedAmount = true } = {}) {
  const memberId = document.querySelector("#payment-member")?.value;
  const code = document.querySelector("#payment-contribution")?.value;
  const fund = workspace?.funds?.find((item) => item.code === code);
  const summary = document.querySelector("#quick-payment-summary");
  if (!summary) return;
  const situation = memberId && fund ? fundSituation(memberId, fund.id) : null;
  const amount = situation ? Math.min(situation.outstanding, Number(fund.monthly_amount) * paymentMonthCount) : 0;
  if (setSuggestedAmount) document.querySelector("#payment-amount").value = amount > 0 ? amount.toFixed(2) : "";
  summary.innerHTML = situation
    ? `<span>Reste à payer</span><strong>${formatMoney(situation.outstanding)} €</strong><small>${situation.missingMonths} mensualité${situation.missingMonths === 1 ? "" : "s"} manquante${situation.missingMonths === 1 ? "" : "s"} • ${formatMoney(Number(fund.monthly_amount))} € / mois</small>`
    : '<span>Reste à payer</span><strong>0 €</strong><small>Sélectionnez un membre et une caisse</small>';
  updatePaymentAllocationPreview();
}

function renderIdentity() {
  const connected = Boolean(backendSession && workspace?.user);
  const member = workspace?.membership;
  const approved = Boolean(member?.active && member.approval_status === "approved");
  const displayName = member?.full_name || workspace?.user?.email || "Non connecté";
  document.querySelector("#profile-name").textContent = displayName;
  document.querySelector("#profile-avatar").textContent = initials(displayName);
  document.querySelector("#profile-meta").textContent = approved
    ? `${workspace.family?.name || "Ma famille"} • Données synchronisées`
    : member?.approval_status === "pending"
      ? "Compte créé • validation administrateur en attente"
      : member?.approval_status === "rejected"
        ? "Accès familial refusé par un administrateur"
    : connected ? "Compte connecté, accès familial non attribué" : "Connectez-vous pour voir votre situation réelle";
  document.querySelector("#profile-role").textContent = accessLabel(member);
  document.querySelector("#auth-button").textContent = connected ? "Se déconnecter" : "Se connecter";
  document.querySelector("#quick-payment-fab").classList.toggle("hidden", !canRecordCash());
  document.querySelector("#admin-password-section").classList.toggle("hidden", !isAdministrator());
  document.querySelector("#fund-config-shortcut").classList.toggle("hidden", !isAdministrator());
  const allowedCodes = writableFundCodes();
  document.querySelectorAll("[data-admin-fund]").forEach((button) => button.classList.toggle("hidden", !allowedCodes.includes(button.dataset.adminFund)));
  if (!allowedCodes.includes(adminFundView)) adminFundView = allowedCodes[0] || "family";
  document.querySelector("#admin-pill-label").textContent = canRecordCash() ? "Gestion" : member?.approval_status === "pending" ? "En attente" : connected ? "Accès" : "Connexion";
  document.querySelector("#admin-role-label").textContent = member ? `${accessLabel(member)} • ${member.full_name}` : "Personne habilitée";
  document.querySelector("#home-collected-label").textContent = canRecordCash() ? "Collecté en espèces" : "Mes versements";
  document.querySelector("#home-available-label").textContent = canRecordCash() ? "Disponible" : "Enregistrés";
  document.querySelector("#cash-balance-label").textContent = canRecordCash() ? "Solde disponible" : "Mes versements enregistrés";
  document.querySelector("#cash-in-label").textContent = canRecordCash() ? "Entrées en espèces" : "Mes entrées en espèces";
  document.querySelector("#cash-privacy-label").lastChild.textContent = canRecordCash() ? "Vue gestion" : "Vue personnelle";

  const title = document.querySelector("#sync-status-title");
  const detail = document.querySelector("#sync-status-detail");
  const banner = document.querySelector("#sync-banner");
  banner.classList.toggle("synced", approved);
  banner.classList.toggle("warning", connected && !approved);
  if (syncing) {
    title.textContent = "Synchronisation…";
    detail.textContent = "Lecture sécurisée des données Supabase.";
  } else if (approved) {
    title.textContent = "Données Supabase synchronisées";
    detail.textContent = `${workspace.family?.name || "Ma famille"} • ${accessLabel(member)}`;
  } else if (member?.approval_status === "pending") {
    title.textContent = "Compte en attente de validation";
    detail.textContent = "Un administrateur doit choisir vos droits avant tout accès.";
  } else if (member?.approval_status === "rejected") {
    title.textContent = "Accès familial refusé";
    detail.textContent = "Contactez un administrateur de la famille.";
  } else if (connected) {
    title.textContent = "Création de la demande…";
    detail.textContent = "Actualisez dans quelques instants pour voir son statut.";
  } else {
    title.textContent = "Connexion requise";
    detail.textContent = "Connectez-vous pour consulter vos données Supabase.";
  }
}

function renderSummaries() {
  const cashCollected = totalCollected();
  const writablePaymentCount = state.payments.filter((payment) => canWriteFund(payment.contributionId)).length;
  const outstanding = outstandingTotal();
  const paidFunds = state.contributions.filter((item) => item.paid > 0).length;
  const late = state.contributions.filter((item) => contributionStatus(item) === "late").reduce((sum, item) => sum + Math.max(0, item.amount - item.paid), 0);
  const selected = state.contributions.find((item) => item.id === currentFundView) || state.contributions[0];
  const selectedRemaining = Math.max(0, selected.amount - selected.paid);
  const selectedLate = contributionStatus(selected) === "late" ? selectedRemaining : 0;

  document.querySelector("#balance-total").textContent = formatMoney(outstanding);
  document.querySelector("#welcome-status-text").textContent = late ? `${formatMoney(late)} € en retard` : "Aucune échéance en retard";
  document.querySelector("#progress-label").textContent = `${paidFunds}/2`;
  document.querySelector(".month-progress").setAttribute("aria-label", `${paidFunds} caisse sur 2 avec un versement enregistré`);
  document.querySelector(".month-progress .progress-value").style.strokeDasharray = `${Math.round((paidFunds / 2) * 145)} 145`;
  document.querySelector("#paid-summary").textContent = `${formatMoney(selected.paid)} €`;
  document.querySelector("#late-summary").textContent = `${formatMoney(selectedLate)} €`;
  document.querySelector("#upcoming-summary").textContent = `${formatMoney(selectedRemaining - selectedLate)} €`;
  document.querySelector("#home-collected").textContent = `${formatMoney(cashCollected)} €`;
  document.querySelector("#home-available").textContent = `${formatMoney(cashCollected)} €`;
  document.querySelector("#admin-cash-total").textContent = `${formatMoney(cashCollected)} €`;
  document.querySelector("#admin-payment-count").textContent = writablePaymentCount;
  document.querySelector("#admin-payment-count").nextElementSibling.textContent = writablePaymentCount ? `${writablePaymentCount} opération${writablePaymentCount > 1 ? "s" : ""}` : "Historique vide";
}

function renderAll() {
  renderHomeContributions();
  renderDetailedContributions();
  renderTransactions();
  renderFundAccount();
  renderActivities();
  renderAdminPayments();
  renderMemberAccess();
  renderMemberStatuses();
  renderFundSettings();
  renderPaymentOptions();
  renderScheduleOptions();
  renderSummaries();
  renderIdentity();
  document.querySelector("#slow-speech-toggle").checked = state.settings.slowSpeech;
}

function navigate(page) {
  if (!document.querySelector(`[data-page="${page}"]`)) return;
  if (page === "gestion" && !canRecordCash()) {
    if (!backendSession) openSheet("auth-sheet");
    else if (workspace?.membership?.approval_status === "pending") showToast("Ce compte attend encore la validation d’un administrateur.");
    else showToast("Ce compte dispose uniquement d’un accès en lecture.");
    return;
  }
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
  const paid = personalCollected();
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
  if (canRecordCash()) return `Les deux caisses contiennent ${formatMoney(totalCollected())} euros enregistrés en espèces. Il n'y a aucune dépense enregistrée.`;
  return `Vos versements en espèces dans les deux caisses totalisent ${formatMoney(personalCollected())} euros.`;
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

function openQuickPayment() {
  if (!canRecordCash()) return showToast("Autorisation Supabase insuffisante.");
  paymentMonthCount = 1;
  document.querySelectorAll("[data-month-count]").forEach((button) => button.classList.toggle("active", button.dataset.monthCount === "1"));
  const preferredFund = state.contributions.find((item) => item.id === adminFundView && item.backendId && canWriteFund(item.id))
    ? adminFundView
    : state.contributions.find((item) => item.backendId && canWriteFund(item.id))?.id;
  if (preferredFund) document.querySelector("#payment-contribution").value = preferredFund;
  document.querySelectorAll("[data-quick-fund]").forEach((button) => button.classList.toggle("active", button.dataset.quickFund === preferredFund));
  setDefaultPaymentDates();
  updateQuickPaymentSummary();
  openSheet("payment-sheet");
}

function openFundConfig(code) {
  if (workspace?.membership?.role !== "admin") return showToast("Seul un administrateur peut modifier une caisse.");
  const fund = workspace.funds.find((item) => item.code === code);
  if (!fund) return;
  document.querySelector("#fund-config-id").value = fund.id;
  document.querySelector("#fund-config-name").value = fund.name;
  document.querySelector("#fund-config-description").value = fund.description || "";
  document.querySelector("#fund-config-amount").value = Number(fund.monthly_amount).toFixed(2);
  document.querySelector("#fund-config-day").value = fund.due_day;
  document.querySelector("#fund-config-start").value = String(fund.start_date).slice(0, 7);
  document.querySelector("#fund-config-title").textContent = `Configurer ${fund.name}`;
  openSheet("fund-config-sheet");
}

async function submitFundConfiguration(event) {
  event.preventDefault();
  if (workspace?.membership?.role !== "admin") return showToast("Autorisation administrateur requise.");
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Mise à jour des mensualités…";
  try {
    await window.JappoBackend.configureFund({
      p_fund_id: document.querySelector("#fund-config-id").value,
      p_name: document.querySelector("#fund-config-name").value.trim(),
      p_description: document.querySelector("#fund-config-description").value.trim(),
      p_monthly_amount: Number(document.querySelector("#fund-config-amount").value),
      p_start_date: `${document.querySelector("#fund-config-start").value}-01`,
      p_due_day: Number(document.querySelector("#fund-config-day").value)
    });
    await syncFromBackend({ quiet: true });
    closeSheets();
    showToast("Configuration enregistrée et mensualités recalculées.");
  } catch (error) {
    showToast(error.message || "La caisse n’a pas pu être modifiée.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Enregistrer la configuration";
  }
}

async function reviewMemberAccess(memberId, decision, level, writeFunds, trigger) {
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const member = workspace.members.find((item) => item.id === memberId);
  if (!member) return showToast("Compte introuvable.");
  const card = trigger.closest(".access-member-card");
  card?.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const reviewResult = await window.JappoBackend.reviewMemberAccess({
      p_member_id: memberId,
      p_decision: decision,
      p_access_level: level,
      p_write_fund_codes: writeFunds
    });
    await syncFromBackend({ quiet: true });
    if (decision === "reject") {
      showToast(`Accès refusé pour ${member.full_name}.`);
    } else if (reviewResult?.access_code) {
      showMemberCode(member.full_name, reviewResult.access_code);
    } else {
      const scope = writeFunds.length === 2 ? "les deux caisses" : writeFunds[0] === "family" ? "la caisse famille" : "la caisse décès";
      showToast(`${member.full_name} : ${level === "write" ? `saisie autorisée sur ${scope}` : "lecture seule autorisée"}.`);
    }
  } catch (error) {
    showToast(error.message || "Les droits n’ont pas pu être modifiés.");
    card?.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

function showMemberCode(memberName, code) {
  document.querySelector("#member-code-message").textContent = `Communiquez ce code à ${memberName}. Il servira avec son pseudo.`;
  document.querySelector("#member-access-code").textContent = code;
  openSheet("member-code-modal");
}

async function resetMemberLoginCode(memberId, trigger) {
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const member = workspace.members.find((item) => item.id === memberId);
  if (!member?.pseudo) return showToast("Ce compte ne se connecte pas par pseudo.");
  trigger.disabled = true;
  try {
    const code = await window.JappoBackend.resetMemberLoginCode(memberId);
    showMemberCode(member.full_name, code);
  } catch (error) {
    showToast(error.message || "Le code n’a pas pu être recréé.");
  } finally {
    trigger.disabled = false;
  }
}

function openDeleteMember(memberId) {
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const member = workspace?.members?.find((item) => item.id === memberId);
  if (!member || member.role === "admin") return showToast("Ce membre ne peut pas être supprimé.");
  document.querySelector("#delete-member-id").value = member.id;
  document.querySelector("#delete-member-confirmation").value = "";
  document.querySelector("#delete-member-message").textContent = `La fiche de ${member.full_name}, ses mensualités et tous les paiements qui lui sont attribués seront supprimés définitivement.`;
  document.querySelector("#delete-member-label").textContent = `Saisissez exactement « ${member.full_name} » pour confirmer`;
  openSheet("delete-member-modal");
  document.querySelector("#delete-member-confirmation").focus({ preventScroll: true });
}

async function deleteFamilyMember(event) {
  event.preventDefault();
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const memberId = document.querySelector("#delete-member-id").value;
  const confirmation = document.querySelector("#delete-member-confirmation").value.trim();
  const member = workspace?.members?.find((item) => item.id === memberId);
  if (!member || confirmation.toLocaleLowerCase("fr") !== member.full_name.trim().toLocaleLowerCase("fr")) {
    return showToast("Le nom saisi ne correspond pas exactement au membre.");
  }

  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Suppression…";
  try {
    const result = await window.JappoBackend.deleteFamilyMember(memberId, confirmation);
    await syncFromBackend({ quiet: true });
    closeSheets();
    showToast(`${result?.member_name || member.full_name} et ses transactions ont été supprimés.`);
  } catch (error) {
    showToast(error.message || "Le membre n’a pas pu être supprimé.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Supprimer définitivement";
  }
}

async function copyMemberCode() {
  const code = document.querySelector("#member-access-code").textContent.trim();
  try {
    await navigator.clipboard.writeText(code);
    showToast("Code membre copié.");
  } catch {
    showToast(`Code membre : ${code}`);
  }
}

async function submitMemberSchedule(event) {
  event.preventDefault();
  if (!canRecordCash()) return showToast("Autorisation de saisie requise.");
  const memberId = document.querySelector("#schedule-member").value;
  const fundId = document.querySelector("#schedule-fund").value;
  const start = document.querySelector("#schedule-start").value;
  const end = document.querySelector("#schedule-end").value;
  const fund = workspace?.funds?.find((item) => item.id === fundId);
  if (!memberId || !fund || !canWriteFund(fund.code) || !start || !end || start < "2021-01" || start > end || end > currentMonthValue()) return showToast("Choisissez une période comprise entre janvier 2021 et le mois courant.");
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Calcul des mensualités…";
  try {
    await window.JappoBackend.setMemberFundSchedule({
      p_member_id: memberId,
      p_fund_id: fundId,
      p_start_month: `${start}-01`,
      p_end_month: `${end}-01`
    });
    await syncFromBackend({ quiet: true });
    showToast("Période enregistrée. Les arriérés ont été recalculés.");
  } catch (error) {
    showToast(error.message || "Les mensualités n’ont pas pu être calculées.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Calculer les mensualités dues";
  }
}

async function submitAdminPassword(event) {
  event.preventDefault();
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const password = document.querySelector("#admin-new-password").value;
  const confirmation = document.querySelector("#admin-confirm-password").value;
  if (password.length < 10) return showToast("Le mot de passe doit contenir au moins 10 caractères.");
  if (password !== confirmation) return showToast("Les deux mots de passe ne correspondent pas.");
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Enregistrement…";
  try {
    await window.JappoBackend.updatePassword(password);
    event.target.reset();
    showToast("Mot de passe enregistré. Vous pourrez vous connecter directement.");
  } catch (error) {
    showToast(error.message || "Le mot de passe n’a pas pu être enregistré.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Enregistrer mon mot de passe";
  }
}

async function recordCashPayment(event) {
  event.preventDefault();
  if (!canRecordCash() || !backendSession) return showToast("Autorisation Supabase insuffisante.");
  const contributionId = document.querySelector("#payment-contribution").value;
  const contribution = state.contributions.find(({ id }) => id === contributionId);
  const memberId = document.querySelector("#payment-member").value;
  const amount = Number(document.querySelector("#payment-amount").value);
  const dateValue = document.querySelector("#payment-date").value;
  const note = document.querySelector("#payment-note").value.trim();
  if (!contribution?.backendId || !canWriteFund(contributionId) || !memberId || !Number.isFinite(amount) || amount <= 0 || !dateValue) return showToast("Vérifiez vos droits et les informations du paiement.");
  const allocation = paymentAllocationFor(memberId, contribution.backendId, amount);
  if (!allocation.outstanding) return showToast("Définissez d’abord les mensualités dues pour ce membre et cette caisse.");
  if (allocation.overpayment > 0.001) return showToast(`Le montant maximum accepté est ${formatMoney(allocation.outstanding)} €.`);

  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Enregistrement sécurisé…";
  try {
    await window.JappoBackend.recordCashPayment({
      p_family_id: workspace.membership.family_id,
      p_fund_id: contribution.backendId,
      p_member_id: memberId,
      p_amount: amount,
      p_payment_date: dateValue,
      p_note: note || null
    });
    await syncFromBackend({ quiet: true });
    event.target.reset();
    paymentMonthCount = 1;
    renderPaymentOptions();
    setDefaultPaymentDates();
    closeSheets();
    const allocationLabel = allocation.settledMonths
      ? `${allocation.settledMonths} mensualité${allocation.settledMonths > 1 ? "s" : ""} régularisée${allocation.settledMonths > 1 ? "s" : ""}${allocation.partialMonth ? " et la suivante partiellement réglée" : ""}`
      : "la mensualité la plus ancienne partiellement réglée";
    document.querySelector("#confirm-message").textContent = `Le paiement de ${formatMoney(amount)} € a été enregistré : ${allocationLabel}, arriérés en priorité.`;
    openSheet("confirm-modal");
    speak(`Le paiement en espèces de ${formatMoney(amount)} euros pour ${contribution.name} est enregistré.`);
  } catch (error) {
    showToast(error.message || "Le paiement n’a pas pu être enregistré.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Enregistrer le paiement en espèces";
  }
}

function setDefaultPaymentDates() {
  const now = new Date();
  document.querySelector("#payment-date").valueAsDate = now;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

async function syncFromBackend({ quiet = false } = {}) {
  if (!window.JappoBackend?.configured()) {
    backendSession = null;
    workspace = null;
    if (!quiet) showToast("La configuration Supabase est absente de ce déploiement.");
    renderAll();
    return;
  }
  syncing = true;
  renderAll();
  try {
    backendSession = await window.JappoBackend.initializeSession();
    if (!backendSession) {
      workspace = null;
      state = cloneInitialState();
    } else {
      applyWorkspace(await window.JappoBackend.loadWorkspace());
    }
  } catch (error) {
    if (!quiet) showToast(error.message || "La synchronisation Supabase a échoué.");
  } finally {
    syncing = false;
    renderAll();
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const email = document.querySelector("#auth-email").value.trim().toLowerCase();
  const password = document.querySelector("#auth-password").value;
  const status = document.querySelector("#auth-status");
  const submit = document.querySelector("#auth-submit");
  if (!email || !password) {
    status.textContent = "Saisissez votre e-mail et votre mot de passe, ou utilisez le lien de secours.";
    return;
  }
  submit.disabled = true;
  submit.textContent = "Connexion…";
  status.textContent = "";
  try {
    backendSession = await window.JappoBackend.signInWithPassword(email, password);
    event.target.reset();
    await syncFromBackend({ quiet: true });
    closeSheets();
    showToast("Connexion réussie.");
  } catch (error) {
    status.textContent = error.message || "La connexion a échoué.";
  } finally {
    submit.disabled = false;
    submit.textContent = "Se connecter";
  }
}

function setAuthMode(mode) {
  authMode = mode === "admin" ? "admin" : "member";
  document.querySelector("#member-auth-panel").classList.toggle("hidden", authMode !== "member");
  document.querySelector("#admin-auth-panel").classList.toggle("hidden", authMode !== "admin");
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    const active = button.dataset.authMode === authMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

async function submitMembershipRequest(event) {
  event.preventDefault();
  const pseudo = document.querySelector("#membership-request-pseudo").value.trim();
  const status = document.querySelector("#membership-request-status");
  const submit = event.target.querySelector('button[type="submit"]');
  if (pseudo.length < 2) return;
  submit.disabled = true;
  submit.textContent = "Envoi de la demande…";
  status.textContent = "";
  try {
    await window.JappoBackend.requestPseudoMembership(pseudo);
    event.target.reset();
    status.textContent = "Demande envoyée. L’administrateur doit maintenant la valider et vous remettre votre code à 6 chiffres.";
  } catch (error) {
    status.textContent = error.message || "La demande d’adhésion n’a pas pu être envoyée.";
  } finally {
    submit.disabled = false;
    submit.textContent = "Envoyer ma demande d’adhésion";
  }
}

async function submitMemberLogin(event) {
  event.preventDefault();
  const pseudo = document.querySelector("#member-login-pseudo").value.trim();
  const code = document.querySelector("#member-login-code").value.replace(/\D/g, "");
  const status = document.querySelector("#member-login-status");
  const submit = document.querySelector("#member-login-submit");
  if (pseudo.length < 2 || code.length !== 6) {
    status.textContent = "Saisissez votre pseudo et les 6 chiffres remis par l’administrateur.";
    return;
  }
  submit.disabled = true;
  submit.textContent = "Ouverture de votre fiche…";
  status.textContent = "";
  try {
    backendSession = await window.JappoBackend.signInMember(pseudo, code);
    event.target.reset();
    await syncFromBackend({ quiet: true });
    if (!workspace?.membership?.active || workspace.membership.approval_status !== "approved") {
      throw new Error("Votre fiche n’est pas encore disponible.");
    }
    closeSheets();
    showToast("Votre fiche personnelle est ouverte.");
  } catch (error) {
    status.textContent = error.message || "Le pseudo ou le code est incorrect.";
  } finally {
    submit.disabled = false;
    submit.textContent = "Se connecter à ma fiche";
  }
}

async function sendLoginLink() {
  const email = document.querySelector("#auth-email").value.trim().toLowerCase();
  const status = document.querySelector("#auth-status");
  const button = document.querySelector("#auth-link-submit");
  if (!email) {
    status.textContent = "Saisissez d’abord votre adresse e-mail.";
    return;
  }
  button.disabled = true;
  button.textContent = "Envoi…";
  status.textContent = "";
  try {
    await window.JappoBackend.sendMagicLink(email);
    status.textContent = "Lien de secours envoyé. Ouvrez votre e-mail pour vous connecter.";
  } catch (error) {
    status.textContent = error.message || "Le lien de secours n’a pas pu être envoyé.";
  } finally {
    button.disabled = false;
    button.textContent = "Recevoir un lien de secours";
  }
}

async function authOrSignOut() {
  if (!backendSession) {
    setAuthMode("member");
    return openSheet("auth-sheet");
  }
  await window.JappoBackend.signOut();
  backendSession = null;
  workspace = null;
  state = cloneInitialState();
  saveState();
  renderAll();
  navigate("home");
  showToast("Vous êtes déconnecté.");
}

async function authOrSync() {
  if (!backendSession) return openSheet("auth-sheet");
  await syncFromBackend();
  showToast("Données Supabase actualisées.");
}

function handleAction(action) {
  const personalPaymentCount = workspace?.membership
    ? state.payments.filter((payment) => payment.memberId === workspace.membership.id).length
    : 0;
  const messages = {
    "family-switch": "Espace familial actif : Ma famille.",
    notifications: state.activities.length ? `${state.activities.length} activité récente.` : "Aucune notification pour le moment.",
    documents: personalPaymentCount ? `${personalPaymentCount} reçu${personalPaymentCount > 1 ? "s" : ""} disponible${personalPaymentCount > 1 ? "s" : ""}.` : "Aucun reçu disponible pour le moment.",
    "admin-profile": "Accès réservé à une personne habilitée."
  };
  if (messages[action]) return showToast(messages[action]);
  if (action === "record-cash") return openQuickPayment();
  if (action === "send-login-link") return sendLoginLink();
  if (action === "copy-member-code") return copyMemberCode();
  if (action === "auth-or-signout") return authOrSignOut();
  if (action === "auth-or-sync") return authOrSync();
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
    const authModeButton = event.target.closest("[data-auth-mode]");
    if (authModeButton) return setAuthMode(authModeButton.dataset.authMode);
    const navButton = event.target.closest("[data-nav]");
    if (navButton) return navigate(navButton.dataset.nav);
    const fundViewButton = event.target.closest("[data-fund-view]");
    if (fundViewButton) {
      currentFundView = fundViewButton.dataset.fundView;
      document.querySelectorAll("[data-fund-view]").forEach((button) => {
        button.classList.toggle("active", button === fundViewButton);
        button.setAttribute("aria-selected", String(button === fundViewButton));
      });
      renderDetailedContributions();
      renderSummaries();
      return;
    }
    const cashFundButton = event.target.closest("[data-cash-fund]");
    if (cashFundButton) {
      cashFundView = cashFundButton.dataset.cashFund;
      document.querySelectorAll("[data-cash-fund]").forEach((button) => {
        button.classList.toggle("active", button === cashFundButton);
        button.setAttribute("aria-selected", String(button === cashFundButton));
      });
      renderFundAccount();
      renderTransactions();
      return;
    }
    const adminFundButton = event.target.closest("[data-admin-fund]");
    if (adminFundButton) {
      adminFundView = adminFundButton.dataset.adminFund;
      document.querySelectorAll("[data-admin-fund]").forEach((button) => {
        button.classList.toggle("active", button === adminFundButton);
        button.setAttribute("aria-selected", String(button === adminFundButton));
      });
      renderMemberStatuses();
      return;
    }
    const quickFundButton = event.target.closest("[data-quick-fund]");
    if (quickFundButton) {
      document.querySelector("#payment-contribution").value = quickFundButton.dataset.quickFund;
      document.querySelectorAll("[data-quick-fund]").forEach((button) => button.classList.toggle("active", button === quickFundButton));
      updateQuickPaymentSummary();
      return;
    }
    const monthCountButton = event.target.closest("[data-month-count]");
    if (monthCountButton) {
      paymentMonthCount = monthCountButton.dataset.monthCount === "all" ? Number.POSITIVE_INFINITY : Number(monthCountButton.dataset.monthCount);
      document.querySelectorAll("[data-month-count]").forEach((button) => button.classList.toggle("active", button === monthCountButton));
      updateQuickPaymentSummary();
      return;
    }
    const editFundButton = event.target.closest("[data-edit-fund]");
    if (editFundButton) return openFundConfig(editFundButton.dataset.editFund);
    const reviewMemberButton = event.target.closest("[data-review-member]");
    if (reviewMemberButton) return reviewMemberAccess(
      reviewMemberButton.dataset.reviewMember,
      "approve",
      reviewMemberButton.dataset.accessLevel,
      (reviewMemberButton.dataset.writeFunds || "").split(",").filter(Boolean),
      reviewMemberButton
    );
    const rejectMemberButton = event.target.closest("[data-reject-member]");
    if (rejectMemberButton) return reviewMemberAccess(
      rejectMemberButton.dataset.rejectMember,
      "reject",
      "read",
      [],
      rejectMemberButton
    );
    const resetCodeButton = event.target.closest("[data-reset-member-code]");
    if (resetCodeButton) return resetMemberLoginCode(resetCodeButton.dataset.resetMemberCode, resetCodeButton);
    const deleteMemberButton = event.target.closest("[data-delete-member]");
    if (deleteMemberButton) return openDeleteMember(deleteMemberButton.dataset.deleteMember);
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
  document.querySelector("#delete-member-form").addEventListener("submit", deleteFamilyMember);
  document.querySelector("#fund-config-form").addEventListener("submit", submitFundConfiguration);
  document.querySelector("#member-schedule-form").addEventListener("submit", submitMemberSchedule);
  document.querySelector("#admin-password-form").addEventListener("submit", submitAdminPassword);
  document.querySelector("#admin-auth-form").addEventListener("submit", submitAuth);
  document.querySelector("#member-login-form").addEventListener("submit", submitMemberLogin);
  document.querySelector("#membership-request-form").addEventListener("submit", submitMembershipRequest);
  document.querySelector("#payment-member").addEventListener("change", updateQuickPaymentSummary);
  document.querySelector("#payment-contribution").addEventListener("change", updateQuickPaymentSummary);
  document.querySelector("#payment-amount").addEventListener("input", () => updatePaymentAllocationPreview({ syncChips: true }));
  document.querySelector("#schedule-member").addEventListener("change", hydrateScheduleForm);
  document.querySelector("#schedule-fund").addEventListener("change", hydrateScheduleForm);
  document.querySelector("#schedule-start").addEventListener("change", updateSchedulePreview);
  document.querySelector("#schedule-end").addEventListener("change", updateSchedulePreview);
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

async function boot() {
  const now = new Date();
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(now);
  setDefaultPaymentDates();
  renderAll();
  setupEvents();
  setupPWA();
  await syncFromBackend({ quiet: true });
  if (new URLSearchParams(location.search).get("action") === "voice") openSheet("voice-sheet");
}

boot().catch((error) => {
  console.error("Démarrage impossible", error);
  showToast("Jàppoo n’a pas pu démarrer correctement.");
});
