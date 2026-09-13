// Safety net for capture-order: if a member's browser dies right after they
// approve the PayPal payment, capture-order's request from the frontend never
// reaches us, so no one ever finalizes their enrollment even though PayPal
// was actually paid. This function listens for PayPal's own "payment
// completed" event and finishes enrollment itself in that case, using the
// name/timezone/birthdate create-order stashed in pending_paypal_orders.
//
// On the normal path, capture-order already deletes that row before this
// event even arrives, so most calls here are a no-op.
//
// IMPORTANT: this function must be deployed with "Enforce JWT verification"
// turned OFF, since PayPal calls it directly with no Supabase auth at all.
// It verifies the request is genuinely from PayPal itself instead, via
// PayPal's own webhook signature check (requires the PAYPAL_WEBHOOK_ID
// secret, from registering this function's URL as a webhook in the PayPal
// Developer Dashboard).

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const secret = Deno.env.get("PAYPAL_SECRET");
  const apiBase = Deno.env.get("PAYPAL_API_BASE");
  const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!clientId || !secret || !apiBase || !webhookId) {
    return new Response("PAYPAL_CLIENT_ID/PAYPAL_SECRET/PAYPAL_API_BASE/PAYPAL_WEBHOOK_ID secrets are not all set", {
      status: 500,
    });
  }

  let event: any;
  try {
    event = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  // Confirm this request genuinely came from PayPal before acting on it.
  const auth = btoa(`${clientId}:${secret}`);
  const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  }).then((r) => r.json());

  if (!tokenRes.access_token) {
    console.error("Could not get a PayPal access token to verify webhook signature");
    return new Response("Could not verify signature", { status: 502 });
  }

  const verifyRes = await fetch(`${apiBase}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenRes.access_token}` },
    body: JSON.stringify({
      auth_algo: req.headers.get("paypal-auth-algo"),
      cert_url: req.headers.get("paypal-cert-url"),
      transmission_id: req.headers.get("paypal-transmission-id"),
      transmission_sig: req.headers.get("paypal-transmission-sig"),
      transmission_time: req.headers.get("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    }),
  }).then((r) => r.json());

  if (verifyRes.verification_status !== "SUCCESS") {
    console.error("PayPal webhook signature verification failed:", verifyRes);
    return new Response("Signature verification failed", { status: 400 });
  }

  // We only act on a completed capture; every other event type is just acknowledged.
  if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
    return new Response("ok");
  }

  const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
  if (!orderId) return new Response("ok");

  const sb = createClient(supabaseUrl!, serviceRoleKey!);

  const { data: pending } = await sb
    .from("pending_paypal_orders")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  // No pending row means capture-order already handled this order normally.
  if (!pending) return new Response("ok");

  const { error } = await sb.rpc("_apply_for_challenge_core", {
    p_member_id: pending.member_id,
    p_name: pending.name,
    p_timezone: pending.timezone,
    p_birthdate: pending.birthdate,
    p_month_offset: pending.month_offset,
  });

  // Whether enrollment succeeded or hit e.g. COHORT_FULL, don't leave the row
  // around for PayPal's retried deliveries of the same event to reprocess --
  // same "contact us" resolution path as the normal flow covers the failure case.
  await sb.from("pending_paypal_orders").delete().eq("order_id", orderId);

  if (error) {
    console.error(`Webhook-driven enrollment failed for order ${orderId}:`, error.message);
  }

  return new Response("ok");
});
