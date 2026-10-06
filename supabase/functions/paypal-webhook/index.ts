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

const BUSINESS_ERRORS = ["COHORT_FULL", "DUPLICATE_PERSON", "NO_OPEN_COHORT"];

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

  // Record the payment whether or not capture-order got to it. ignoreDuplicates
  // keeps capture-order's row (which has the member's email) if it exists.
  let email: string | null = null;
  if (pending) {
    const { data: userRes } = await sb.auth.admin.getUserById(pending.member_id);
    email = userRes?.user?.email ?? null;
  }
  const { error: recordError } = await sb.from("payment_records").upsert(
    {
      paypal_order_id: orderId,
      paypal_capture_id: event.resource?.id ?? null,
      member_id: pending?.member_id ?? null,
      email,
      name: pending?.name ?? null,
      amount: event.resource?.amount?.value ? Number(event.resource.amount.value) : null,
      currency: event.resource?.amount?.currency_code ?? null,
    },
    { onConflict: "paypal_order_id", ignoreDuplicates: true }
  );
  if (recordError) console.error(`Could not write payment_records for order ${orderId}:`, recordError.message);

  // No pending row means capture-order already handled this order normally.
  if (!pending) return new Response("ok");

  const { data: cohort, error } = await sb.rpc("_apply_for_challenge_core", {
    p_member_id: pending.member_id,
    p_name: pending.name,
    p_timezone: pending.timezone,
    p_birthdate: pending.birthdate,
    p_month_offset: pending.month_offset,
    p_referral_code: pending.referral_code || null,
  });

  // Retrying only helps for unexpected failures (DB hiccup, timeout). For those
  // we keep the pending row and answer 500 so PayPal redelivers the event later
  // and enrollment is tried again. Business errors (cohort full, duplicate
  // person, no open cohort) won't change on retry, and a unique-key clash means
  // capture-order already enrolled them, so those end here like a success.
  const message = error?.message || "";
  const alreadyEnrolled = message.includes("duplicate key");
  const done = !error || alreadyEnrolled || BUSINESS_ERRORS.some((code) => message.includes(code));

  if (!done) {
    console.error(`Webhook-driven enrollment failed for order ${orderId}, asking PayPal to retry:`, message);
    return new Response("Enrollment failed, please retry", { status: 500 });
  }

  await sb.from("pending_paypal_orders").delete().eq("order_id", orderId);

  if (error && !alreadyEnrolled) {
    console.error(`Webhook-driven enrollment failed for order ${orderId}:`, message);
  } else if (cohort?.id) {
    await sb
      .from("payment_records")
      .update({ cohort_id: cohort.id, cohort_label: cohort.label ?? null })
      .eq("paypal_order_id", orderId);
  }

  return new Response("ok");
});
