// Emails "keep going for 30 more days?" to members whose 30-day pass ends
// within the next 7 days and who haven't booked their next 30 days yet. Uses
// the same Gmail SMTP secrets as notify-feedback (SMTP_USERNAME / SMTP_PASSWORD).
//
// Triggered once a day by the pg_cron job "notify-renewal-daily" (00:00 UTC,
// 09:00 KST), which POSTs here via net.http_post. The function reads DB state
// itself, so it works with an empty body.
//
// Each pass gets at most one reminder: applications.renewal_reminded_at is
// claimed before the email goes out, so a missed cron day is caught up the
// next day, and calling this function again (or twice at once) never sends a
// second email for the same pass.
//
// Members who requested account deletion (profiles.deletion_requested_at set)
// are skipped: they are in their 7-day grace period and shouldn't be asked to
// renew. Leaders are skipped too.

import nodemailer from "npm:nodemailer@^7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SITE_URL = "https://engkorkorean.com/";
const REMIND_DAYS_BEFORE_END = 7;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Pass = { id: string; member_id: string; starts_on: string; ends_on: string };

// "2026-10-16" + 7 -> "2026-10-23" (dates are plain calendar days).
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "2026-11-14" -> "Nov 14"
function shortDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Passes ending soon whose member hasn't already booked a pass that starts after it.
function passesToRemind(endingSoon: Pass[], laterPasses: Pass[]): Pass[] {
  return endingSoon.filter(
    (p) => !laterPasses.some((q) => q.member_id === p.member_id && q.id !== p.id && q.starts_on > p.ends_on)
  );
}

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

    const today = new Date().toISOString().slice(0, 10);
    const windowEnd = addDays(today, REMIND_DAYS_BEFORE_END);

    // Passes that end between today and 7 days from now and haven't been reminded yet.
    const { data: endingSoon, error: endingErr } = await sb
      .from("applications")
      .select("id,member_id,starts_on,ends_on")
      .eq("status", "active")
      .is("renewal_reminded_at", null)
      .gte("ends_on", today)
      .lte("ends_on", windowEnd);
    if (endingErr) throw endingErr;
    if (!endingSoon || endingSoon.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, reason: "no pass ending within 7 days" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Anyone who already extended has a pass that starts after the ending one.
    const memberIds = [...new Set(endingSoon.map((p) => p.member_id))];
    const { data: laterPasses, error: laterErr } = await sb
      .from("applications")
      .select("id,member_id,starts_on,ends_on")
      .eq("status", "active")
      .in("member_id", memberIds)
      .gt("starts_on", today);
    if (laterErr) throw laterErr;
    const toRemind = passesToRemind(endingSoon, laterPasses || []);
    if (toRemind.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, reason: "everyone ending soon already extended" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: members, error: memberErr } = await sb
      .from("profiles")
      .select("id,email,name,role")
      .in("id", [...new Set(toRemind.map((p) => p.member_id))])
      .eq("role", "member")
      .is("deletion_requested_at", null);
    if (memberErr) throw memberErr;
    const memberById = new Map((members || []).map((m) => [m.id, m]));

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    let sentCount = 0;
    for (const pass of toRemind) {
      const member = memberById.get(pass.member_id);
      if (!member || !member.email) continue;

      // Claim this pass first; if another run already claimed it, skip.
      const { data: claimed, error: claimErr } = await sb
        .from("applications")
        .update({ renewal_reminded_at: new Date().toISOString() })
        .eq("id", pass.id)
        .is("renewal_reminded_at", null)
        .select("id");
      if (claimErr) throw claimErr;
      if (!claimed || claimed.length === 0) continue;

      const nextStart = addDays(pass.ends_on, 1);
      const nextEnd = addDays(nextStart, 29);
      try {
        await transporter.sendMail({
          from: `"EngKor" <${SMTP_USERNAME}>`,
          to: member.email,
          subject: `Your EngKor challenge ends ${shortDate(pass.ends_on)}. Keep going for 30 more days?`,
          text:
            `Hi ${member.name || "there"},\n\n` +
            `Your 30-day EngKor challenge ends on ${shortDate(pass.ends_on)}.\n\n` +
            `Want to keep your streak going? Log in and tap "Extend 30 Days" on your dashboard. ` +
            `Your next 30 days would run from ${shortDate(nextStart)} to ${shortDate(nextEnd)}.\n\n` +
            `${SITE_URL}`,
        });
        sentCount++;
      } catch (mailErr) {
        // Let tomorrow's run try again for this pass.
        await sb.from("applications").update({ renewal_reminded_at: null }).eq("id", pass.id);
        console.error(`Renewal email failed for application ${pass.id}:`, String(mailErr));
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
