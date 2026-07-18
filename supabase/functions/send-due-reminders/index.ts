import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") return json({ error: "Méthode refusée" }, 405);

    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
      return json({ error: "Appel planifié non autorisé" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:madouyatt95@gmail.com";
    if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
      return json({ error: "Service de rappels incomplet" }, 503);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const today = new Date().toISOString().slice(0, 10);
    const { data: targets, error: targetError } = await admin.rpc("list_due_reminder_targets", { p_today: today });
    if (targetError) return json({ error: targetError.message }, 500);

    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    let membersNotified = 0;
    let notificationsSent = 0;
    let failed = 0;

    for (const target of targets || []) {
      const { data: subscriptions, error: subscriptionError } = await admin
        .from("push_subscriptions")
        .select("id,endpoint,p256dh,auth_key")
        .eq("member_id", target.member_id);
      if (subscriptionError) {
        failed += 1;
        continue;
      }

      const amount = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(target.total_due || 0));
      const title = target.reminder_type === "late" ? "Cotisations en retard" : "Échéance de cotisation";
      const body = target.reminder_type === "late"
        ? `Il reste ${amount} € à régulariser, dont ${target.late_months} mensualité(s) en retard.`
        : `Il reste ${amount} € à régler. Consultez votre fiche pour voir les échéances.`;
      const payload = JSON.stringify({
        title,
        body,
        icon: "/assets/icon.svg",
        badge: "/assets/icon.svg",
        url: "/?notification=dues",
        tag: `dues-${target.member_id}-${target.reminder_type}-${today}`
      });

      let sentForMember = 0;
      for (const subscription of subscriptions || []) {
        try {
          await webpush.sendNotification({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth_key }
          }, payload, { TTL: 86400 });
          sentForMember += 1;
          notificationsSent += 1;
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

      if (sentForMember > 0) {
        membersNotified += 1;
        await admin.from("due_reminder_log").upsert({
          family_id: target.family_id,
          member_id: target.member_id,
          reminder_date: today,
          reminder_type: target.reminder_type,
          sent_count: sentForMember
        }, { onConflict: "member_id,reminder_date,reminder_type" });
      }
    }

    return json({ ok: true, targets: targets?.length || 0, membersNotified, notificationsSent, failed });
  }
};
