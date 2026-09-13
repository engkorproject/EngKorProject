// Creates a PayPal order for one month of the challenge (Orders API v2, not
// Subscriptions -- members pay fresh each time they apply, see the PayPal
// handoff doc in EngKor_Resources for why). PAYPAL_CLIENT_ID/SECRET/API_BASE
// are Supabase secrets; never hardcode them here.
//
// Also stashes the member's name/timezone/birthdate in pending_paypal_orders
// (service role only, RLS-hidden from everyone else) before checkout even
// opens. If the member's browser dies right after they approve the PayPal
// payment, capture-order's request from the frontend never arrives -- the
// paypal-webhook function then uses this stashed row to finish enrollment on
// its own. On the normal path, capture-order deletes this row once it's done.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CURRENT_PRICE = "5.50"; // pilot price; bump this when the price changes

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
    const body = await req.json().catch(() => ({}));
    const { name, timezone, birthdate, referralCode } = body;
    const intent = body.intent === "renewal" ? "renewal" : "initial";
    const monthOffset = body.monthOffset === 1 ? 1 : 0;

    if (!name || !timezone || !birthdate) {
      return new Response(JSON.stringify({ error: "name, timezone, and birthdate are all required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    const order = await fetch(`${apiBase}/v2/checkout/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenRes.access_token}` },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: CURRENT_PRICE },
            // e.g. initial_2026-10, renewal_2026-11: tracking only, not read by capture-order/webhook
            custom_id: `${intent}_${new Date().toISOString().slice(0, 7)}`,
          },
        ],
      }),
    }).then((r) => r.json());

    if (!order.id) {
      return new Response(JSON.stringify({ error: "Could not create PayPal order", detail: order }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl!, serviceRoleKey!);
    const { error: pendingError } = await adminClient.from("pending_paypal_orders").insert({
      order_id: order.id,
      member_id: userData.user.id,
      name,
      timezone,
      birthdate,
      month_offset: monthOffset,
      referral_code: referralCode || null,
    });
    if (pendingError) {
      // Not fatal to checkout itself, but the webhook safety net won't work
      // for this order if this failed -- worth knowing about.
      console.error("Could not stash pending_paypal_orders row:", pendingError.message);
    }

    return new Response(JSON.stringify({ id: order.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
