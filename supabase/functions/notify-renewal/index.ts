// Emails "continue into next month?" to active members whose cohort ends in
// 7 days and who haven't applied for next month yet. Uses the same Gmail SMTP
// secrets as notify-feedback (SMTP_USERNAME / SMTP_PASSWORD).
//
// Triggered once a day by the pg_cron job "notify-renewal-daily" (00:00 UTC,
// 09:00 KST), which POSTs here via net.http_post. The function reads DB state
// itself, so it works with an empty body.
//
// Members who requested account deletion (profiles.deletion_requested_at set)
// are skipped: they are in their 7-day grace period and shouldn't be asked to
// renew.

import nodemailer from "npm:nodemailer@^7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SITE_URL = "https://engkorkorean.com/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!SMTP_USERNAME || !SMTP_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing SMTP or Supabase service role secrets on this function" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Service role: the cron caller has no auth.uid(), and we need to read
    // every member's applications/profiles past RLS.
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const today = new Date();
    const in7Days = new Date(today);
    in7Days.setDate(in7Days.getDate() + 7);
    const in7DaysStr = in7Days.toISOString().slice(0, 10);

    // Cohorts whose end_date is exactly 7 days out. The job runs daily, so each
    // cohort hits this window once and members get a single email.
    const { data: endingCohorts, error: cohortErr } = await sb
      .from("cohorts")
      .select("id,label,end_date")
      .eq("end_date", in7DaysStr);

    if (cohortErr) throw cohortErr;
    if (!endingCohorts || endingCohorts.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, reason: "no cohort ending in 7 days" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    let sentCount = 0;

    for (const cohort of endingCohorts) {
      // Next month's label, e.g. "2026-09" -> "2026-10" (m is 1-indexed, so
      // passing it as a 0-indexed month lands on the following month).
      const [y, m] = cohort.label.split("-").map(Number);
      const nextMonthDate = new Date(Date.UTC(y, m, 1));
      const nextLabel = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
      const nextMonthName = nextMonthDate.toLocaleString("en-US", { month: "long", timeZone: "UTC" });

      const { data: nextCohort } = await sb.from("cohorts").select("id").eq("label", nextLabel).maybeSingle();

      const { data: activeApps, error: appErr } = await sb
        .from("applications")
        .select("member_id")
        .eq("cohort_id", cohort.id)
        .eq("status", "active");
      if (appErr) throw appErr;
      if (!activeApps || activeApps.length === 0) continue;

      // Skip anyone who already applied for next month.
      let alreadyRenewedIds = new Set();
      if (nextCohort) {
        const { data: nextApps } = await sb
          .from("applications")
          .select("member_id")
          .eq("cohort_id", nextCohort.id)
          .eq("status", "active");
        alreadyRenewedIds = new Set((nextApps || []).map((a) => a.member_id));
      }

      const pendingMemberIds = activeApps.map((a) => a.member_id).filter((id) => !alreadyRenewedIds.has(id));
      if (pendingMemberIds.length === 0) continue;

      const { data: members, error: memberErr } = await sb
        .from("profiles")
        .select("email,name")
        .in("id", pendingMemberIds)
        .is("deletion_requested_at", null);
      if (memberErr) throw memberErr;

      for (const member of members || []) {
        if (!member.email) continue;
        await transporter.sendMail({
          from: `"EngKor" <${SMTP_USERNAME}>`,
          to: member.email,
          subject: `Your EngKor challenge ends soon. Continue into ${nextMonthName}?`,
          text:
            `Hi ${member.name || "there"},\n\n` +
            `Your ${cohort.label} EngKor challenge wraps up in 7 days.\n\n` +
            `Want to keep your streak going into ${nextMonthName}? Log in and hit ` +
            `"Continue Next Month" on your dashboard to lock in your spot.\n\n` +
            `${SITE_URL}`,
        });
        sentCount++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent: sentCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
