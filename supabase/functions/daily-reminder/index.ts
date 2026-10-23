// Emails "today's check-in isn't done yet" at the hour each member picked
// (12 PM, 3 PM, 6 PM or 9 PM in their own time zone). Only members with a
// 30-day pass running today get one, and only for what's still missing:
// nothing if Writing and Speaking are both in, otherwise just the part left.
// Uses the same Gmail SMTP secrets as notify-feedback (SMTP_USERNAME / SMTP_PASSWORD).
//
// Triggered every hour on the hour by the pg_cron job "daily-reminder-hourly",
// which POSTs here via net.http_post. The function reads DB state itself, so
// it works with an empty body.
//
// profiles.daily_reminder_last_sent_on (the member's local date) is claimed
// before the email goes out, so a member gets at most one reminder a day even
// if this function runs twice. Every email links to a one-click "turn off"
// page on the site (profiles.reminder_token), and members can change the time
// or turn reminders off in My Account.

import nodemailer from "npm:nodemailer@^7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SITE_URL = "https://engkorkorean.com/";
const CATCH_UP_HOURS = 2;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Member = {
  id: string;
  email: string | null;
  name: string | null;
  nickname: string | null;
  timezone: string | null;
  daily_reminder_hour: number;
  daily_reminder_last_sent_on: string | null;
  reminder_token: string;
};

// The member's own date ("2026-10-16") and hour (0 to 23) right now. An unknown
// time zone falls back to UTC instead of failing the whole run.
function localNow(timeZone: string | null, now: Date): { date: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return localNow("UTC", now);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

// Which parts of today's check-in are still missing.
function missingParts(sub: { has_diary: boolean; has_shadowing: boolean } | undefined): string[] {
  const left: string[] = [];
  if (!sub || !sub.has_diary) left.push("Writing");
  if (!sub || !sub.has_shadowing) left.push("Speaking");
  return left;
}

function dayOfPass(startsOn: string, today: string): number {
  return Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(startsOn + "T00:00:00Z")) / 86400000) + 1;
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
    // every member's profile, pass and submissions past RLS.
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = new Date();

    const { data: members, error: memberErr } = await sb
      .from("profiles")
      .select("id,email,name,nickname,timezone,daily_reminder_hour,daily_reminder_last_sent_on,reminder_token")
      .eq("role", "member")
      .eq("daily_reminder_enabled", true)
      .is("deletion_requested_at", null);
    if (memberErr) throw memberErr;

    // Members whose chosen hour has come in their own time zone and who haven't
    // been reminded today. The 2-hour catch-up covers a skipped cron run or a
    // failed send, without emailing anyone late at night.
    const due = ((members || []) as Member[])
      .map((m) => ({ m, local: localNow(m.timezone, now) }))
      .filter(({ m, local }) =>
        m.email &&
        local.hour >= m.daily_reminder_hour &&
        local.hour <= m.daily_reminder_hour + CATCH_UP_HOURS &&
        m.daily_reminder_last_sent_on !== local.date
      );
    if (due.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, reason: "no one due this hour" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ids = due.map(({ m }) => m.id);
    const dates = [...new Set(due.map(({ local }) => local.date))];
    const [{ data: passes, error: passErr }, { data: subs, error: subErr }] = await Promise.all([
      sb.from("applications").select("member_id,starts_on,ends_on").eq("status", "active").in("member_id", ids),
      sb.from("submissions").select("member_id,date,has_diary,has_shadowing").in("member_id", ids).in("date", dates),
    ]);
    if (passErr) throw passErr;
    if (subErr) throw subErr;

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    let sentCount = 0;
    for (const { m, local } of due) {
      const pass = (passes || []).find((p) => p.member_id === m.id && p.starts_on <= local.date && local.date <= p.ends_on);
      if (!pass) continue;
      const left = missingParts((subs || []).find((s) => s.member_id === m.id && s.date === local.date));
      if (left.length === 0) continue;

      // Claim today first; if another run already did, skip.
      const { data: claimed, error: claimErr } = await sb
        .from("profiles")
        .update({ daily_reminder_last_sent_on: local.date })
        .eq("id", m.id)
        .or(`daily_reminder_last_sent_on.is.null,daily_reminder_last_sent_on.lt.${local.date}`)
        .select("id");
      if (claimErr) throw claimErr;
      if (!claimed || claimed.length === 0) continue;

      const leftText = left.join(" and ");
      const passLength = Math.round((Date.parse(pass.ends_on + "T00:00:00Z") - Date.parse(pass.starts_on + "T00:00:00Z")) / 86400000) + 1;
      const offLink = `${SITE_URL}#/reminders-off?token=${m.reminder_token}`;
      try {
        await transporter.sendMail({
          from: `"EngKor" <${SMTP_USERNAME}>`,
          to: m.email!,
          subject: `Today's EngKor check-in: ${leftText} left`,
          text:
            `Hi ${m.nickname || m.name || "there"},\n\n` +
            (passLength === 1
              ? `It's your free trial day, `
              : `It's Day ${dayOfPass(pass.starts_on, local.date)} of ${passLength} of your challenge, `) +
            `and today's ${leftText} ${left.length > 1 ? "are" : "is"} still waiting for you.\n\n` +
            `Upload ${left.length > 1 ? "them" : "it"} here before the day ends to keep your streak going:\n${SITE_URL}\n\n` +
            `---\n` +
            `You can change the time or turn these reminders off in My Account.\n` +
            `Turn off reminders now: ${offLink}`,
        });
        sentCount++;
      } catch (mailErr) {
        // Undo the claim so the next hourly run can try again (within the catch-up window).
        await sb.from("profiles").update({ daily_reminder_last_sent_on: m.daily_reminder_last_sent_on }).eq("id", m.id);
        console.error(`Daily reminder failed for member ${m.id}:`, String(mailErr));
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
