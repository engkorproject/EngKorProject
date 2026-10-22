// Sends a "new feedback" email to a member via Gmail SMTP, using an app
// password stored as secrets (SMTP_USERNAME / SMTP_PASSWORD). Never expose
// those to the browser, this function is the only thing that reads them.
//
// Only a signed-in mentor can trigger it, and only for a real member: the
// recipient's address and name are looked up here from the member id, never
// taken from the request, so this can't be used to email arbitrary people.
// (Older pages also send "to"/"memberName"; those are ignored.)

import nodemailer from "npm:nodemailer@^7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = "https://engkorkorean.com/";
const MAX_FEEDBACK_CHARS = 4000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!SMTP_USERNAME || !SMTP_PASSWORD) {
    return json({ error: "SMTP_USERNAME/SMTP_PASSWORD secrets are not set on this function" }, 500);
  }

  try {
    // Who is asking: must be a signed-in mentor (role 'leader' in the database).
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(token);
    if (!userData?.user) return json({ error: "NOT_SIGNED_IN" }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: sender } = await admin.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    if (sender?.role !== "leader") return json({ error: "MENTORS_ONLY" }, 403);

    const { memberId, feedbackText } = await req.json();
    const text = String(feedbackText || "").trim();
    if (!memberId || !text) return json({ error: "memberId and feedbackText are required" }, 400);
    if (text.length > MAX_FEEDBACK_CHARS) return json({ error: "FEEDBACK_TOO_LONG" }, 400);

    // Who receives it: looked up here, only an existing member who isn't leaving.
    const { data: member } = await admin
      .from("profiles")
      .select("email,name,nickname,role,deletion_requested_at")
      .eq("id", memberId)
      .maybeSingle();
    if (!member || member.role !== "member" || member.deletion_requested_at || !member.email) {
      return json({ error: "MEMBER_NOT_FOUND" }, 404);
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"EngKor" <${SMTP_USERNAME}>`,
      to: member.email,
      subject: "New feedback from your EngKor mentor",
      text:
        `Hi ${member.nickname || member.name || "there"},\n\n` +
        `Your mentor just left new feedback on your challenge:\n\n` +
        `"${text}"\n\n` +
        `Log in to see it: ${SITE_URL}`,
    });

    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
