// Sends a "new feedback" email to a member via Gmail SMTP, using an app
// password stored as secrets (SMTP_USERNAME / SMTP_PASSWORD). Never expose
// those to the browser, this function is the only thing that reads them.

import nodemailer from "npm:nodemailer@^7";

const SMTP_USERNAME = Deno.env.get("SMTP_USERNAME");
const SMTP_PASSWORD = Deno.env.get("SMTP_PASSWORD");
const SITE_URL = "https://engkorproject.github.io/EngKorProject/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!SMTP_USERNAME || !SMTP_PASSWORD) {
    return new Response(
      JSON.stringify({ error: "SMTP_USERNAME/SMTP_PASSWORD secrets are not set on this function" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { to, memberName, feedbackText } = await req.json();
    if (!to) {
      return new Response(JSON.stringify({ error: "Missing 'to'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"EngKor" <${SMTP_USERNAME}>`,
      to,
      subject: "New feedback from your EngKor leader",
      text:
        `Hi ${memberName || "there"},\n\n` +
        `Your leader just left new feedback on your challenge:\n\n` +
        `"${feedbackText}"\n\n` +
        `Log in to see it: ${SITE_URL}`,
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
