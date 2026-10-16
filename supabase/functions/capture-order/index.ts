// Captures a PayPal order and, only once PayPal confirms the charge, enrolls
// the member through _enroll_30day_core using the service role: a 30-day pass
// from the member's local today, or right after the pass they already have.
// The order ID is passed along, so if paypal-webhook also enrolls the same
// order, the member still gets exactly one pass. The
// member is identified from their own access token *before* anything is
// captured, so a bad or expired session can never end in a charge with no
// enrollment attempt.
//
// Enrollment deliberately goes through the service role: the only ways to get
// a pass are a confirmed payment here, a valid code (enroll_with_code), or the
// QA test account (enroll_for_challenge_test).
//
// If enrollment fails for a business reason (duplicate person), retrying won't
// help: the member has been charged with no pass, which is surfaced as
// applyError so the frontend shows the "contact us for a refund" message, and
// the pending_paypal_orders row is cleared. For any
// other failure the pending row is kept, so paypal-webhook can still finish
// enrollment once PayPal reports the capture.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUSINESS_ERRORS = ["DUPLICATE_PERSON", "MEMBER_NOT_FOUND"];

// Paid enrollment is closed to EU and UK buyers until we've confirmed how VAT
// applies to EngKor there (non-EU sellers can owe it from the first sale).
// Matched against the buyer's PayPal country, so a VPN doesn't get around it.
// Keep in sync with PAYMENT_BLOCKED_REGIONS in index.html.
const BLOCKED_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const secret = Deno.env.get("PAYPAL_SECRET");
  const apiBase = Deno.env.get("PAYPAL_API_BASE");
  // Auto-injected by Supabase for every Edge Function; not custom secrets.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!clientId || !secret || !apiBase) {
    return new Response(
      JSON.stringify({ error: "PAYPAL_CLIENT_ID/PAYPAL_SECRET/PAYPAL_API_BASE secrets are not set on this function" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header (must be the member's own access token)" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { orderID, name, timezone, birthdate, referralCode } = await req.json();
    if (!orderID || !name || !timezone || !birthdate) {
      return new Response(JSON.stringify({ error: "orderID, name, timezone, and birthdate are all required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Identify the member before capturing, so an invalid session never charges.
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    const authClient = createClient(supabaseUrl!, supabaseAnonKey!);
    const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid or expired access token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const auth = btoa(`${clientId}:${secret}`);
    const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    }).then((r) => r.json());

    if (!tokenRes.access_token) {
      return new Response(JSON.stringify({ error: "Could not get a PayPal access token", detail: tokenRes }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Checked before capture, so a blocked buyer is never charged: an approved
    // but uncaptured order just expires on PayPal's side.
    const order = await fetch(`${apiBase}/v2/checkout/orders/${orderID}`, {
      headers: { Authorization: `Bearer ${tokenRes.access_token}` },
    }).then((r) => r.json());
    const buyerCountry =
      order.payer?.address?.country_code ??
      order.payment_source?.paypal?.address?.country_code ??
      order.payment_source?.card?.billing_address?.country_code ??
      null;
    if (!buyerCountry) console.warn(`No buyer country on order ${orderID}; capturing without the region check`);
    if (buyerCountry && BLOCKED_COUNTRIES.includes(buyerCountry)) {
      const { error: deleteError } = await createClient(supabaseUrl!, serviceRoleKey!)
        .from("pending_paypal_orders")
        .delete()
        .eq("order_id", orderID);
      if (deleteError) console.error("Could not clear pending_paypal_orders row:", deleteError.message);
      return new Response(JSON.stringify({ paid: false, error: "REGION_NOT_SUPPORTED", country: buyerCountry }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const capture = await fetch(`${apiBase}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenRes.access_token}`, "Content-Type": "application/json" },
    }).then((r) => r.json());

    if (capture.status !== "COMPLETED") {
      return new Response(JSON.stringify({ error: "Payment was not completed", detail: capture }), {
        status: 402,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl!, serviceRoleKey!);

    // Record the payment as soon as PayPal confirms it, before and regardless of
    // enrollment: we need it for refunds and the 5-year retention rule even if
    // enrollment then fails. A failure here is logged but never blocks enrollment.
    const captureInfo = capture.purchase_units?.[0]?.payments?.captures?.[0];
    const { error: recordError } = await adminClient.from("payment_records").upsert(
      {
        paypal_order_id: orderID,
        paypal_capture_id: captureInfo?.id ?? null,
        member_id: userData.user.id,
        email: userData.user.email ?? null,
        name,
        amount: captureInfo?.amount?.value ? Number(captureInfo.amount.value) : null,
        currency: captureInfo?.amount?.currency_code ?? null,
      },
      { onConflict: "paypal_order_id", ignoreDuplicates: true }
    );
    if (recordError) console.error(`Could not write payment_records for order ${orderID}:`, recordError.message);

    let { data: pass, error: applyError } = await adminClient.rpc("_enroll_30day_core", {
      p_member_id: userData.user.id,
      p_name: name,
      p_timezone: timezone,
      p_birthdate: birthdate,
      p_referral_code: referralCode || null,
      p_order_id: orderID,
    });

    // paypal-webhook may have enrolled this exact order a moment earlier: that's a success.
    if (applyError && applyError.message.includes("duplicate key")) {
      const { data: existing } = await adminClient.from("applications").select("*").eq("paypal_order_id", orderID).maybeSingle();
      if (existing) { pass = existing; applyError = null; }
    }

    if (!applyError && pass?.id) {
      await adminClient
        .from("payment_records")
        .update({ starts_on: pass.starts_on, ends_on: pass.ends_on })
        .eq("paypal_order_id", orderID);
    }

    const isBusinessError = !!applyError && BUSINESS_ERRORS.some((code) => applyError.message.includes(code));
    if (!applyError || isBusinessError) {
      const { error: deleteError } = await adminClient.from("pending_paypal_orders").delete().eq("order_id", orderID);
      if (deleteError) console.error("Could not clear pending_paypal_orders row:", deleteError.message);
    } else {
      console.error(
        `Enrollment failed after capture for order ${orderID}; keeping pending row for paypal-webhook:`,
        applyError.message
      );
    }

    if (applyError) {
      return new Response(
        JSON.stringify({ paid: true, enrolled: false, error: applyError.message, capture }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ paid: true, enrolled: true, pass, capture }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
