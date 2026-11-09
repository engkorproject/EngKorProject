// Maintenance mode for engkorkorean.com (Cloudflare Pages Function).
//
// While this file is deployed, every visitor sees the maintenance page below
// (HTTP 503 + Retry-After, so Google treats it as temporary and keeps the
// site's ranking). Staff get through with a private link:
//
//     https://engkorkorean.com/?staff=<STAFF_TOKEN>
//
// The link sets a 14-day cookie in that browser and redirects to the clean URL.
// STAFF_TOKEN is a Cloudflare Pages secret (Settings > Variables and Secrets),
// never written in this repo. Change the secret to lock out every old cookie.
//
// Reopen the site: delete the functions/ folder (or `git revert` the commit
// that added it) and deploy again.

const MAINTENANCE_ON = true; // set false to let everyone in without deleting the file

// Reachable even in maintenance: the page's own images, crawler files, the
// Google verification file and the legal pages (PayPal and Google need them).
const PASS_THROUGH = /^\/(images\/|favicon\.ico$|robots\.txt$|sitemap\.xml$|manifest\.webmanifest$|googlefc[0-9a-f]+\.html$|(privacy|terms|refund)(\.ko)?(\.html)?$)/;

const COOKIE = 'eks';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Both inputs are fixed-length hex hashes, so a plain XOR loop is enough.
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  if (!MAINTENANCE_ON) return next();

  const url = new URL(request.url);
  if (PASS_THROUGH.test(url.pathname)) return next();

  // Without STAFF_TOKEN nobody can bypass, so a forgotten secret locks staff
  // out rather than letting a guessable default in.
  if (env.STAFF_TOKEN) {
    const expected = await sha256Hex(env.STAFF_TOKEN);

    const given = url.searchParams.get('staff');
    if (given !== null) {
      if (sameHash(await sha256Hex(given), expected)) {
        url.searchParams.delete('staff');
        return new Response(null, {
          status: 302,
          headers: {
            Location: url.pathname + url.search,
            'Set-Cookie': `${COOKIE}=${expected}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
            'Cache-Control': 'no-store',
          },
        });
      }
    } else if (sameHash(readCookie(request, COOKIE), expected)) {
      return next();
    }
  }

  return new Response(request.method === 'HEAD' ? null : MAINTENANCE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '3600',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EngKor is being updated</title>
<link rel="icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/images/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/wanteddev/wanted-sans@v1.0.1/packages/wanted-sans/fonts/webfonts/variable/split/WantedSansVariable.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/sn-pro@5.3.0/700.css">
<style>
  :root {
    --primary: #F2924E; --btn-primary: #C96A2B; --btn-primary-hover: #B15F26;
    --surface: #FFFCF9; --surface-alt: #FDF0E2; --foreground: #2E2E2E;
    --muted: #8A8478; --hairline: #EAE3D8;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 32px 16px; background: #fff; color: var(--foreground); line-height: 1.5;
    font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main { width: 100%; max-width: 520px; text-align: center; }
  .logo {
    display: inline-flex; align-items: center; gap: 8px; margin-bottom: 20px;
    font: 800 20px "Wanted Sans", -apple-system, sans-serif; color: var(--btn-primary);
  }
  .logo img { width: 28px; height: 28px; object-fit: contain; }
  .mascot { display: block; width: 200px; height: 200px; margin: 0 auto 8px; object-fit: contain; }
  h1 { font: 700 32px/1.2 "SN Pro", -apple-system, sans-serif; margin-bottom: 12px; }
  .lead { font-size: 17px; color: var(--muted); margin-bottom: 32px; }
  .card {
    background: var(--surface); border: 1px solid var(--hairline); border-radius: 20px;
    padding: 24px 22px; box-shadow: 0 2px 12px rgba(46,46,46,0.06);
  }
  .card h2 { font: 700 20px "SN Pro", -apple-system, sans-serif; margin-bottom: 8px; }
  .card p { font-size: 15px; color: var(--muted); margin-bottom: 18px; }
  .btn {
    display: inline-block; padding: 12px 24px; border-radius: 9999px; background: var(--btn-primary);
    color: #fff; font-weight: 600; font-size: 15px; text-decoration: none; transition: background 150ms;
  }
  .btn:hover { background: var(--btn-primary-hover); }
  .btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
  .peek { display: block; margin-bottom: 18px; border-radius: 14px; overflow: hidden; border: 1px solid var(--hairline);
    aspect-ratio: 16 / 8.5; box-shadow: 0 2px 12px rgba(46,46,46,0.08); transition: transform 200ms; }
  .peek:hover { transform: translateY(-2px); }
  .peek:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
  .peek img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: left top; }
  .social { margin-top: 24px; font-size: 14px; color: var(--muted); }
  .social a { color: var(--btn-primary); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
  .social a:hover { color: var(--btn-primary-hover); }
  @media (max-width: 480px) { h1 { font-size: 26px; } .mascot { width: 160px; height: 160px; }
    .peek { aspect-ratio: 1 / 1; } .peek img { object-position: 64% top; } }
</style>
</head>
<body>
<main>
  <div class="logo"><img src="/images/mascot.png" alt="" width="28" height="28">EngKor</div>
  <img class="mascot" src="/images/mascot-full.png" alt="" width="200" height="200">
  <h1>We&rsquo;re updating EngKor</h1>
  <p class="lead">The site is closed for a big update.<br>We&rsquo;ll be back soon with something better.</p>
  <section class="card">
    <h2>Keep learning on Discord</h2>
    <p>Our Discord community is open as usual.<br>Get daily Korean expressions, ask questions,<br>and chat with other learners while the site is down.</p>
    <a class="peek" href="https://discord.gg/bj9w884Epk" target="_blank" rel="noopener noreferrer" aria-label="Join the EngKor Discord">
      <img src="/images/discord-preview.webp" width="1600" height="904"
        alt="EngKor Discord server with Q&amp;A, chat, and daily Korean expression channels">
    </a>
    <a class="btn" href="https://discord.gg/bj9w884Epk" target="_blank" rel="noopener noreferrer">Join our Discord &rarr;</a>
  </section>
  <p class="social">We&rsquo;ll announce as soon as the update is done on
    <a href="https://www.instagram.com/engkor.korean" target="_blank" rel="noopener noreferrer">Instagram</a> and
    <a href="https://www.tiktok.com/@engkor.korean" target="_blank" rel="noopener noreferrer">TikTok</a>.</p>
</main>
</body>
</html>
`;
