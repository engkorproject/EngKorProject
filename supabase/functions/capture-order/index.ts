// Captures a PayPal order, and only if that succeeds, enrolls the member by
// calling apply_for_challenge as *them* (forwarding their own Supabase access
// token, not the service role) so auth.uid()/RLS inside that function still
// resolve correctly. This mirrors the existing Paddle "checkout.completed ->
// completeRenewal() -> apply_for_challenge" pattern in index.html: no one is
// enrolled without paying, and no one is charged without an enrollment attempt.
//
// If capture succeeds but apply_for_challenge then fails (e.g. COHORT_FULL,
// a capacity race), the member has already been charged with no seat --
// that's surfaced to the frontend as applyError so it can show the same
// "contact us for a refund" messaging already used for the renewal path.
//
// Either way, once this function has handled the order it deletes the
// matching pending_paypal_orders row (see create-order) so paypal-webhook's
// safety net leaves it alone -- that row's only job is to cover the case
// where this request never arrives at all.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    const { orderID, name, timezone, birthdate, monthOffset } = await req.json();
    if (!orderID || !name || !timezone || !birthdate) {
      return new Response(JSON.stringify({ error: "orderID, name, timezone, and birthdate are all required" }), {
        status: 400,
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

    // Client created with the member's own JWT (not the service role), so this
    // RPC call runs as them -- required since apply_for_challenge relies on
    // auth.uid() and is only granted to the "authenticated" role.
    const sb = createClient(supabaseUrl!, supabaseAnonKey!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: cohort, error: applyError } = await sb.rpc("apply_for_challenge", {
      p_name: name,
      p_timezone: timezone,
      p_birthdate: birthdate,
      p_month_offset: monthOffset === 1 ? 1 : 0,
    });

    // This request reaching us at all means the webhook's fallback is no
    // longer needed for this order, whether enrollment itself succeeded or not.
    const adminClient = createClient(supabaseUrl!, serviceRoleKey!);
    const { error: deleteError } = await adminClient.from("pending_paypal_orders").delete().eq("order_id", orderID);
    if (deleteError) console.error("Could not clear pending_paypal_orders row:", deleteError.message);

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
