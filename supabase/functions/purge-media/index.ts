// Daily permanent deletion, now including files in R2. Runs once a day from the
// pg_cron job "purge-deleted-accounts" (03:00 UTC), in this order:
//   1. find accounts whose 7-day deletion grace period has ended,
//   2. delete every R2 file under "<member id>/" for those accounts,
//   3. run public.purge_deleted_accounts(), which deletes the accounts
//      themselves (and, as before, old checkouts and expired payment records).
// If step 2 fails, step 3 doesn't run, so no account is deleted while its
// photos or recordings are still in R2; tomorrow's run tries again.
//
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.

import { AwsClient } from "npm:aws4fetch@1.0.20";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = Deno.env.get("R2_BUCKET");
const GRACE_DAYS = 7; // keep in sync with purge_deleted_accounts()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async () => {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return json({ error: "R2 secrets are not set on this function" }, 500);
  }
  const r2 = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const bucketUrl = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}`;
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const cutoff = new Date(Date.now() - GRACE_DAYS * 86400000).toISOString();
    const { data: due, error: dueErr } = await sb
      .from("profiles")
      .select("id")
      .not("deletion_requested_at", "is", null)
      .lt("deletion_requested_at", cutoff)
      .neq("role", "leader");
    if (dueErr) throw dueErr;

    let filesDeleted = 0;
    for (const { id } of due || []) {
      // List everything under "<id>/" (1,000 keys per page) and delete it.
      let token: string | null = null;
      do {
        const listUrl = new URL(bucketUrl);
        listUrl.searchParams.set("list-type", "2");
        listUrl.searchParams.set("prefix", `${id}/`);
        if (token) listUrl.searchParams.set("continuation-token", token);
        const listRes = await r2.fetch(listUrl);
        if (!listRes.ok) throw new Error(`R2 list failed with ${listRes.status}`);
        const xml = await listRes.text();
        const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
        for (const key of keys) {
          const del = await r2.fetch(`${bucketUrl}/${key}`, { method: "DELETE" });
          if (!del.ok && del.status !== 404) throw new Error(`R2 delete failed with ${del.status}`);
          filesDeleted++;
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null)
          : null;
      } while (token);
    }

    const { data: accountsDeleted, error: purgeErr } = await sb.rpc("purge_deleted_accounts");
    if (purgeErr) throw purgeErr;

    return json({ ok: true, accountsDue: (due || []).length, filesDeleted, accountsDeleted });
  } catch (err) {
    console.error("purge-media failed:", String(err));
    return json({ error: String(err) }, 500);
  }
});
