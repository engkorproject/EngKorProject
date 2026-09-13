// Creates a PayPal order for one month of the challenge (Orders API v2, not
// Subscriptions -- members pay fresh each time they apply, see the PayPal
// handoff doc in EngKor_Resources for why). PAYPAL_CLIENT_ID/SECRET/API_BASE
// are Supabase secrets; never hardcode them here.

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

  if (!clientId || !secret || !apiBase) {
    return new Response(
      JSON.stringify({ error: "PAYPAL_CLIENT_ID/PAYPAL_SECRET/PAYPAL_API_BASE secrets are not set on this function" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const intent = body.intent === "renewal" ? "renewal" : "initial";

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
            // e.g. initial_2026-10, renewal_2026-11: tracking only, not read by capture-order
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
