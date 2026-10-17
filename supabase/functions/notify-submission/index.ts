// Emails the team's own Gmail when a member submits today's Writing or Speaking,
// so leaders know there is something new to give feedback on. Same Gmail SMTP
// secrets as the other notify-* functions (SMTP_USERNAME / SMTP_PASSWORD).
//
// Called from the browser right after the submission is saved, with the member's
// own login token. Keep "Verify JWT" turned ON for this function (the default):
// the gateway rejects calls without a valid login, and the code below also
// re-checks that the caller really has that submission saved, so nobody can use
// this to send arbitrary emails.
//
// The email never contains the submitted photo or audio, only who submitted what.

import nodemailer from "npm:nodemailer@^7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SITE_URL = "https://engkorkorean.com/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const row = (label: string, value: string) =>
  `<tr><td style="padding:4px 16px 4px 0; color:#666;">${label}</td><td style="padding:4px 0;"><strong>${escapeHtml(value)}</strong></td></tr>`;

const kst = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: "Asia/Seoul", dateStyle: "long", timeStyle: "short" }) + " (KST)";

// part -> [label in the email, submissions column that holds the upload]
const PARTS: Record<string, [string, string]> = {
  diary: ["Writing", "diary_url"],
  shadowing: ["Speaking", "shadowing_url"],
};

// Best-effort throttle: if someone re-uploads the same part over and over within
// a few minutes, only the first one emails the team. (Resets when the function
// restarts, which is fine for this purpose.)
const THROTTLE_MS = 10 * 60 * 1000;
const lastSent = new Map<string, number>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!SMTP_USERNAME || !SMTP_PASSWORD || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "SMTP_USERNAME/SMTP_PASSWORD secrets are not set on this function" }, 500);
  }

  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData?.user) return json({ error: "Not logged in" }, 401);
    const user = userData.user;

    const { part, date } = await req.json();
    const info = PARTS[part];
    if (!info || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ error: "Invalid 'part' or 'date'" }, 400);
    }
    const [label, column] = info;

    // The caller must really have this upload saved (selects only the id, not the file).
    const { data: saved } = await admin
      .from("submissions")
      .select("id")
      .eq("member_id", user.id)
      .eq("date", date)
      .not(column, "is", null)
      .maybeSingle();
    if (!saved) return json({ error: "No such submission" }, 404);

    const key = `${user.id}|${date}|${part}`;
    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < THROTTLE_MS) return json({ ok: true, skipped: "recently sent" });
    lastSent.set(key, now);

    // Members can choose a nickname that leaders see instead of their real name, so
    // the alert shows the nickname when there is one (and no email address).
    // Falls back to the old column list if the nickname column doesn't exist yet.
    let { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("name, nickname, role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) {
      ({ data: profile } = await admin.from("profiles").select("name, role").eq("id", user.id).maybeSingle());
    }
    if (profile?.role === "leader") return json({ ok: true, skipped: "leader" });

    const name = profile?.nickname || profile?.name || "(name unknown)";

    const html =
      `<div style="font-family:sans-serif; font-size:16px; line-height:1.6; color:#222;">` +
      `<p style="font-size:18px;">A member just submitted their ${label} and is waiting for feedback.</p>` +
      `<table style="border-collapse:collapse; font-size:16px;">` +
      row("Member", name) +
      row("Submitted", label) +
      row("For date", date) +
      row("Sent at", kst(new Date())) +
      `</table>` +
      `<p><a href="${SITE_URL}">Open the dashboard</a></p>` +
      `</div>`;

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"EngKor" <${SMTP_USERNAME}>`,
      to: SMTP_USERNAME,
      subject: `[EngKor] New ${label} submission: ${name}`,
      html,
    });

    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
