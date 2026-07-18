(function setupJappoBackend(global) {
  "use strict";

  const SESSION_KEY = "jappo-cotiz-supabase-session-v1";
  const config = global.__JAPPO_CONFIG__ || {};
  const baseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const anonKey = String(config.supabaseAnonKey || "");

  function configured() {
    return Boolean(baseUrl && anonKey);
  }

  function readSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY));
      return session?.access_token && session?.refresh_token ? session : null;
    } catch {
      return null;
    }
  }

  function storeSession(session) {
    if (!session?.access_token || !session?.refresh_token) return null;
    const expiresAt = session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
    const stored = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: expiresAt,
      token_type: session.token_type || "bearer"
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
    return stored;
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function captureRedirectSession() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (!hash.get("access_token") || !hash.get("refresh_token")) return null;
    const session = storeSession({
      access_token: hash.get("access_token"),
      refresh_token: hash.get("refresh_token"),
      expires_in: Number(hash.get("expires_in") || 3600),
      token_type: hash.get("token_type") || "bearer"
    });
    history.replaceState({}, document.title, `${location.pathname}${location.search}`);
    return session;
  }

  async function authRequest(path, options = {}) {
    if (!configured()) throw new Error("Supabase n’est pas configuré.");
    const response = await fetch(`${baseUrl}/auth/v1/${path}`, {
      ...options,
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.msg || payload?.message || payload?.error_description || "La connexion a échoué.");
    return payload;
  }

  async function refreshSession(session) {
    try {
      const refreshed = await authRequest("token?grant_type=refresh_token", {
        method: "POST",
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      return storeSession(refreshed);
    } catch (error) {
      clearSession();
      throw error;
    }
  }

  async function initializeSession() {
    const redirected = captureRedirectSession();
    let session = redirected || readSession();
    if (!session) return null;
    if (Number(session.expires_at || 0) <= Math.floor(Date.now() / 1000) + 60) {
      session = await refreshSession(session);
    }
    return session;
  }

  async function sendMagicLink(email) {
    await authRequest("otp", {
      method: "POST",
      body: JSON.stringify({
        email,
        create_user: true,
        data: { full_name: email.split("@")[0] },
        gotrue_meta_security: {},
        email_redirect_to: `${location.origin}${location.pathname}`
      })
    });
  }

  async function signOut() {
    const session = readSession();
    if (session?.access_token) {
      await authRequest("logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` }
      }).catch(() => null);
    }
    clearSession();
  }

  async function rest(path, options = {}) {
    let session = await initializeSession();
    if (!session) throw new Error("Connectez-vous pour accéder aux cotisations.");

    const request = async () => fetch(`${baseUrl}/rest/v1/${path}`, {
      method: options.method || "GET",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {}),
        ...(options.headers || {})
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });

    let response = await request();
    if (response.status === 401) {
      session = await refreshSession(session);
      response = await request();
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || payload?.details || payload?.hint || "Supabase a refusé l’opération.");
    return payload;
  }

  function query(table, parameters) {
    return rest(`${table}?${new URLSearchParams(parameters).toString()}`);
  }

  async function getCurrentUser() {
    const session = await initializeSession();
    if (!session) return null;
    try {
      return await authRequest("user", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
    } catch (error) {
      clearSession();
      throw error;
    }
  }

  async function loadWorkspace() {
    const user = await getCurrentUser();
    if (!user) return null;

    const memberships = await query("family_members", {
      select: "id,family_id,user_id,full_name,role,active",
      user_id: `eq.${user.id}`,
      active: "eq.true",
      limit: "1"
    });
    const membership = memberships[0] || null;
    if (!membership) return { user, membership: null, family: null, funds: [], periods: [], payments: [], members: [] };

    const familyId = membership.family_id;
    const authorized = ["admin", "treasurer", "cash_collector"].includes(membership.role);
    const [families, funds, periods, payments, members] = await Promise.all([
      query("family_spaces", { select: "id,name,currency", id: `eq.${familyId}`, limit: "1" }),
      query("funds", { select: "id,code,name,description,monthly_amount,frequency,start_date,due_day,display_order,active", family_id: `eq.${familyId}`, active: "eq.true", order: "display_order.asc" }),
      query("contribution_periods", {
        select: "id,family_id,fund_id,member_id,period_start,due_date,amount_due,amount_paid,status",
        ...(authorized ? { family_id: `eq.${familyId}` } : { member_id: `eq.${membership.id}` }),
        order: "period_start.desc"
      }),
      query("cash_payments", {
        select: "id,family_id,fund_id,member_id,amount,method,payment_date,period_start,note,recorded_by,created_at",
        ...(authorized ? { family_id: `eq.${familyId}` } : { member_id: `eq.${membership.id}` }),
        reversed_at: "is.null",
        order: "payment_date.desc,created_at.desc"
      }),
      authorized
        ? query("family_members", { select: "id,full_name,user_id,role", family_id: `eq.${familyId}`, active: "eq.true", order: "full_name.asc" })
        : Promise.resolve([membership])
    ]);

    return {
      user,
      membership,
      family: families[0] || null,
      funds,
      periods,
      payments,
      members
    };
  }

  async function callRpc(name, parameters) {
    return rest(`rpc/${name}`, {
      method: "POST",
      body: parameters
    });
  }

  async function recordCashPayment(payment) {
    return callRpc("record_cash_payment", payment);
  }

  async function configureFund(configuration) {
    return callRpc("configure_fund", configuration);
  }

  global.JappoBackend = Object.freeze({
    configured,
    initializeSession,
    readSession,
    sendMagicLink,
    signOut,
    loadWorkspace,
    recordCashPayment,
    configureFund
  });
})(window);
