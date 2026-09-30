// Captures a PayPal order and, only once PayPal confirms the charge, enrolls
// the member through _apply_for_challenge_core using the service role. The
// member is identified from their own access token *before* anything is
// captured, so a bad or expired session can never end in a charge with no
// enrollment attempt.
//
// Enrollment deliberately goes through the service role rather than
// apply_for_challenge: that function is being locked down so the only ways
// into a cohort are a confirmed payment here, a valid beta code
// (apply_for_challenge_beta), or the QA test account (apply_for_challenge_test).
//
// If enrollment fails for a business reason (cohort full, duplicate person,
// no open cohort), retrying won't help: the member has been charged with no
// seat, which is surfaced as applyError so the frontend shows the "contact us
// for a refund" message, and the pending_paypal_orders row is cleared. For any
// other failure the pending row is kept, so paypal-webhook can still finish
// enrollment once PayPal reports the capture.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUSINESS_ERRORS = ["COHORT_FULL", "DUPLICATE_PERSON", "NO_OPEN_COHORT"];

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
    const { orderID, name, timezone, birthdate, monthOffset, referralCode } = await req.json();
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
    const { data: cohort, error: applyError } = await adminClient.rpc("_apply_for_challenge_core", {
      p_member_id: userData.user.id,
      p_name: name,
      p_timezone: timezone,
      p_birthdate: birthdate,
      p_month_offset: monthOffset === 1 ? 1 : 0,
      p_referral_code: referralCode || null,
    });

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

    return new Response(JSON.stringify({ paid: true, enrolled: true, cohort, capture }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
