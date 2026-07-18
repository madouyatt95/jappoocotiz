import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createSupabaseContext } from "jsr:@supabase/server@^1";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

export default {
  async fetch(request: Request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (request.method !== "POST") return json({ error: "Méthode refusée" }, 405);

    const { data: context, error: contextError } = await createSupabaseContext(request, { auth: "user" });
    if (contextError || !context) return json({ error: contextError?.message || "Session invalide" }, contextError?.status || 401);
    const actorId = String(context.jwtClaims?.sub || "");
    if (!actorId) return json({ error: "Session invalide" }, 401);

    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:madouyatt95@gmail.com";
    if (!vapidPublicKey || !vapidPrivateKey) return json({ error: "Service push non configuré" }, 503);
    const admin = context.supabaseAdmin;

    const body = await request.json().catch(() => ({}));
    const paymentId = String(body?.payment_id || "");
    const eventType = body?.event_type === "reversed" ? "reversed" : "recorded";
    if (!paymentId) return json({ error: "Paiement manquant" }, 400);

    const { data: payment, error: paymentError } = await admin
      .from("cash_payments")
      .select("id,family_id,fund_id,member_id,amount,recorded_by,reversed_by,reversed_at,reversal_reason")
      .eq("id", paymentId)
      .maybeSingle();
    if (paymentError || !payment) return json({ error: "Paiement introuvable" }, 404);

    const actorMatches = eventType === "recorded"
      ? payment.recorded_by === actorId
      : payment.reversed_by === actorId && Boolean(payment.reversed_at);
    if (!actorMatches) return json({ error: "Événement non autorisé" }, 403);

    const [{ data: fund }, { data: member }, { data: subscriptions, error: subscriptionsError }] = await Promise.all([
      admin.from("funds").select("name").eq("id", payment.fund_id).maybeSingle(),
      admin.from("family_members").select("full_name").eq("id", payment.member_id).maybeSingle(),
      admin.from("push_subscriptions").select("id,endpoint,p256dh,auth_key").eq("member_id", payment.member_id)
    ]);
    if (subscriptionsError) return json({ error: "Abonnements indisponibles" }, 500);
    if (!subscriptions?.length) return json({ ok: true, sent: 0, reason: "Aucun appareil abonné" });

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    const amount = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(payment.amount || 0));
    const title = eventType === "reversed" ? "Paiement annulé" : "Paiement enregistré";
    const notificationBody = eventType === "reversed"
      ? `${fund?.name || "Caisse"} : ${amount} € annulés. Motif : ${payment.reversal_reason || "correction administrative"}.`
      : `${fund?.name || "Caisse"} : ${amount} € enregistrés pour ${member?.full_name || "votre fiche"}.`;
    const payload = JSON.stringify({
      title,
      body: notificationBody,
      icon: "/assets/icon.svg",
      badge: "/assets/icon.svg",
      url: "/?notification=payment",
      tag: `payment-${payment.id}-${eventType}`
    });

    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth_key }
        }, payload, { TTL: 86400 });
        sent += 1;
      } catch (error) {
        failed += 1;
        const statusCode = Number(
          error && typeof error === "object" && "statusCode" in error
            ? (error as { statusCode?: number }).statusCode || 0
            : 0
        );
        if (statusCode === 404 || statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("id", subscription.id);
        }
      }
    }

    return json({ ok: true, sent, failed });
  }
};
