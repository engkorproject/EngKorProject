// Gives the browser short-lived, signed links to the private R2 bucket where
// check-in photos and recordings live, so files go straight between the
// member's browser and R2 and never pass through (or bloat) the database.
// The database only keeps a path like "r2:<member id>/<date>/<kind>-<id>.<ext>".
//
//   upload  -> a 10-minute PUT link, only for the member's own check-in on a
//              date their 30-day pass allows (same rule as the DB trigger).
//   view    -> 1-hour GET links: members only for their own files, leaders for anyone's.
//   delete  -> removes one of the member's own files (Remove, or a replaced upload).
//
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
// Deploy with "Enforce JWT verification" on: callers send their own login token.

import { AwsClient } from "npm:aws4fetch@1.0.20";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = Deno.env.get("R2_BUCKET");

const UPLOAD_LINK_SECONDS = 600;
const VIEW_LINK_SECONDS = 3600;
const MAX_VIEW_PATHS = 200;
const PATH_PREFIX = "r2:";

// What each check-in part may be, and the file extension it's stored under.
const KINDS: Record<string, { maxBytes: number; types: Record<string, string> }> = {
  diary: { maxBytes: 8 * 1024 * 1024, types: { "image/jpeg": "jpg" } },
  shadowing: {
    maxBytes: 6 * 1024 * 1024,
    types: {
      "audio/webm": "webm", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac",
      "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
      "video/webm": "webm", "video/mp4": "m4a", "": "audio",
    },
  },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const r2 = R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
  ? new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" })
  : null;

function objectUrl(key: string): URL {
  return new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`);
}

async function signedLink(method: "GET" | "PUT", key: string, seconds: number): Promise<string> {
  const url = objectUrl(key);
  url.searchParams.set("X-Amz-Expires", String(seconds));
  const signed = await r2!.sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}

// "r2:<uuid>/<YYYY-MM-DD>/<kind>-<uuid>.<ext>" -> the R2 key, or null if it isn't one of ours.
function keyFromPath(path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith(PATH_PREFIX)) return null;
  const key = path.slice(PATH_PREFIX.length);
  return /^[0-9a-f-]{36}\/\d{4}-\d{2}-\d{2}\/(diary|shadowing)-[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key) ? key : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!r2 || !R2_ACCOUNT_ID || !R2_BUCKET) return json({ error: "R2 secrets are not set on this function" }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY).auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Invalid or expired access token" }, 401);
  const uid = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  try {
    if (body.action === "upload") {
      const kind = KINDS[body.kind];
      if (!kind) return json({ error: "INVALID_KIND" }, 400);
      if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return json({ error: "INVALID_DATE" }, 400);
      const type = String(body.contentType || "").split(";")[0].trim().toLowerCase();
      const ext = kind.types[type];
      if (!ext) return json({ error: "UNSUPPORTED_FILE_TYPE" }, 400);
      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0 || size > kind.maxBytes) return json({ error: "FILE_TOO_LARGE" }, 400);

      // Same rule the database enforces on save: only inside the member's 30-day pass.
      const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data: allowed, error: ruleError } = await asUser.rpc("can_submit_on", { p_date: body.date });
      if (ruleError) throw ruleError;
      if (!allowed) return json({ error: "CHALLENGE_CLOSED" }, 403);

      const key = `${uid}/${body.date}/${body.kind}-${crypto.randomUUID()}.${ext}`;
      return json({ path: PATH_PREFIX + key, uploadUrl: await signedLink("PUT", key, UPLOAD_LINK_SECONDS) });
    }

    if (body.action === "view") {
      const paths: unknown[] = Array.isArray(body.paths) ? body.paths.slice(0, MAX_VIEW_PATHS) : [];
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: me } = await admin.from("profiles").select("role").eq("id", uid).maybeSingle();
      const isLeader = me?.role === "leader";
      const urls: Record<string, string> = {};
      for (const path of paths) {
        const key = keyFromPath(path);
        if (!key) continue;
        if (!isLeader && !key.startsWith(uid + "/")) continue;
        urls[path as string] = await signedLink("GET", key, VIEW_LINK_SECONDS);
      }
      return json({ urls, expiresIn: VIEW_LINK_SECONDS });
    }

    if (body.action === "delete") {
      const key = keyFromPath(body.path);
      if (!key || !key.startsWith(uid + "/")) return json({ error: "NOT_YOUR_FILE" }, 403);
      const res = await r2.fetch(objectUrl(key), { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed with ${res.status}`);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("media function error:", String(err));
    return json({ error: String(err) }, 500);
  }
});
