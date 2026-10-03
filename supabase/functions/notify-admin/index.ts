// Emails the team's own Gmail when (1) a new member confirms their email, or
// (2) a payment is recorded. Same Gmail SMTP secrets as the other notify-*
// functions.
//
// Two callers, both guarded by the NOTIFY_ADMIN_SECRET shared secret sent in
// the x-webhook-secret header:
//   - MEMBER_CONFIRMED: the on_auth_user_email_confirmed trigger on auth.users
//     (SQL 23) posts here via pg_net the moment email_confirmed_at goes from
//     empty to set, so people who sign up but never confirm are not reported.
//   - payment_records INSERT: a Supabase Database Webhook (dashboard).
//
// IMPORTANT: deploy with "Verify JWT" turned OFF, since neither caller carries
// a member login. The shared secret is the guard instead.

import nodemailer from "npm:nodemailer@^7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const NOTIFY_SECRET = Deno.env.get("NOTIFY_ADMIN_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const kst = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Seoul", dateStyle: "long", timeStyle: "short" }) + " (KST)"
    : "(unknown)";

const row = (label: string, value: string) =>
  `<tr><td style="padding:4px 16px 4px 0; color:#666;">${label}</td><td style="padding:4px 0;"><strong>${escapeHtml(value)}</strong></td></tr>`;

const emailHtml = (intro: string, rows: string) =>
  `<div style="font-family:sans-serif; font-size:16px; line-height:1.6; color:#222;">` +
  `<p style="font-size:18px;">${intro}</p>` +
  `<table style="border-collapse:collapse; font-size:16px;">${rows}</table>` +
  `</div>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!SMTP_USERNAME || !SMTP_PASSWORD || !NOTIFY_SECRET || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "SMTP_USERNAME/SMTP_PASSWORD/NOTIFY_ADMIN_SECRET secrets are not all set on this function" }, 500);
  }
  if (req.headers.get("x-webhook-secret") !== NOTIFY_SECRET) {
    return json({ error: "Invalid webhook secret" }, 401);
  }

  try {
    const payload = await req.json();
    const record = payload.record || {};
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    let subject: string;
    let html: string;

    if (payload.type === "MEMBER_CONFIRMED") {
      const { data: profile } = await admin
        .from("profiles")
        .select("name, role")
        .eq("id", record.id)
        .maybeSingle();

      // Confirmed members so far. Fine to page through at our scale.
      let confirmedCount = "(unknown)";
      try {
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        confirmedCount = String((list?.users || []).filter((u) => u.email_confirmed_at).length);
      } catch (_) {
        // Count is a nice-to-have; never fail the alert over it.
      }

      const name = profile?.name || "(name unknown)";
      subject = `[EngKor] New member: ${name}`;
      html = emailHtml(
        "A new member just confirmed their email and can now log in.",
        row("Name", name) +
          row("Email", record.email || "(email unknown)") +
          row("Role", profile?.role || "member") +
          row("Confirmed at", kst(record.confirmed_at)) +
          row("Confirmed members", confirmedCount)
      );
    } else if (payload.table === "payment_records" && payload.type === "INSERT") {
      const amount =
        record.amount != null ? `${Number(record.amount).toFixed(2)} ${record.currency || ""}`.trim() : "(unknown)";
      const name = record.name || "(name unknown)";
      subject = `[EngKor] New payment: ${amount} from ${name}`;
      html = emailHtml(
        "A new PayPal payment was just recorded.",
        row("Name", name) +
          row("Email", record.email || "(email unknown)") +
          row("Amount", amount) +
          row("PayPal order", record.paypal_order_id || "(unknown)") +
          row("PayPal capture", record.paypal_capture_id || "(unknown)") +
          row("Paid at", kst(record.paid_at))
      );
    } else {
      return json({ ok: true, skipped: true });
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });
    await transporter.sendMail({ from: `"EngKor" <${SMTP_USERNAME}>`, to: SMTP_USERNAME, subject, html });

    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
