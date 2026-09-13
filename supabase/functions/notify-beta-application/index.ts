// Emails the team's own Gmail whenever a beta-tester application comes in, so
// no one has to sit in Supabase watching the applications table. Triggered by
// a Supabase Database Webhook on applications INSERT (see Supabase dashboard
// Database > Webhooks) -- it fires on every new application, and this
// function simply no-ops unless that row's is_beta is true.
//
// IMPORTANT: this function must be deployed with "Enforce JWT verification"
// turned OFF, since a Database Webhook call carries no member login. Instead
// it's guarded by a shared secret (DB_WEBHOOK_SECRET) that must be set as a
// custom header on the webhook in the Supabase dashboard.

import nodemailer from "npm:nodemailer@^7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const WEBHOOK_SECRET = Deno.env.get("DB_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (!SMTP_USERNAME || !SMTP_PASSWORD || !WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ error: "SMTP_USERNAME/SMTP_PASSWORD/DB_WEBHOOK_SECRET secrets are not all set on this function" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "Invalid webhook secret" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json();
    const record = payload.record;

    // Most applications aren't beta ones -- nothing to do, and no email sent.
    if (!record || record.is_beta !== true) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const [{ data: profile }, { data: userData }] = await Promise.all([
      admin.from("profiles").select("name").eq("id", record.member_id).maybeSingle(),
      admin.auth.admin.getUserById(record.member_id),
    ]);

    const name = profile?.name || "(name unknown)";
    const email = userData?.user?.email || "(email unknown)";

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"EngKor" <${SMTP_USERNAME}>`,
      to: SMTP_USERNAME,
      subject: "New beta tester application",
      text:
        `A new application just came in with the beta referral code.\n\n` +
        `Name: ${name}\n` +
        `Email: ${email}\n` +
        `Cohort: ${record.cohort_id}\n` +
        `Applied at: ${record.created_at}\n`,
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
