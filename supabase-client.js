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

  async function signInWithPassword(email, password) {
    const session = await authRequest("token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    return storeSession(session);
  }

  async function signInAnonymously(pseudo) {
    const session = await authRequest("signup", {
      method: "POST",
      body: JSON.stringify({
        data: { full_name: pseudo, pseudo },
        gotrue_meta_security: {}
      })
    });
    return storeSession(session);
  }

  async function updatePassword(password) {
    const session = await initializeSession();
    if (!session) throw new Error("Reconnectez-vous avant de définir le mot de passe.");
    return authRequest("user", {
      method: "PUT",
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ password })
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

  async function publicRest(path, options = {}) {
    if (!configured()) throw new Error("Supabase n’est pas configuré.");
    const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      method: options.method || "GET",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
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
      select: "id,family_id,user_id,full_name,pseudo,role,active,approval_status,access_level,write_fund_codes,joined_on,created_at,reviewed_at,login_code_issued_at",
      user_id: `eq.${user.id}`,
      limit: "1"
    });
    const membership = memberships[0] || null;
    if (!membership) return { user, membership: null, family: null, funds: [], periods: [], payments: [], activityPayments: [], members: [], schedules: [] };

    const approved = membership.active && membership.approval_status === "approved";
    if (!approved) {
      return { user, membership, family: null, funds: [], periods: [], payments: [], activityPayments: [], members: [membership], schedules: [] };
    }

    const familyId = membership.family_id;
    const authorized = membership.access_level === "write" && ["admin", "treasurer", "cash_collector"].includes(membership.role);
    const administrator = authorized && membership.role === "admin";
    const [families, funds, periods, payments, activityPayments, members, schedules] = await Promise.all([
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
      callRpc("list_payment_activity", { p_family_id: familyId }),
      authorized
        ? query("family_members", {
          select: "id,full_name,pseudo,user_id,role,active,approval_status,access_level,write_fund_codes,joined_on,created_at,reviewed_at,login_code_issued_at",
          family_id: `eq.${familyId}`,
          ...(administrator ? {} : { active: "eq.true", approval_status: "eq.approved" }),
          order: "created_at.desc"
        })
        : Promise.resolve([membership]),
      query("member_fund_schedules", {
        select: "id,family_id,member_id,fund_id,start_month,end_month,active,updated_at",
        family_id: `eq.${familyId}`,
        active: "eq.true",
        order: "updated_at.desc"
      })
    ]);

    return {
      user,
      membership,
      family: families[0] || null,
      funds,
      periods,
      payments,
      activityPayments,
      members,
      schedules
    };
  }

  async function callRpc(name, parameters) {
    return rest(`rpc/${name}`, {
      method: "POST",
      body: parameters
    });
  }

  async function publicRpc(name, parameters) {
    return publicRest(`rpc/${name}`, {
      method: "POST",
      body: parameters
    });
  }

  async function requestPseudoMembership(pseudo) {
    return publicRpc("request_pseudo_membership", { p_pseudo: pseudo });
  }

  async function signInMember(pseudo, code) {
    const prepared = await publicRpc("prepare_member_login", { p_pseudo: pseudo, p_code: code });
    if (!prepared?.ok || !prepared?.claim_token) throw new Error(prepared?.message || "Pseudo ou code incorrect.");
    try {
      const session = await signInAnonymously(pseudo);
      await callRpc("claim_member_login", { p_claim_token: prepared.claim_token });
      return session;
    } catch (error) {
      clearSession();
      throw error;
    }
  }

  async function recordCashPayment(payment) {
    return callRpc("record_cash_payment", payment);
  }

  async function configureFund(configuration) {
    return callRpc("configure_fund", configuration);
  }

  async function reviewMemberAccess(review) {
    return callRpc("review_member_access", review);
  }

  async function resetMemberLoginCode(memberId) {
    return callRpc("reset_member_login_code", { p_member_id: memberId });
  }

  async function setMemberFundSchedule(schedule) {
    return callRpc("set_member_fund_schedule", schedule);
  }

  async function deleteFamilyMember(memberId, confirmation) {
    return callRpc("delete_family_member", {
      p_member_id: memberId,
      p_confirmation: confirmation
    });
  }

  global.JappoBackend = Object.freeze({
    configured,
    initializeSession,
    readSession,
    sendMagicLink,
    signInWithPassword,
    signInAnonymously,
    updatePassword,
    signOut,
    loadWorkspace,
    requestPseudoMembership,
    signInMember,
    recordCashPayment,
    configureFund,
    reviewMemberAccess,
    resetMemberLoginCode,
    setMemberFundSchedule,
    deleteFamilyMember
  });
})(window);
