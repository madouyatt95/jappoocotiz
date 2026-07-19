const STORAGE_KEY = "jappo-cotiz-read-cache-v3";
const NOTIFICATION_SEEN_KEY = "jappo-cotiz-last-notification-v1";
const AUTHORIZED_ROLES = ["admin", "treasurer", "cash_collector"];

const initialState = {
  settings: { slowSpeech: true },
  contributions: [
    { id: "family", name: "Caisse famille", description: "Cotisation familiale mensuelle", monthlyAmount: 5, startDate: "2021-01-01", dueDay: 10, amount: 0, paid: 0, due: null, missingMonths: 0, status: "unconfigured", icon: "family" },
    { id: "death", name: "Caisse décès", description: "Fonds de solidarité mensuel", monthlyAmount: 5, startDate: "2021-01-01", dueDay: 10, amount: 0, paid: 0, due: null, missingMonths: 0, status: "unconfigured", icon: "shield" }
  ],
  payments: [],
  expenses: [],
  activities: []
};

let state = loadState();
let currentFilter = "all";
let currentFundView = "family";
let cashFundView = "family";
let adminFundView = "family";
let deferredInstallPrompt = null;
let recognition = null;
let toastTimer = null;
let authMode = "member";
let memberAccessFilter = "all";
let memberAccessSearch = "";
let memberAccessInitialized = false;
let workspace = null;
let backendSession = null;
let syncing = false;
let paymentImportRows = [];

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
      clean.payments = saved.payments.filter((payment) => payment.method === "Espèces" && payment.contributionId);
      clean.expenses = Array.isArray(saved.expenses) ? saved.expenses.filter((expense) => expense.contributionId) : [];
      clean.activities = saved.activities.filter((activity) => activity.source === "supabase");
      clean.contributions = saved.contributions.length
        ? saved.contributions.filter((item) => item?.id && item?.name).map((stored, index) => ({
          id: stored.id,
          backendId: stored.backendId || null,
          name: stored.name,
          description: stored.description || "Cotisation mensuelle",
          monthlyAmount: Number(stored.monthlyAmount) || 5,
          startDate: stored.startDate || "2021-01-01",
          dueDay: Number(stored.dueDay) || 10,
          amount: Number(stored.amount) || 0,
          paid: Number(stored.paid) || 0,
          due: stored.due || null,
          missingMonths: Number(stored.missingMonths) || 0,
          status: stored.status || "unconfigured",
          icon: stored.icon || (index % 2 ? "shield" : "receipt")
        }))
        : clean.contributions;
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

function fundCollected(code) {
  return state.payments
    .filter((payment) => payment.contributionId === code)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function fundExpenses(code) {
  return state.expenses
    .filter((expense) => expense.contributionId === code)
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function fundPendingExpenses(code) {
  const fundId = workspace?.funds?.find((fund) => fund.code === code)?.id;
  return (workspace?.expenses || [])
    .filter((expense) => expense.fund_id === fundId && expense.status === "pending")
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function fundBalance(code) {
  return fundCollected(code) - fundExpenses(code) - fundPendingExpenses(code);
}

function totalExpenses() {
  const expenses = canRecordCash() ? state.expenses.filter((expense) => canWriteFund(expense.contributionId)) : [];
  return expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function totalPendingExpenses() {
  return (workspace?.expenses || [])
    .filter((expense) => expense.status === "pending" && canWriteFund(workspace?.funds?.find((fund) => fund.id === expense.fund_id)?.code))
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function availableTotal() {
  return totalCollected() - totalExpenses() - totalPendingExpenses();
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
  const availableCodes = (workspace?.funds || []).filter((fund) => fund.active !== false).map((fund) => fund.code);
  if (member.role === "admin" && member.approval_status === "approved") return availableCodes;
  return Array.from(new Set(member.write_fund_codes || [])).filter((code) => availableCodes.includes(code));
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
  if (member.role === "admin") return `Administrateur • ${workspace?.funds?.length || 0} caisse${workspace?.funds?.length > 1 ? "s" : ""}`;
  if (member.access_level !== "write") return "Lecture seule";
  const codes = writableFundCodes(member);
  if (codes.length > 1) return `Saisie • ${codes.length} caisses`;
  if (codes[0]) return `Saisie • ${workspace?.funds?.find((fund) => fund.code === codes[0])?.name || "une caisse"}`;
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

  const defaultByCode = new Map(cloneInitialState().contributions.map((item) => [item.id, item]));
  state.contributions = workspace.funds.map((fund, index) => {
    const base = defaultByCode.get(fund.code) || {
      id: fund.code,
      name: fund.name,
      description: fund.description || "Cotisation mensuelle",
      monthlyAmount: Number(fund.monthly_amount),
      startDate: fund.start_date,
      dueDay: Number(fund.due_day),
      amount: 0,
      paid: 0,
      due: null,
      missingMonths: 0,
      status: "unconfigured",
      icon: index % 2 ? "shield" : "receipt"
    };
    const situation = fundSituation(workspace.membership.id, fund.id);
    return {
      ...base,
      id: fund.code,
      backendId: fund.id,
      name: fund.name,
      description: fund.description || base.description,
      monthlyAmount: Number(fund.monthly_amount),
      startDate: fund.start_date,
      dueDay: Number(fund.due_day),
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
      contributionId: fund?.code || "unknown",
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
  state.expenses = (workspace.expenses || []).filter((expense) => expense.status === "approved").map((expense) => {
    const fund = fundById.get(expense.fund_id);
    return {
      id: expense.id,
      contributionId: fund?.code || "unknown",
      contribution: fund?.name || "Caisse",
      amount: Number(expense.amount || 0),
      reason: expense.reason || "Dépense de caisse",
      category: expense.category || "Autre",
      beneficiary: expense.beneficiary || "",
      receiptPath: expense.receipt_path || "",
      date: expense.expense_date,
      dateLabel: formatDate(expense.expense_date),
      createdAt: expense.created_at,
      spentBy: expense.spent_by === workspace.user.id ? workspace.membership.full_name : "Responsable habilité"
    };
  });
  state.activities = (workspace.activityPayments || []).map((movement) => {
    const expense = movement.method === "expense";
    const reversed = Boolean(movement.reversed_at);
    const movementDate = reversed ? String(movement.reversed_at).slice(0, 10) : movement.payment_date;
    const person = expense ? movement.reversal_reason || "Dépense de caisse" : movement.member_name || "Mouvement familial";
    const responsible = reversed
      ? movement.reversed_by_name || "Responsable habilité"
      : movement.recorded_by_name || "Responsable habilité";
    return {
      id: `activity-${movement.payment_id}`,
      source: "supabase",
      group: movementDate === new Date().toISOString().slice(0, 10) ? "Aujourd’hui" : formatDate(movementDate),
      title: expense ? "Dépense de caisse" : reversed ? "Paiement annulé" : "Paiement en espèces reçu",
      text: expense
        ? `${movement.fund_name || "Caisse"} • ${person} • − ${formatMoney(Number(movement.amount || 0))} €`
        : `${movement.fund_name || "Caisse"} • ${person} • ${reversed ? "−" : "+"} ${formatMoney(Number(movement.amount || 0))} €${reversed && movement.reversal_reason ? ` • Motif : ${movement.reversal_reason}` : ""}`,
      time: expense ? `Dépensé par ${responsible}` : reversed ? `Annulé par ${responsible} • trace conservée` : `Enregistré par ${responsible}`,
      tone: expense || reversed ? "expense" : "paid",
      reversed,
      expense,
      reason: movement.reversal_reason || "",
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

function renderFundSelectors() {
  const contributions = state.contributions;
  const fallback = contributions[0]?.id || state.contributions[0]?.id || "family";
  if (!contributions.some((item) => item.id === currentFundView)) currentFundView = fallback;
  if (!contributions.some((item) => item.id === cashFundView)) cashFundView = fallback;

  const renderButtons = (items, selected, attribute) => items.map((item) => `
    <button class="${item.id === selected ? "active" : ""}" type="button" role="tab" aria-selected="${item.id === selected}" ${attribute}="${escapeHTML(item.id)}">${escapeHTML(item.name)}</button>
  `).join("");

  document.querySelector("#contribution-fund-switch").innerHTML = renderButtons(contributions, currentFundView, "data-fund-view");
  document.querySelector("#cash-fund-switch").innerHTML = renderButtons(contributions, cashFundView, "data-cash-fund");

  const writable = contributions.filter((item) => canWriteFund(item.id));
  if (!writable.some((item) => item.id === adminFundView)) adminFundView = writable[0]?.id || fallback;
  document.querySelector("#admin-fund-switch").innerHTML = renderButtons(writable, adminFundView, "data-admin-fund");
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
  const movements = [
    ...state.payments
      .filter((payment) => payment.contributionId === cashFundView)
      .map((payment) => ({ ...payment, kind: "payment", sortDate: `${payment.date}T00:00:00` })),
    ...state.expenses
      .filter((expense) => expense.contributionId === cashFundView)
      .map((expense) => ({ ...expense, kind: "expense", sortDate: expense.createdAt || `${expense.date}T00:00:00` }))
  ].sort((a, b) => String(b.sortDate).localeCompare(String(a.sortDate)));
  if (!movements.length) {
    container.innerHTML = '<div class="empty-state"><span>₣</span><strong>Aucune opération</strong><p>Les encaissements et dépenses enregistrés apparaîtront ici.</p></div>';
    return;
  }
  container.innerHTML = movements.slice(0, 10).map((movement) => movement.kind === "expense" ? `
    <article class="transaction"><span class="transaction-icon out">↑</span><div><strong>${escapeHTML(movement.reason)}</strong><small>${escapeHTML(movement.contribution)} • ${escapeHTML(movement.dateLabel)}</small></div><b class="money-out">− ${formatMoney(movement.amount)} €</b></article>` : `
    <article class="transaction"><span class="transaction-icon in">↓</span><div><strong>${escapeHTML(movement.contribution)}</strong><small>${escapeHTML(movement.member)} • ${escapeHTML(movement.dateLabel)}</small></div><b class="money-in">+ ${formatMoney(movement.amount)} €</b></article>`).join("");
}

function renderFundAccount() {
  const fund = state.contributions.find((item) => item.id === cashFundView) || state.contributions[0];
  const fundPayments = state.payments.filter((payment) => payment.contributionId === fund.id);
  const collected = fundCollected(fund.id);
  const spent = fundExpenses(fund.id);
  const balance = fundBalance(fund.id);
  const shortcut = document.querySelector("#fund-config-shortcut");
  shortcut.dataset.editFund = fund.id;
  document.querySelector("#fund-config-shortcut-title").textContent = `Paramétrer ${fund.name}`;
  document.querySelector("#cash-balance").textContent = `${formatMoney(canRecordCash() ? balance : collected, 2)} €`;
  document.querySelector("#cash-in").textContent = `+ ${formatMoney(collected)} €`;
  document.querySelector("#cash-out").textContent = canRecordCash() ? `− ${formatMoney(spent)} €` : "Non affiché";
  const pendingCount = (workspace?.expenses || []).filter((expense) => expense.status === "pending" && expense.fund_id === fund.backendId).length;
  const movementCount = fundPayments.length + state.expenses.filter((expense) => expense.contributionId === fund.id).length;
  document.querySelector("#cash-updated").textContent = movementCount ? `${movementCount} mouvement${movementCount > 1 ? "s" : ""} enregistré${movementCount > 1 ? "s" : ""}${pendingCount ? ` • ${pendingCount} dépense en attente` : ""}` : "Aucune opération enregistrée";
  document.querySelector("#fund-period-card").innerHTML = `
    <div><span class="contribution-icon ${fund.id === "family" ? "green" : fund.id === "death" ? "indigo" : "orange"}">${iconSVG(fund.icon)}</span><div><small>Caisse sélectionnée</small><strong>${escapeHTML(fund.name)}</strong></div></div>
    <div class="fund-config-facts"><span><small>Mensualité</small><b>${formatMoney(fund.monthlyAmount)} €</b></span><span><small>Depuis</small><b>${formatPeriod(fund.startDate)}</b></span><span><small>Échéance</small><b>Le ${fund.dueDay}</b></span></div>`;
}

function renderActivities() {
  const container = document.querySelector("#activity-list");
  const netBalance = state.activities.reduce((sum, item) => item.reversed ? sum : sum + (item.expense ? -item.amount : item.amount), 0);
  document.querySelector("#activity-movement-count").textContent = String(state.activities.length);
  document.querySelector("#activity-collected-total").textContent = `${formatMoney(netBalance)} €`;
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
      <article class="timeline-item"><span class="timeline-dot ${item.tone}">${item.reversed || item.expense ? "−" : "+"}</span><div class="timeline-content"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.text)}</p><time>${escapeHTML(item.time)}</time></div></article>`).join("")}</section>`).join("");
}

function renderAdminPayments() {
  const container = document.querySelector("#admin-cash-payments");
  const writablePayments = state.payments.filter((payment) => canWriteFund(payment.contributionId));
  const reversalTraces = state.activities.filter((activity) => activity.reversed).slice(0, 3);
  if (!writablePayments.length) {
    container.innerHTML = `<div class="notice-card"><span class="feature-icon green">✓</span><div><strong>Aucun paiement actif</strong><p>Les paiements annulés restent tracés ci-dessous et dans Activité.</p></div></div>${reversalTraces.map((trace) => `<div class="reversal-audit"><strong>${escapeHTML(trace.title)} • trace conservée</strong><small>${escapeHTML(trace.text)}<br>${escapeHTML(trace.time)}</small></div>`).join("")}`;
    return;
  }
  const activeMarkup = writablePayments.slice(0, 6).map((payment) => `
    <article class="pending-card cash-payment-card">
      <div class="pending-main"><span class="member-avatar">MC</span><div><strong>${escapeHTML(payment.member)}</strong><small>${escapeHTML(payment.contribution)} • Espèces • ${escapeHTML(payment.periodLabel)}</small></div><div class="pending-amount"><b>${formatMoney(payment.amount)} €</b><time>${escapeHTML(payment.dateLabel)}</time></div></div>
      <div class="pending-proof">${iconSVG("receipt")}<span>Enregistré par ${escapeHTML(payment.recordedBy)}</span></div>
      ${isAdministrator() ? `<button class="reverse-payment-button" type="button" data-reverse-payment="${payment.id}">Annuler une saisie erronée</button>` : ""}
    </article>`).join("");
  const auditMarkup = reversalTraces.length ? `<div class="audit-trace-list">${reversalTraces.map((trace) => `<div class="reversal-audit"><strong>${escapeHTML(trace.title)} • trace conservée</strong><small>${escapeHTML(trace.text)}<br>${escapeHTML(trace.time)}</small></div>`).join("")}</div>` : "";
  container.innerHTML = activeMarkup + auditMarkup;
}

function renderMemberStatuses() {
  const container = document.querySelector("#member-status-list");
  const members = approvedMembers();
  if (!canRecordCash() || !members.length) {
    container.innerHTML = '<div class="empty-state compact-empty"><span>👥</span><strong>Aucun membre</strong><p>Les membres rattachés apparaîtront ici.</p></div>';
    return;
  }
  if (!canWriteFund(adminFundView)) adminFundView = writableFundCodes()[0] || state.contributions[0]?.id;
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
  document.querySelector("#pending-member-count").classList.toggle("empty", pendingCount === 0);
  if (!memberAccessInitialized) {
    section.open = pendingCount > 0;
    memberAccessInitialized = true;
  }

  if (!members.length) {
    document.querySelector("#member-access-result").textContent = "0 compte";
    container.innerHTML = '<div class="empty-state compact-empty"><span>✓</span><strong>Aucune demande</strong></div>';
    return;
  }

  const normalizedSearch = memberAccessSearch.trim().toLocaleLowerCase("fr");
  const visibleMembers = members.filter((member) => {
    const matchesFilter = memberAccessFilter === "all" || member.approval_status === memberAccessFilter;
    const identity = `${member.full_name || ""} ${member.pseudo || ""}`.toLocaleLowerCase("fr");
    return matchesFilter && (!normalizedSearch || identity.includes(normalizedSearch));
  });
  document.querySelector("#member-access-result").textContent = `${visibleMembers.length} compte${visibleMembers.length > 1 ? "s" : ""} affiché${visibleMembers.length > 1 ? "s" : ""} • ${pendingCount} en attente`;
  if (!visibleMembers.length) {
    container.innerHTML = '<div class="empty-state compact-empty"><span>⌕</span><strong>Aucun résultat</strong><p>Modifiez la recherche ou le filtre.</p></div>';
    return;
  }

  container.innerHTML = visibleMembers.map((member) => {
    const pending = member.approval_status === "pending";
    const rejected = member.approval_status === "rejected";
    const protectedAdmin = member.role === "admin" && member.approval_status === "approved";
    const status = pending ? "En attente de validation" : rejected ? "Accès refusé" : accessLabel(member);
    const identity = member.pseudo ? `${member.full_name} • @${member.pseudo}` : member.full_name;
    const memberCodes = writableFundCodes(member);
    const fundChoices = (workspace.funds || []).map((fund) => `
      <label class="fund-access-check"><input type="checkbox" value="${escapeHTML(fund.code)}" ${memberCodes.includes(fund.code) ? "checked" : ""} /><span>${escapeHTML(fund.name)}</span></label>`).join("");
    const controls = protectedAdmin
      ? `<span class="protected-access">Écriture permanente sur ${workspace.funds.length} caisse${workspace.funds.length > 1 ? "s" : ""}</span>`
      : `<div class="access-choice" role="group" aria-label="Droits de ${escapeHTML(member.full_name)}">
          <button class="${!pending && !rejected && member.access_level === "read" ? "active" : ""}" type="button" data-review-member="${member.id}" data-access-level="read" data-write-funds="">Lecture seule</button>
          <div class="fund-access-list">${fundChoices}</div>
          <button class="${!pending && !rejected && member.access_level === "write" ? "active" : ""}" type="button" data-save-fund-access="${member.id}">Enregistrer les caisses sélectionnées</button>
        </div>
        ${!pending && !rejected && member.pseudo ? `<button class="reset-code-button" type="button" data-reset-member-code="${member.id}">Créer un nouveau code</button>` : ""}
        ${pending ? `<button class="reject-access" type="button" data-reject-member="${member.id}">Refuser</button>` : ""}`;
    return `<details class="access-member-card ${pending ? "pending" : rejected ? "rejected" : "approved"}">
      <summary class="access-member-head"><span class="member-avatar">${initials(member.full_name)}</span><div><strong>${escapeHTML(identity)}</strong><small>${escapeHTML(status)}</small></div><em>${pending ? "Nouveau" : rejected ? "Refusé" : "Validé"}</em><b aria-hidden="true">⌄</b></summary>
      <div class="access-member-controls">${controls}${protectedAdmin ? "" : `<button class="delete-member-button" type="button" data-delete-member="${member.id}">Supprimer le membre et ses transactions</button>`}</div>
    </details>`;
  }).join("");
}

function renderFundSettings() {
  const panel = document.querySelector("#fund-settings-panel");
  const container = document.querySelector("#fund-settings-list");
  panel.classList.toggle("hidden", !isAdministrator());
  if (!isAdministrator()) {
    container.innerHTML = "";
    return;
  }
  if (!workspace?.funds?.length) {
    container.innerHTML = '<div class="empty-state compact-empty"><span>⚙</span><strong>Caisses non synchronisées</strong></div>';
    return;
  }
  container.innerHTML = workspace.funds.map((fund) => `
    <article class="fund-setting-row">
      <span class="contribution-icon ${fund.code === "family" ? "green" : fund.code === "death" ? "indigo" : "orange"}">${iconSVG(fund.code === "family" ? "family" : fund.code === "death" ? "shield" : "receipt")}</span>
      <div><strong>${escapeHTML(fund.name)}</strong><small>${formatMoney(Number(fund.monthly_amount))} € / mois • depuis ${formatPeriod(fund.start_date)}</small></div>
      ${workspace.membership.role === "admin" ? `<button type="button" data-edit-fund="${escapeHTML(fund.code)}" aria-label="Modifier ${escapeHTML(fund.name)}">Modifier</button>` : ""}
    </article>`).join("");
}

function renderPendingExpenses() {
  const section = document.querySelector("#pending-expense-section");
  const container = document.querySelector("#pending-expense-list");
  const expenses = (workspace?.expenses || []).filter((expense) => expense.status === "pending" && canWriteFund(workspace?.funds?.find((fund) => fund.id === expense.fund_id)?.code));
  section.classList.toggle("hidden", !canRecordCash());
  document.querySelector("#pending-expense-count").textContent = String(expenses.length);
  document.querySelector("#pending-expense-count").classList.toggle("empty", expenses.length === 0);
  if (!canRecordCash()) return container.innerHTML = "";
  if (!expenses.length) {
    container.innerHTML = '<div class="empty-state compact-empty"><span>✓</span><strong>Aucune dépense en attente</strong></div>';
    return;
  }
  container.innerHTML = expenses.map((expense) => {
    const fund = workspace.funds.find((item) => item.id === expense.fund_id);
    const ownExpense = expense.spent_by === workspace.user.id;
    return `<article class="pending-expense-card">
      <div><strong>${formatMoney(Number(expense.amount))} € • ${escapeHTML(fund?.name || "Caisse")}</strong><small>${escapeHTML(expense.category || "Autre")} • ${escapeHTML(expense.reason)}${expense.beneficiary ? ` • ${escapeHTML(expense.beneficiary)}` : ""}<br>${formatDate(expense.expense_date)}</small></div>
      ${expense.receipt_path ? `<button type="button" data-expense-receipt="${escapeHTML(expense.receipt_path)}">Voir le justificatif</button>` : ""}
      <div class="expense-review-actions"><button type="button" data-review-expense="${expense.id}" data-expense-decision="approve" ${ownExpense ? "disabled" : ""}>Valider</button><button class="reject" type="button" data-review-expense="${expense.id}" data-expense-decision="reject" ${ownExpense ? "disabled" : ""}>Refuser</button></div>
      ${ownExpense ? "<em>Une autre personne habilitée doit décider.</em>" : ""}
    </article>`;
  }).join("");
}

function renderMemberExceptions() {
  const section = document.querySelector("#member-exception-section");
  section.classList.toggle("hidden", !isAdministrator());
  if (!isAdministrator()) return;
  document.querySelector("#exception-start").max = currentMonthValue();
  document.querySelector("#exception-end").max = currentMonthValue();
  if (!document.querySelector("#exception-start").value) document.querySelector("#exception-start").value = currentMonthValue();
  if (!document.querySelector("#exception-end").value) document.querySelector("#exception-end").value = currentMonthValue();
  const memberSelect = document.querySelector("#exception-member");
  const fundSelect = document.querySelector("#exception-fund");
  const previousMember = memberSelect.value;
  const previousFund = fundSelect.value;
  memberSelect.innerHTML = approvedMembers().map((member) => `<option value="${member.id}">${escapeHTML(member.full_name)}</option>`).join("");
  fundSelect.innerHTML = workspace.funds.map((fund) => `<option value="${fund.id}">${escapeHTML(fund.name)}</option>`).join("");
  if (approvedMembers().some((member) => member.id === previousMember)) memberSelect.value = previousMember;
  if (workspace.funds.some((fund) => fund.id === previousFund)) fundSelect.value = previousFund;
  const names = new Map(approvedMembers().map((member) => [member.id, member.full_name]));
  const funds = new Map(workspace.funds.map((fund) => [fund.id, fund.name]));
  const history = (workspace.exceptions || []).slice(0, 8);
  document.querySelector("#member-exception-history").innerHTML = history.length
    ? `<h3>Décisions récentes</h3>${history.map((item) => `<article><strong>${escapeHTML(names.get(item.member_id) || "Membre")} • ${escapeHTML(funds.get(item.fund_id) || "Caisse")}</strong><small>${escapeHTML(({ exempt: "Exonération", suspend: "Suspension", resume: "Reprise", leave: "Départ" })[item.action] || item.action)} • ${formatPeriod(item.start_month)}${item.end_month && item.end_month !== item.start_month ? ` à ${formatPeriod(item.end_month)}` : ""}${item.note ? `<br>${escapeHTML(item.note)}` : ""}</small></article>`).join("")}`
    : '<p class="section-help">Aucune exception enregistrée.</p>';
}

function renderAdminAudit() {
  const section = document.querySelector("#admin-audit-section");
  const container = document.querySelector("#admin-audit-list");
  section.classList.toggle("hidden", !isAdministrator());
  document.querySelector("#payment-import-section").classList.toggle("hidden", !isAdministrator());
  if (!isAdministrator()) return container.innerHTML = "";
  const events = workspace.adminActivity || [];
  container.innerHTML = events.length
    ? events.slice(0, 30).map((event) => `<article><span>◷</span><div><strong>${escapeHTML(event.summary)}</strong><small>${escapeHTML(event.actor_name || "Système")} • ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.created_at))}</small></div></article>`).join("")
    : '<div class="empty-state compact-empty"><span>◷</span><strong>Le journal est prêt</strong><p>Les prochaines actions administratives apparaîtront ici.</p></div>';
}

function normalizeLookup(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("fr");
}

function parseDelimitedLine(line, delimiter) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { values.push(value.trim()); value = ""; }
    else value += character;
  }
  values.push(value.trim());
  return values;
}

function rowsFromCSV(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const delimiter = (lines[0]?.match(/;/g) || []).length > (lines[0]?.match(/,/g) || []).length ? ";" : ",";
  return lines.map((line) => parseDelimitedLine(line, delimiter));
}

function excelColumnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function rowsFromXLSX(buffer) {
  if (!window.fflate?.unzipSync) throw new Error("Le lecteur Excel n’est pas disponible.");
  const archive = window.fflate.unzipSync(new Uint8Array(buffer));
  const decoder = new TextDecoder();
  const worksheetBytes = archive["xl/worksheets/sheet1.xml"];
  if (!worksheetBytes) throw new Error("La première feuille Excel est introuvable.");
  const sharedDocument = archive["xl/sharedStrings.xml"] ? new DOMParser().parseFromString(decoder.decode(archive["xl/sharedStrings.xml"]), "application/xml") : null;
  const sharedStrings = sharedDocument ? [...sharedDocument.getElementsByTagName("si")].map((item) => [...item.getElementsByTagName("t")].map((node) => node.textContent || "").join("")) : [];
  const worksheet = new DOMParser().parseFromString(decoder.decode(worksheetBytes), "application/xml");
  return [...worksheet.getElementsByTagName("row")].map((row) => {
    const values = [];
    [...row.getElementsByTagName("c")].forEach((cell) => {
      const index = excelColumnIndex(cell.getAttribute("r"));
      const raw = cell.getElementsByTagName("v")[0]?.textContent || cell.getElementsByTagName("t")[0]?.textContent || "";
      values[index] = cell.getAttribute("t") === "s" ? sharedStrings[Number(raw)] || "" : raw;
    });
    return values.map((value) => value ?? "");
  });
}

function normalizeImportDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{2}[\/.\-]\d{2}[\/.\-]\d{4}$/.test(text)) {
    const [day, month, year] = text.split(/[\/.\-]/);
    return `${year}-${month}-${day}`;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(text) * 86400000);
    return date.toISOString().slice(0, 10);
  }
  return "";
}

function prepareImportRows(table) {
  if (table.length < 2) throw new Error("Le fichier ne contient aucun paiement.");
  if (table.length > 2001) throw new Error("Maximum 2 000 paiements par import.");
  const headers = table[0].map(normalizeLookup);
  const column = (names) => headers.findIndex((header) => names.includes(header));
  const memberColumn = column(["membre", "nom", "nom du membre", "pseudo"]);
  const fundColumn = column(["caisse", "fonds", "nom de la caisse"]);
  const amountColumn = column(["montant", "montant paye", "somme"]);
  const dateColumn = column(["date", "date de paiement"]);
  const noteColumn = column(["note", "commentaire", "motif"]);
  if ([memberColumn, fundColumn, amountColumn, dateColumn].some((index) => index < 0)) throw new Error("Colonnes obligatoires : Membre, Caisse, Montant et Date.");

  const memberMap = new Map();
  approvedMembers().forEach((member) => {
    [member.full_name, member.pseudo].filter(Boolean).forEach((name) => {
      const key = normalizeLookup(name);
      memberMap.set(key, memberMap.has(key) ? null : member);
    });
  });
  const fundMap = new Map();
  workspace.funds.forEach((fund) => [fund.name, fund.code].forEach((name) => fundMap.set(normalizeLookup(name), fund)));
  const today = new Date().toISOString().slice(0, 10);
  const totals = new Map();
  const rows = table.slice(1).filter((row) => row.some((value) => String(value || "").trim())).map((row, index) => {
    const member = memberMap.get(normalizeLookup(row[memberColumn]));
    const fund = fundMap.get(normalizeLookup(row[fundColumn]));
    const amount = Number(String(row[amountColumn] || "").replace(/\s/g, "").replace(",", "."));
    const paymentDate = normalizeImportDate(row[dateColumn]);
    const errors = [];
    if (!member) errors.push("membre introuvable ou ambigu");
    if (!fund) errors.push("caisse introuvable");
    if (!Number.isFinite(amount) || amount <= 0) errors.push("montant invalide");
    if (!paymentDate || paymentDate > today) errors.push("date invalide");
    if (member && fund && Number.isFinite(amount)) {
      const key = `${member.id}:${fund.id}`;
      totals.set(key, Number(totals.get(key) || 0) + amount);
    }
    return { rowNumber: index + 2, member, fund, amount, paymentDate, note: noteColumn >= 0 ? String(row[noteColumn] || "").slice(0, 160) : "", errors };
  });
  rows.forEach((row) => {
    if (!row.member || !row.fund) return;
    const key = `${row.member.id}:${row.fund.id}`;
    if (Number(totals.get(key)) > fundSituation(row.member.id, row.fund.id).outstanding + 0.001) row.errors.push("total supérieur aux arriérés");
  });
  return rows.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.rowNumber - b.rowNumber);
}

function renderPaymentImportPreview() {
  const container = document.querySelector("#payment-import-preview");
  const button = document.querySelector("#payment-import-submit");
  const errors = paymentImportRows.filter((row) => row.errors.length);
  button.disabled = !paymentImportRows.length || errors.length > 0;
  if (!paymentImportRows.length) return container.innerHTML = "<p>Sélectionnez un fichier pour afficher l’aperçu.</p>";
  container.innerHTML = `<div class="import-result ${errors.length ? "invalid" : "valid"}"><strong>${paymentImportRows.length} ligne${paymentImportRows.length > 1 ? "s" : ""} • ${errors.length ? `${errors.length} à corriger` : "prêtes à importer"}</strong><small>${errors.length ? "Aucune donnée ne sera écrite tant que le fichier contient une erreur." : "L’import sera effectué en une seule opération sécurisée."}</small></div><div class="import-table">${paymentImportRows.slice(0, 12).map((row) => `<article class="${row.errors.length ? "invalid" : ""}"><span>Ligne ${row.rowNumber}</span><strong>${escapeHTML(row.member?.full_name || "Membre inconnu")} • ${escapeHTML(row.fund?.name || "Caisse inconnue")}</strong><small>${formatMoney(row.amount || 0)} € • ${row.paymentDate || "date invalide"}${row.errors.length ? `<br>${escapeHTML(row.errors.join(", "))}` : ""}</small></article>`).join("")}</div>${paymentImportRows.length > 12 ? `<p>${paymentImportRows.length - 12} ligne(s) supplémentaire(s) vérifiée(s).</p>` : ""}`;
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
      <span class="contribution-icon ${item.id === "family" ? "green" : item.id === "death" ? "indigo" : "orange"}">${iconSVG(item.icon)}</span><strong>${escapeHTML(item.name)}</strong><small>${formatMoney(item.monthlyAmount)} € / mois</small>
    </button>`).join("");
  updateQuickPaymentSummary();
}

function renderExpenseOptions() {
  const select = document.querySelector("#expense-fund");
  const previousFund = select.value || adminFundView;
  const writableContributions = state.contributions.filter((item) => item.backendId && canWriteFund(item.id));
  select.innerHTML = writableContributions.map((item) => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join("");
  select.value = writableContributions.some((item) => item.id === previousFund) ? previousFund : writableContributions[0]?.id || "";
  document.querySelector("#expense-fund-grid").innerHTML = writableContributions.map((item) => `
    <button class="${select.value === item.id ? "active" : ""}" type="button" data-expense-fund="${item.id}">
      <span class="contribution-icon ${item.id === "family" ? "green" : item.id === "death" ? "indigo" : "orange"}">${iconSVG(item.icon)}</span><strong>${escapeHTML(item.name)}</strong><small>Solde ${formatMoney(fundBalance(item.id))} €</small>
    </button>`).join("");
  updateExpenseBalancePreview();
}

function updateExpenseBalancePreview() {
  const code = document.querySelector("#expense-fund")?.value;
  const fund = state.contributions.find((item) => item.id === code);
  const amount = Number(document.querySelector("#expense-amount")?.value);
  const preview = document.querySelector("#expense-balance-preview");
  if (!preview) return;
  preview.classList.remove("error");
  if (!fund) {
    preview.innerHTML = "<span>Solde disponible</span><strong>0 €</strong><small>Choisissez une caisse autorisée.</small>";
    return;
  }
  const balance = fundBalance(fund.id);
  const remaining = balance - (Number.isFinite(amount) ? amount : 0);
  if (Number.isFinite(amount) && amount > balance + 0.001) preview.classList.add("error");
  preview.innerHTML = `<span>Solde disponible • ${escapeHTML(fund.name)}</span><strong>${formatMoney(balance)} €</strong><small>${Number.isFinite(amount) && amount > 0 ? `Solde après dépense : ${formatMoney(remaining)} €` : "Le serveur empêchera toute dépense supérieure au solde."}</small>`;
  const threshold = Number(workspace?.funds?.find((item) => item.code === code)?.expense_approval_threshold || 0);
  document.querySelector("#expense-approval-notice")?.classList.toggle("hidden", !(threshold > 0 && Number.isFinite(amount) && amount >= threshold));
}

function currentMonthValue() {
  return new Date().toISOString().slice(0, 7);
}

function scheduleLimitMonthValue() {
  const limit = new Date();
  limit.setUTCFullYear(limit.getUTCFullYear() + 10);
  return limit.toISOString().slice(0, 7);
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
  const settleButton = document.querySelector("#schedule-settle-through");
  if (!preview) return;
  const valid = Boolean(member && fund && start && end && start >= "2021-01" && start <= end && end <= scheduleLimitMonthValue());
  if (settleButton) {
    settleButton.disabled = !valid;
    settleButton.textContent = valid ? `À jour jusqu’à ${formatPeriod(end)}` : "À jour jusqu’à ce mois";
  }
  if (!valid) {
    preview.innerHTML = "<span>Période</span><strong>Sélectionnez une période valide</strong><small>Du mois de début au mois de fin inclus.</small>";
    return;
  }
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const count = (endYear - startYear) * 12 + endMonth - startMonth + 1;
  const futurePayment = end > currentMonthValue();
  preview.innerHTML = `<span>${escapeHTML(member.full_name)} • ${escapeHTML(fund.name)}</span><strong>${count} mensualité${count > 1 ? "s" : ""} • ${formatMoney(count * Number(fund.monthly_amount))} € dus</strong><small>${formatPeriod(start)} à ${formatPeriod(end)} inclus • ${futurePayment ? "les mois futurs seront inclus dans le paiement anticipé" : "paiements existants conservés"}</small>`;
}

function hydrateScheduleForm() {
  const memberId = document.querySelector("#schedule-member")?.value;
  const fundId = document.querySelector("#schedule-fund")?.value;
  const member = approvedMembers().find((item) => item.id === memberId);
  const fund = workspace?.funds?.find((item) => item.id === fundId);
  if (!member || !fund) return updateSchedulePreview();
  const existing = scheduleFor(memberId, fundId);
  const defaultStart = ["2021-01", String(fund.start_date || "2021-01").slice(0, 7), String(member.joined_on || "2021-01").slice(0, 7)].sort().at(-1);
  document.querySelector("#schedule-start").max = scheduleLimitMonthValue();
  document.querySelector("#schedule-end").max = scheduleLimitMonthValue();
  document.querySelector("#schedule-start").value = existing ? String(existing.start_month).slice(0, 7) : defaultStart;
  document.querySelector("#schedule-end").value = existing ? String(existing.end_month).slice(0, 7) : currentMonthValue();
  updateSchedulePreview();
}

function renderScheduleOptions() {
  const section = document.querySelector("#member-schedule-section");
  section.classList.toggle("hidden", !isAdministrator());
  if (!isAdministrator()) return;
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

function monthsInRange(start, end) {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const months = [];
  for (let cursor = startYear * 12 + startMonth - 1, last = endYear * 12 + endMonth - 1; cursor <= last; cursor += 1) {
    const year = Math.floor(cursor / 12);
    const month = cursor % 12 + 1;
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

function exceptionForMonth(memberId, fundId, month) {
  return (workspace?.exceptions || [])
    .filter((item) => item.member_id === memberId && item.fund_id === fundId)
    .filter((item) => item.action === "leave" ? month >= String(item.start_month).slice(0, 7) : month >= String(item.start_month).slice(0, 7) && month <= String(item.end_month || item.start_month).slice(0, 7))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

function projectedScheduleOutstanding({ memberId, fund, member, start, end }) {
  const effectiveStart = ["2021-01", start, String(fund.start_date || "2021-01").slice(0, 7), String(member.joined_on || "2021-01").slice(0, 7)].sort().at(-1);
  const periods = new Map(periodsFor(memberId, fund.id).map((period) => [String(period.period_start).slice(0, 7), period]));
  return monthsInRange(effectiveStart, end).reduce((total, month) => {
    const exception = exceptionForMonth(memberId, fund.id, month);
    if (["exempt", "suspend", "leave"].includes(exception?.action)) return total;
    const period = periods.get(month);
    if (!period || period.status === "cancelled") return total + Number(fund.monthly_amount);
    if (period.status === "exempt") return total;
    return total + Math.max(0, Number(period.amount_due || 0) - Number(period.amount_paid || 0));
  }, 0);
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

function clearPreparedSchedulePayment() {
  document.querySelector("#payment-schedule-start").value = "";
  document.querySelector("#payment-through-month").value = "";
  document.querySelector("#payment-amount").readOnly = false;
}

function updatePaymentAllocationPreview() {
  const memberId = document.querySelector("#payment-member")?.value;
  const code = document.querySelector("#payment-contribution")?.value;
  const fund = workspace?.funds?.find((item) => item.code === code);
  const amount = Number(document.querySelector("#payment-amount")?.value);
  const preview = document.querySelector("#payment-allocation-preview");
  if (!preview) return null;

  preview.classList.remove("error");
  const throughMonth = document.querySelector("#payment-through-month")?.value;
  if (throughMonth && memberId && fund && Number.isFinite(amount) && amount > 0) {
    preview.innerHTML = `<span>Paiement anticipé et traçable</span><strong>À jour jusqu’à ${formatPeriod(throughMonth)}</strong><small>${formatMoney(amount)} € seront affectés automatiquement, des arriérés aux mensualités futures.</small>`;
    return { outstanding: amount, settledMonths: 0, touched: [], partialMonth: false, overpayment: 0, remainingAfter: 0 };
  }
  if (!memberId || !fund) {
    preview.innerHTML = "<span>Affectation automatique</span><strong>Sélectionnez un membre et une caisse</strong><small>Les arriérés seront régularisés du mois le plus ancien au plus récent.</small>";
    return null;
  }

  const allocation = paymentAllocationFor(memberId, fund.id, amount);

  if (!allocation.outstanding) {
    preview.innerHTML = "<span>Affectation automatique</span><strong>Ce membre est déjà à jour</strong><small>Aucun arriéré n’est dû dans cette caisse jusqu’au mois courant.</small>";
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

function updateQuickPaymentSummary({ clearAmount = false } = {}) {
  const memberId = document.querySelector("#payment-member")?.value;
  const code = document.querySelector("#payment-contribution")?.value;
  const fund = workspace?.funds?.find((item) => item.code === code);
  const summary = document.querySelector("#quick-payment-summary");
  if (!summary) return;
  const situation = memberId && fund ? fundSituation(memberId, fund.id) : null;
  if (clearAmount) document.querySelector("#payment-amount").value = "";
  summary.innerHTML = situation
    ? `<span>Arriérés de cette caisse</span><strong>${formatMoney(situation.outstanding)} €</strong><small>${situation.missingMonths} mensualité${situation.missingMonths === 1 ? "" : "s"} à régulariser • ${formatMoney(Number(fund.monthly_amount))} € / mois</small><button class="settle-arrears-button" id="settle-arrears-button" type="button" data-action="settle-arrears" ${situation.outstanding > 0 ? "" : "disabled"}>${situation.outstanding > 0 ? `Régler tous les arriérés • ${formatMoney(situation.outstanding)} €` : "Déjà à jour"}</button>`
    : '<span>Arriérés de cette caisse</span><strong>0 €</strong><small>Sélectionnez un membre et une caisse</small><button class="settle-arrears-button" id="settle-arrears-button" type="button" data-action="settle-arrears" disabled>Régler tous les arriérés</button>';
  updatePaymentAllocationPreview();
}

function settlePaymentArrears() {
  const memberId = document.querySelector("#payment-member")?.value;
  const code = document.querySelector("#payment-contribution")?.value;
  const fund = workspace?.funds?.find((item) => item.code === code);
  if (!memberId || !fund) return showToast("Choisissez d’abord un membre et une caisse.");
  const situation = fundSituation(memberId, fund.id);
  if (situation.outstanding <= 0) return showToast("Ce membre est déjà à jour pour cette caisse.");
  document.querySelector("#payment-amount").value = situation.outstanding.toFixed(2);
  updatePaymentAllocationPreview();
  showToast(`Montant global des arriérés : ${formatMoney(situation.outstanding)} €.`);
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
  if (!allowedCodes.includes(adminFundView)) adminFundView = allowedCodes[0] || state.contributions[0]?.id || "family";
  document.querySelector("#admin-pill-label").textContent = canRecordCash() ? "Gestion" : member?.approval_status === "pending" ? "En attente" : connected ? "Accès" : "Connexion";
  document.querySelector("#admin-role-label").textContent = member ? `${accessLabel(member)} • ${member.full_name}` : "Personne habilitée";
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
  const cashBalance = availableTotal();
  const writablePaymentCount = state.payments.filter((payment) => canWriteFund(payment.contributionId)).length;
  const outstanding = outstandingTotal();
  const paidFunds = state.contributions.filter((item) => item.paid > 0).length;
  const late = state.contributions.filter((item) => contributionStatus(item) === "late").reduce((sum, item) => sum + Math.max(0, item.amount - item.paid), 0);
  const selected = state.contributions.find((item) => item.id === currentFundView) || state.contributions[0];
  const selectedRemaining = Math.max(0, selected.amount - selected.paid);
  const selectedLate = contributionStatus(selected) === "late" ? selectedRemaining : 0;

  document.querySelector("#balance-total").textContent = formatMoney(outstanding);
  document.querySelector("#welcome-status-text").textContent = late ? `${formatMoney(late)} € en retard` : "Aucune échéance en retard";
  const fundCount = Math.max(1, state.contributions.length);
  document.querySelector("#progress-label").textContent = `${paidFunds}/${state.contributions.length}`;
  document.querySelector(".month-progress").setAttribute("aria-label", `${paidFunds} caisse sur ${state.contributions.length} avec un versement enregistré`);
  document.querySelector(".month-progress .progress-value").style.strokeDasharray = `${Math.round((paidFunds / fundCount) * 145)} 145`;
  document.querySelector("#paid-summary").textContent = `${formatMoney(selected.paid)} €`;
  document.querySelector("#late-summary").textContent = `${formatMoney(selectedLate)} €`;
  document.querySelector("#upcoming-summary").textContent = `${formatMoney(selectedRemaining - selectedLate)} €`;
  document.querySelector("#admin-cash-total").textContent = `${formatMoney(cashBalance)} €`;
  document.querySelector("#admin-payment-count").textContent = writablePaymentCount;
  document.querySelector("#admin-payment-count").nextElementSibling.textContent = writablePaymentCount ? `${writablePaymentCount} opération${writablePaymentCount > 1 ? "s" : ""}` : "Historique vide";
  document.querySelector("#admin-fund-count").textContent = String(state.contributions.length);
  document.querySelector("#admin-fund-count-icon").textContent = String(state.contributions.length);
  document.querySelector("#admin-fund-count-detail").textContent = state.contributions.length
    ? state.contributions.map((item) => item.name).join(", ")
    : "Aucune caisse active";
}

function renderAll() {
  renderFundSelectors();
  renderHomeContributions();
  renderDetailedContributions();
  renderTransactions();
  renderFundAccount();
  renderActivities();
  renderAdminPayments();
  renderMemberAccess();
  renderMemberStatuses();
  renderFundSettings();
  renderPendingExpenses();
  renderMemberExceptions();
  renderAdminAudit();
  renderPaymentOptions();
  renderExpenseOptions();
  renderScheduleOptions();
  renderSummaries();
  renderIdentity();
  updateNotificationDot();
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
  if (!outstanding && !paid) return "Vous n'avez aucune échéance enregistrée et aucun retard. Aucun paiement en espèces n'est encore enregistré dans vos caisses.";
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
  if (canRecordCash()) return `Les caisses ont encaissé ${formatMoney(totalCollected())} euros, dépensé ${formatMoney(totalExpenses())} euros, et disposent de ${formatMoney(availableTotal())} euros.`;
  return `Vos versements en espèces dans les caisses totalisent ${formatMoney(personalCollected())} euros.`;
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
  setVoiceMessage(command === "details" ? "Vos caisses" : "Votre résumé", text);
  speak(text);
}

function openQuickPayment() {
  if (!canRecordCash()) return showToast("Autorisation Supabase insuffisante.");
  clearPreparedSchedulePayment();
  const preferredFund = state.contributions.find((item) => item.id === adminFundView && item.backendId && canWriteFund(item.id))
    ? adminFundView
    : state.contributions.find((item) => item.backendId && canWriteFund(item.id))?.id;
  if (preferredFund) document.querySelector("#payment-contribution").value = preferredFund;
  document.querySelectorAll("[data-quick-fund]").forEach((button) => button.classList.toggle("active", button.dataset.quickFund === preferredFund));
  setDefaultPaymentDates();
  updateQuickPaymentSummary({ clearAmount: true });
  openSheet("payment-sheet");
}

function openExpense() {
  if (!canRecordCash()) return showToast("Autorisation de dépense insuffisante.");
  const preferredFund = state.contributions.find((item) => item.id === adminFundView && canWriteFund(item.id))
    ? adminFundView
    : writableFundCodes()[0];
  if (preferredFund) document.querySelector("#expense-fund").value = preferredFund;
  document.querySelector("#expense-amount").value = "";
  document.querySelector("#expense-reason").value = "";
  document.querySelector("#expense-beneficiary").value = "";
  document.querySelector("#expense-category").value = "Aide familiale";
  document.querySelector("#expense-receipt").value = "";
  setDefaultPaymentDates();
  renderExpenseOptions();
  openSheet("expense-sheet");
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
  document.querySelector("#fund-config-threshold").value = Number(fund.expense_approval_threshold || 0).toFixed(2);
  document.querySelector("#fund-config-title").textContent = `Configurer ${fund.name}`;
  document.querySelector('#fund-config-form button[type="submit"]').textContent = "Enregistrer la configuration";
  openSheet("fund-config-sheet");
}

function openCreateFund() {
  if (!isAdministrator()) return showToast("Seul un administrateur peut ajouter une caisse.");
  document.querySelector("#fund-config-form").reset();
  document.querySelector("#fund-config-id").value = "";
  document.querySelector("#fund-config-amount").value = "5.00";
  document.querySelector("#fund-config-day").value = "10";
  document.querySelector("#fund-config-start").value = currentMonthValue();
  document.querySelector("#fund-config-threshold").value = "0.00";
  document.querySelector("#fund-config-title").textContent = "Ajouter une caisse";
  document.querySelector('#fund-config-form button[type="submit"]').textContent = "Créer la caisse";
  openSheet("fund-config-sheet");
}

async function submitFundConfiguration(event) {
  event.preventDefault();
  if (workspace?.membership?.role !== "admin") return showToast("Autorisation administrateur requise.");
  const submit = event.target.querySelector('button[type="submit"]');
  const fundId = document.querySelector("#fund-config-id").value;
  submit.disabled = true;
  submit.textContent = fundId ? "Mise à jour des mensualités…" : "Création de la caisse…";
  try {
    const configuration = {
      p_name: document.querySelector("#fund-config-name").value.trim(),
      p_description: document.querySelector("#fund-config-description").value.trim(),
      p_monthly_amount: Number(document.querySelector("#fund-config-amount").value),
      p_start_date: `${document.querySelector("#fund-config-start").value}-01`,
      p_due_day: Number(document.querySelector("#fund-config-day").value)
    };
    if (fundId) {
      await window.JappoBackend.configureFund({ p_fund_id: fundId, ...configuration });
      await window.JappoBackend.setFundExpenseThreshold(fundId, Number(document.querySelector("#fund-config-threshold").value));
    } else {
      const created = await window.JappoBackend.createFund(configuration);
      const createdFund = Array.isArray(created) ? created[0] : created;
      const threshold = Number(document.querySelector("#fund-config-threshold").value);
      if (createdFund?.id && threshold > 0) await window.JappoBackend.setFundExpenseThreshold(createdFund.id, threshold);
    }
    await syncFromBackend({ quiet: true });
    closeSheets();
    showToast(fundId ? "Configuration enregistrée et mensualités recalculées." : "Nouvelle caisse créée et mensualités générées.");
  } catch (error) {
    showToast(error.message || "La caisse n’a pas pu être enregistrée.");
  } finally {
    submit.disabled = false;
    submit.textContent = fundId ? "Enregistrer la configuration" : "Créer la caisse";
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
      const scope = writeFunds.length === workspace.funds.length
        ? "toutes les caisses"
        : writeFunds.map((code) => workspace.funds.find((fund) => fund.code === code)?.name || code).join(", ");
      showToast(`${member.full_name} : ${level === "write" ? `saisie autorisée sur ${scope}` : "lecture seule autorisée"}.`);
    }
  } catch (error) {
    showToast(error.message || "Les droits n’ont pas pu être modifiés.");
    card?.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

function saveSelectedFundAccess(memberId, trigger) {
  const card = trigger.closest(".access-member-card");
  const selected = [...card.querySelectorAll('.fund-access-check input:checked')].map((input) => input.value);
  if (!selected.length) return showToast("Choisissez au moins une caisse, ou utilisez Lecture seule.");
  return reviewMemberAccess(memberId, "approve", "write", selected, trigger);
}

async function reviewExpense(expenseId, decision, trigger) {
  if (!canRecordCash()) return showToast("Autorisation insuffisante.");
  const note = decision === "reject" ? window.prompt("Motif du refus (facultatif)", "") : "";
  if (decision === "reject" && note === null) return;
  trigger.closest(".pending-expense-card")?.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await window.JappoBackend.reviewCashExpense(expenseId, decision, note || null);
    await syncFromBackend({ quiet: true });
    showToast(decision === "approve" ? "Dépense validée et débitée de la caisse." : "Dépense refusée. Le montant réservé est libéré.");
  } catch (error) {
    showToast(error.message || "La décision n’a pas pu être enregistrée.");
  }
}

async function openExpenseReceipt(path) {
  try {
    const url = await window.JappoBackend.createExpenseReceiptUrl(path);
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    showToast(error.message || "Le justificatif n’est pas disponible.");
  }
}

async function submitMemberException(event) {
  event.preventDefault();
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const action = document.querySelector("#exception-action").value;
  const start = document.querySelector("#exception-start").value;
  const end = action === "leave" ? null : document.querySelector("#exception-end").value;
  if (!start || (action !== "leave" && !end) || (end && start > end)) return showToast("Choisissez une période valide.");
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Application…";
  try {
    await window.JappoBackend.setMemberFundException({
      p_member_id: document.querySelector("#exception-member").value,
      p_fund_id: document.querySelector("#exception-fund").value,
      p_action: action,
      p_start_month: `${start}-01`,
      p_end_month: end ? `${end}-01` : null,
      p_note: document.querySelector("#exception-note").value.trim() || null
    });
    await syncFromBackend({ quiet: true });
    event.target.reset();
    document.querySelector("#exception-end-field").classList.remove("hidden");
    showToast("Décision appliquée. Les mois déjà payés sont conservés.");
  } catch (error) {
    showToast(error.message || "La décision n’a pas pu être appliquée.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Appliquer la décision";
  }
}

function openPaymentImport() {
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  paymentImportRows = [];
  document.querySelector("#payment-import-file").value = "";
  renderPaymentImportPreview();
  openSheet("payment-import-sheet");
}

async function readPaymentImportFile(event) {
  const file = event.target.files?.[0];
  paymentImportRows = [];
  if (!file) return renderPaymentImportPreview();
  if (file.size > 5 * 1024 * 1024) return showToast("Le fichier doit peser moins de 5 Mo.");
  const container = document.querySelector("#payment-import-preview");
  container.innerHTML = "<p>Lecture et vérification du fichier…</p>";
  try {
    const table = file.name.toLowerCase().endsWith(".xlsx") ? rowsFromXLSX(await file.arrayBuffer()) : rowsFromCSV(await file.text());
    paymentImportRows = prepareImportRows(table);
    renderPaymentImportPreview();
  } catch (error) {
    paymentImportRows = [];
    renderPaymentImportPreview();
    showToast(error.message || "Le fichier n’a pas pu être lu.");
  }
}

async function submitPaymentImport() {
  if (!isAdministrator() || !paymentImportRows.length || paymentImportRows.some((row) => row.errors.length)) return;
  const button = document.querySelector("#payment-import-submit");
  button.disabled = true;
  button.textContent = "Import sécurisé en cours…";
  try {
    const rows = paymentImportRows.map((row) => ({
      family_id: workspace.membership.family_id,
      member_id: row.member.id,
      fund_id: row.fund.id,
      amount: row.amount,
      payment_date: row.paymentDate,
      note: row.note || null
    }));
    const result = await window.JappoBackend.importCashPayments(workspace.membership.family_id, rows);
    await syncFromBackend({ quiet: true });
    closeSheets();
    showToast(`${result?.imported || rows.length} paiement(s) historique(s) importé(s).`);
  } catch (error) {
    showToast(error.message || "L’import a été annulé sans modifier les données.");
  } finally {
    button.disabled = false;
    button.textContent = "Importer les paiements vérifiés";
  }
}

async function openMeetingMode() {
  if (!backendSession || !workspace?.membership?.active) return showToast("Connectez-vous d’abord à votre fiche.");
  openSheet("meeting-sheet");
  const container = document.querySelector("#meeting-summary-list");
  container.innerHTML = '<div class="empty-state compact-empty"><span>…</span><strong>Calcul des totaux</strong></div>';
  try {
    const funds = await window.JappoBackend.getMeetingSummary(workspace.membership.family_id);
    container.innerHTML = funds.map((fund) => `<article class="meeting-fund-card"><div><small>${escapeHTML(fund.fund_name)}</small><strong>${formatMoney(Number(fund.balance))} €</strong><span>Solde disponible</span></div><dl><div><dt>Attendu</dt><dd>${formatMoney(Number(fund.total_expected))} €</dd></div><div><dt>Collecté</dt><dd>${formatMoney(Number(fund.total_collected))} €</dd></div><div><dt>Dépensé</dt><dd>${formatMoney(Number(fund.total_expenses))} €</dd></div><div><dt>Membres à jour</dt><dd>${fund.up_to_date_count}/${fund.member_count}</dd></div></dl></article>`).join("") || '<div class="empty-state compact-empty"><span>₣</span><strong>Aucune caisse active</strong></div>';
  } catch (error) {
    container.innerHTML = `<div class="empty-state compact-empty"><span>!</span><strong>Totaux indisponibles</strong><p>${escapeHTML(error.message || "Réessayez plus tard.")}</p></div>`;
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

function openReversePayment(paymentId) {
  if (!isAdministrator()) return showToast("Seul un administrateur peut annuler un paiement.");
  const payment = state.payments.find((item) => item.id === paymentId);
  if (!payment) return showToast("Paiement introuvable ou déjà annulé.");
  document.querySelector("#reverse-payment-id").value = payment.id;
  document.querySelector("#reverse-payment-reason").value = "";
  document.querySelector("#reverse-payment-message").textContent = `${formatMoney(payment.amount)} € • ${payment.member} • ${payment.contribution}. La trace restera visible dans Activité.`;
  openSheet("reverse-payment-modal");
  document.querySelector("#reverse-payment-reason").focus({ preventScroll: true });
}

async function reverseCashPayment(event) {
  event.preventDefault();
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const paymentId = document.querySelector("#reverse-payment-id").value;
  const reason = document.querySelector("#reverse-payment-reason").value.trim();
  if (reason.length < 3) return showToast("Indiquez un motif de trois caractères minimum.");
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Annulation…";
  try {
    const reversed = await window.JappoBackend.reverseCashPayment(paymentId, reason);
    const reversedPayment = Array.isArray(reversed) ? reversed[0] : reversed;
    await window.JappoBackend.sendPaymentPush(reversedPayment?.id || paymentId, "reversed").catch(() => null);
    await syncFromBackend({ quiet: true });
    closeSheets();
    showToast("Paiement annulé. La trace et le motif sont conservés dans Activité.");
  } catch (error) {
    showToast(error.message || "Le paiement n’a pas pu être annulé.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Annuler et conserver la trace";
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

function selectedScheduleValues() {
  const memberId = document.querySelector("#schedule-member").value;
  const fundId = document.querySelector("#schedule-fund").value;
  return {
    memberId,
    fundId,
    start: document.querySelector("#schedule-start").value,
    end: document.querySelector("#schedule-end").value,
    member: approvedMembers().find((item) => item.id === memberId),
    fund: workspace?.funds?.find((item) => item.id === fundId)
  };
}

function validScheduleValues({ memberId, member, fund, start, end }) {
  return Boolean(memberId && member && fund && canWriteFund(fund.code) && start && end && start >= "2021-01" && start <= end && end <= scheduleLimitMonthValue());
}

async function saveSelectedSchedule({ memberId, fundId, start, end }) {
  await window.JappoBackend.setMemberFundSchedule({
    p_member_id: memberId,
    p_fund_id: fundId,
    p_start_month: `${start}-01`,
    p_end_month: `${end}-01`
  });
  await syncFromBackend({ quiet: true });
}

async function submitMemberSchedule(event) {
  event.preventDefault();
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const values = selectedScheduleValues();
  if (!validScheduleValues(values)) return showToast(`Choisissez une période comprise entre janvier 2021 et ${formatPeriod(scheduleLimitMonthValue())}.`);
  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Calcul des mensualités…";
  try {
    await saveSelectedSchedule(values);
    showToast("Période enregistrée. Les arriérés ont été recalculés.");
  } catch (error) {
    showToast(error.message || "Les mensualités n’ont pas pu être calculées.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Calculer les mensualités dues";
  }
}

async function prepareUpToDateThroughSchedule() {
  if (!isAdministrator()) return showToast("Autorisation administrateur requise.");
  const values = selectedScheduleValues();
  if (!validScheduleValues(values)) return showToast(`Choisissez une période comprise entre janvier 2021 et ${formatPeriod(scheduleLimitMonthValue())}.`);
  const button = document.querySelector("#schedule-settle-through");
  button.disabled = true;
  button.textContent = "Calcul du montant…";
  try {
    const contribution = state.contributions.find((item) => item.backendId === values.fundId);
    if (!contribution) throw new Error("La caisse sélectionnée n’est pas disponible.");
    const projectedAmount = projectedScheduleOutstanding(values);
    if (projectedAmount <= 0) {
      showToast(`${values.member.full_name} est déjà à jour jusqu’à ${formatPeriod(values.end)}.`);
      return;
    }

    renderPaymentOptions();
    document.querySelector("#payment-member").value = values.memberId;
    document.querySelector("#payment-contribution").value = contribution.id;
    document.querySelectorAll("[data-quick-fund]").forEach((item) => item.classList.toggle("active", item.dataset.quickFund === contribution.id));
    document.querySelector("#payment-schedule-start").value = values.start;
    document.querySelector("#payment-through-month").value = values.end;
    setDefaultPaymentDates();
    document.querySelector("#payment-amount").value = projectedAmount.toFixed(2);
    document.querySelector("#payment-amount").readOnly = true;
    document.querySelector("#payment-note").value = `Mise à jour jusqu’à ${formatPeriod(values.end)}`;
    document.querySelector("#quick-payment-summary").innerHTML = `<span>Mise à jour personnalisée</span><strong>${formatMoney(projectedAmount)} €</strong><small>${formatPeriod(values.start)} à ${formatPeriod(values.end)} • arriérés et mois futurs inclus</small><button class="settle-arrears-button" type="button" disabled>Montant calculé automatiquement</button>`;
    updatePaymentAllocationPreview();
    openSheet("payment-sheet");
    showToast(`Paiement global préparé : ${formatMoney(projectedAmount)} € jusqu’à ${formatPeriod(values.end)}.`);
  } catch (error) {
    showToast(error.message || "La mise à jour jusqu’au mois choisi n’a pas pu être préparée.");
  } finally {
    button.disabled = false;
    updateSchedulePreview();
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
  const scheduleStart = document.querySelector("#payment-schedule-start").value;
  const throughMonth = document.querySelector("#payment-through-month").value;
  const scheduledSettlement = Boolean(scheduleStart && throughMonth);
  if (!contribution?.backendId || !canWriteFund(contributionId) || !memberId || !Number.isFinite(amount) || amount <= 0 || !dateValue) return showToast("Vérifiez vos droits et les informations du paiement.");
  if (scheduledSettlement && (!isAdministrator() || scheduleStart < "2021-01" || scheduleStart > throughMonth || throughMonth > scheduleLimitMonthValue())) return showToast("La période personnalisée n’est plus valide.");
  const allocation = scheduledSettlement ? null : paymentAllocationFor(memberId, contribution.backendId, amount);
  if (!scheduledSettlement && !allocation.outstanding) return showToast("Ce membre est déjà à jour pour cette caisse.");
  if (!scheduledSettlement && allocation.overpayment > 0.001) return showToast(`Le montant maximum accepté est ${formatMoney(allocation.outstanding)} €.`);

  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Enregistrement sécurisé…";
  try {
    const recorded = scheduledSettlement
      ? await window.JappoBackend.recordCashPaymentThroughMonth({
        p_family_id: workspace.membership.family_id,
        p_fund_id: contribution.backendId,
        p_member_id: memberId,
        p_start_month: `${scheduleStart}-01`,
        p_end_month: `${throughMonth}-01`,
        p_payment_date: dateValue,
        p_note: note || null
      })
      : await window.JappoBackend.recordCashPayment({
        p_family_id: workspace.membership.family_id,
        p_fund_id: contribution.backendId,
        p_member_id: memberId,
        p_amount: amount,
        p_payment_date: dateValue,
        p_note: note || null
      });
    const recordedPayment = Array.isArray(recorded) ? recorded[0] : recorded;
    const recordedAmount = Number(recordedPayment?.amount || amount);
    await window.JappoBackend.sendPaymentPush(recordedPayment?.id, "recorded").catch(() => null);
    await syncFromBackend({ quiet: true });
    event.target.reset();
    clearPreparedSchedulePayment();
    renderPaymentOptions();
    setDefaultPaymentDates();
    closeSheets();
    const allocationLabel = scheduledSettlement
      ? `toutes les mensualités jusqu’à ${formatPeriod(throughMonth)} ont été régularisées`
      : allocation.settledMonths
        ? `${allocation.settledMonths} mensualité${allocation.settledMonths > 1 ? "s" : ""} régularisée${allocation.settledMonths > 1 ? "s" : ""}${allocation.partialMonth ? " et la suivante partiellement réglée" : ""}`
        : "la mensualité la plus ancienne partiellement réglée";
    document.querySelector("#confirm-message").textContent = `Le paiement de ${formatMoney(recordedAmount)} € a été enregistré : ${allocationLabel}, arriérés en priorité.`;
    openSheet("confirm-modal");
    speak(`Le paiement en espèces de ${formatMoney(recordedAmount)} euros pour ${contribution.name} est enregistré.`);
  } catch (error) {
    showToast(error.message || "Le paiement n’a pas pu être enregistré.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Enregistrer le paiement en espèces";
  }
}

async function recordCashExpense(event) {
  event.preventDefault();
  if (!canRecordCash() || !backendSession) return showToast("Autorisation Supabase insuffisante.");
  const contributionId = document.querySelector("#expense-fund").value;
  const contribution = state.contributions.find((item) => item.id === contributionId);
  const amount = Number(document.querySelector("#expense-amount").value);
  const dateValue = document.querySelector("#expense-date").value;
  const reason = document.querySelector("#expense-reason").value.trim();
  const beneficiary = document.querySelector("#expense-beneficiary").value.trim();
  const category = document.querySelector("#expense-category").value;
  const receipt = document.querySelector("#expense-receipt").files?.[0] || null;
  if (!contribution?.backendId || !canWriteFund(contributionId) || !Number.isFinite(amount) || amount <= 0 || !dateValue || reason.length < 3) {
    return showToast("Vérifiez la caisse, le montant, la date et le motif.");
  }
  if (amount > fundBalance(contributionId) + 0.001) return showToast(`Le solde disponible est de ${formatMoney(fundBalance(contributionId))} €.`);

  const submit = event.target.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Enregistrement sécurisé…";
  let receiptPath = null;
  try {
    if (receipt) {
      submit.textContent = "Envoi du justificatif…";
      receiptPath = await window.JappoBackend.uploadExpenseReceipt(workspace.membership.family_id, contribution.backendId, receipt);
    }
    submit.textContent = "Enregistrement sécurisé…";
    const recorded = await window.JappoBackend.recordCashExpense({
      p_family_id: workspace.membership.family_id,
      p_fund_id: contribution.backendId,
      p_amount: amount,
      p_expense_date: dateValue,
      p_reason: reason,
      p_beneficiary: beneficiary || null,
      p_category: category,
      p_receipt_path: receiptPath
    });
    const expense = Array.isArray(recorded) ? recorded[0] : recorded;
    await syncFromBackend({ quiet: true });
    event.target.reset();
    setDefaultPaymentDates();
    closeSheets();
    showToast(expense?.status === "pending"
      ? `Dépense de ${formatMoney(amount)} € réservée, en attente d’une seconde validation.`
      : `Dépense de ${formatMoney(amount)} € enregistrée dans ${contribution.name}.`);
  } catch (error) {
    if (receiptPath) await window.JappoBackend.removeExpenseReceipt(receiptPath).catch(() => null);
    showToast(error.message || "La dépense n’a pas pu être enregistrée.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Enregistrer la dépense";
  }
}

function setDefaultPaymentDates() {
  const now = new Date();
  document.querySelector("#payment-date").valueAsDate = now;
  document.querySelector("#expense-date").valueAsDate = now;
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

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function getServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) throw new Error("Service worker indisponible sur ce navigateur.");
  const existing = await navigator.serviceWorker.getRegistration();
  return existing || navigator.serviceWorker.register("./sw.js");
}

function renderNotificationHistory() {
  const container = document.querySelector("#notification-history");
  const activities = state.activities.slice(0, 6);
  container.innerHTML = activities.length
    ? `<h3>Alertes récentes</h3>${activities.map((activity) => `<article><span>${activity.reversed || activity.expense ? "−" : "+"}</span><div><strong>${escapeHTML(activity.title)}</strong><small>${escapeHTML(activity.text)}<br>${escapeHTML(activity.time)}</small></div></article>`).join("")}`
    : '<div class="empty-state compact-empty"><span>🔔</span><strong>Aucune alerte récente</strong></div>';
}

function updateNotificationDot() {
  const latestId = state.activities[0]?.id || "";
  const lastSeen = localStorage.getItem(NOTIFICATION_SEEN_KEY) || "";
  document.querySelector("#notification-dot").classList.toggle("hidden", !latestId || latestId === lastSeen);
}

async function refreshPushStatus() {
  const title = document.querySelector("#push-status-title");
  const detail = document.querySelector("#push-status-detail");
  const button = document.querySelector("#push-toggle-button");
  button.disabled = false;
  if (!pushSupported()) {
    title.textContent = "Notifications non compatibles";
    detail.textContent = "Installez la PWA ou utilisez un navigateur compatible avec les notifications push.";
    button.textContent = "Indisponible sur cet appareil";
    button.disabled = true;
    return false;
  }
  if (!backendSession || !workspace?.membership?.active) {
    title.textContent = "Connexion requise";
    detail.textContent = "Connectez-vous à votre fiche avant d’activer les notifications.";
    button.textContent = "Se connecter d’abord";
    button.disabled = true;
    return false;
  }
  if (!window.__JAPPO_CONFIG__?.vapidPublicKey) {
    title.textContent = "Service push en cours de configuration";
    detail.textContent = "La clé de notification n’est pas encore disponible sur ce déploiement.";
    button.textContent = "Configuration requise";
    button.disabled = true;
    return false;
  }
  const registration = await getServiceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  const active = Notification.permission === "granted" && Boolean(subscription);
  title.textContent = active ? "Notifications activées" : Notification.permission === "denied" ? "Notifications bloquées" : "Notifications désactivées";
  detail.textContent = active
    ? "Cet appareil recevra les paiements enregistrés, les annulations et les rappels de situation."
    : Notification.permission === "denied"
      ? "Autorisez les notifications dans les réglages du navigateur ou du téléphone."
      : "Activez-les pour recevoir les confirmations de paiement et d’annulation.";
  button.textContent = active ? "Désactiver sur cet appareil" : "Activer les notifications";
  button.disabled = Notification.permission === "denied";
  return active;
}

async function openNotifications() {
  renderNotificationHistory();
  if (state.activities[0]?.id) localStorage.setItem(NOTIFICATION_SEEN_KEY, state.activities[0].id);
  updateNotificationDot();
  openSheet("notification-sheet");
  await refreshPushStatus().catch((error) => {
    document.querySelector("#push-status-detail").textContent = error.message || "État des notifications indisponible.";
  });
}

async function togglePushNotifications() {
  if (!pushSupported() || !backendSession || !workspace?.membership?.active) return refreshPushStatus();
  const button = document.querySelector("#push-toggle-button");
  button.disabled = true;
  button.textContent = "Mise à jour…";
  try {
    const registration = await getServiceWorkerRegistration();
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await window.JappoBackend.removePushSubscription(existing.endpoint).catch(() => null);
      await existing.unsubscribe();
      showToast("Notifications désactivées sur cet appareil.");
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Autorisation de notification refusée.");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(window.__JAPPO_CONFIG__.vapidPublicKey)
      });
      const serialized = subscription.toJSON();
      await window.JappoBackend.registerPushSubscription({
        p_endpoint: subscription.endpoint,
        p_p256dh: serialized.keys?.p256dh || "",
        p_auth_key: serialized.keys?.auth || "",
        p_user_agent: navigator.userAgent.slice(0, 300)
      });
      await registration.showNotification("Notifications activées", {
        body: "Vous recevrez ici les confirmations et corrections de paiement.",
        icon: "./assets/icon.svg",
        badge: "./assets/icon.svg",
        tag: "push-enabled"
      });
      showToast("Notifications activées sur cet appareil.");
    }
  } catch (error) {
    showToast(error.message || "Les notifications n’ont pas pu être configurées.");
  } finally {
    await refreshPushStatus().catch(() => null);
  }
}

function handleAction(action) {
  const personalPaymentCount = workspace?.membership
    ? state.payments.filter((payment) => payment.memberId === workspace.membership.id).length
    : 0;
  const messages = {
    "family-switch": "Espace familial actif : Ma famille.",
    documents: personalPaymentCount ? `${personalPaymentCount} reçu${personalPaymentCount > 1 ? "s" : ""} disponible${personalPaymentCount > 1 ? "s" : ""}.` : "Aucun reçu disponible pour le moment.",
    "admin-profile": "Accès réservé à une personne habilitée."
  };
  if (messages[action]) return showToast(messages[action]);
  if (action === "notifications") return openNotifications();
  if (action === "toggle-push") return togglePushNotifications();
  if (action === "record-cash") return openQuickPayment();
  if (action === "record-expense") return openExpense();
  if (action === "settle-arrears") return settlePaymentArrears();
  if (action === "create-fund") return openCreateFund();
  if (action === "meeting-mode") return openMeetingMode();
  if (action === "open-payment-import") return openPaymentImport();
  if (action === "submit-payment-import") return submitPaymentImport();
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
      updateQuickPaymentSummary({ clearAmount: true });
      return;
    }
    const expenseFundButton = event.target.closest("[data-expense-fund]");
    if (expenseFundButton) {
      document.querySelector("#expense-fund").value = expenseFundButton.dataset.expenseFund;
      document.querySelectorAll("[data-expense-fund]").forEach((button) => button.classList.toggle("active", button === expenseFundButton));
      updateExpenseBalancePreview();
      return;
    }
    const editFundButton = event.target.closest("[data-edit-fund]");
    if (editFundButton) return openFundConfig(editFundButton.dataset.editFund);
    const saveFundAccessButton = event.target.closest("[data-save-fund-access]");
    if (saveFundAccessButton) return saveSelectedFundAccess(saveFundAccessButton.dataset.saveFundAccess, saveFundAccessButton);
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
    const reversePaymentButton = event.target.closest("[data-reverse-payment]");
    if (reversePaymentButton) return openReversePayment(reversePaymentButton.dataset.reversePayment);
    const reviewExpenseButton = event.target.closest("[data-review-expense]");
    if (reviewExpenseButton) return reviewExpense(reviewExpenseButton.dataset.reviewExpense, reviewExpenseButton.dataset.expenseDecision, reviewExpenseButton);
    const receiptButton = event.target.closest("[data-expense-receipt]");
    if (receiptButton) return openExpenseReceipt(receiptButton.dataset.expenseReceipt);
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
  document.querySelector("#expense-form").addEventListener("submit", recordCashExpense);
  document.querySelector("#reverse-payment-form").addEventListener("submit", reverseCashPayment);
  document.querySelector("#delete-member-form").addEventListener("submit", deleteFamilyMember);
  document.querySelector("#fund-config-form").addEventListener("submit", submitFundConfiguration);
  document.querySelector("#member-schedule-form").addEventListener("submit", submitMemberSchedule);
  document.querySelector("#member-exception-form").addEventListener("submit", submitMemberException);
  document.querySelector("#admin-password-form").addEventListener("submit", submitAdminPassword);
  document.querySelector("#admin-auth-form").addEventListener("submit", submitAuth);
  document.querySelector("#member-login-form").addEventListener("submit", submitMemberLogin);
  document.querySelector("#membership-request-form").addEventListener("submit", submitMembershipRequest);
  document.querySelector("#payment-member").addEventListener("change", () => { clearPreparedSchedulePayment(); updateQuickPaymentSummary({ clearAmount: true }); });
  document.querySelector("#payment-contribution").addEventListener("change", () => { clearPreparedSchedulePayment(); updateQuickPaymentSummary({ clearAmount: true }); });
  document.querySelector("#payment-amount").addEventListener("input", updatePaymentAllocationPreview);
  document.querySelector("#expense-fund").addEventListener("change", updateExpenseBalancePreview);
  document.querySelector("#expense-amount").addEventListener("input", updateExpenseBalancePreview);
  document.querySelector("#payment-import-file").addEventListener("change", readPaymentImportFile);
  document.querySelector("#exception-action").addEventListener("change", (event) => {
    const departure = event.target.value === "leave";
    document.querySelector("#exception-end-field").classList.toggle("hidden", departure);
    document.querySelector("#exception-end").required = !departure;
  });
  document.querySelector("#member-access-search").addEventListener("input", (event) => {
    memberAccessSearch = event.target.value;
    memberAccessInitialized = true;
    renderMemberAccess();
  });
  document.querySelector("#member-access-filter").addEventListener("change", (event) => {
    memberAccessFilter = event.target.value;
    memberAccessInitialized = true;
    renderMemberAccess();
  });
  document.querySelector("#schedule-member").addEventListener("change", hydrateScheduleForm);
  document.querySelector("#schedule-fund").addEventListener("change", hydrateScheduleForm);
  document.querySelector("#schedule-start").addEventListener("change", updateSchedulePreview);
  document.querySelector("#schedule-end").addEventListener("change", updateSchedulePreview);
  document.querySelector("#schedule-settle-through").addEventListener("click", prepareUpToDateThroughSchedule);
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
