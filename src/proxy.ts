import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

// Aviator can run commands on this machine (agents, MCP connection tests, the general chat),
// so only you may use it.
//
// On this machine (http://localhost:3210): no login, but requests that change something must
// come from Aviator's own page. Browsers send simple cross-site POSTs (text/plain, no-cors)
// without asking first, so otherwise any website you have open could call the API.
//
// From anywhere else (a tunnel such as ngrok, a LAN address, DNS rebinding): every request needs
// the secret in AVIATOR_ACCESS_TOKEN. Open the address once as https://<host>/?token=<secret>;
// the browser then keeps an access cookie. With no token set, remote access is off.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const COOKIE = "aviator_access";
const MIN_TOKEN_LENGTH = 8;
/** Shorter tokens work, but are easy to guess; Aviator warns about them. */
const STRONG_TOKEN_LENGTH = 24;

// Wrong tokens: 5 from one address, or 20 from everywhere together, pause sign-ins for 15
// minutes, so a token can't be guessed by trying many. Signed-in devices keep working.
const LOCKOUT_MS = 15 * 60_000;
const MAX_FAILS_PER_ADDRESS = 5;
const MAX_FAILS_TOTAL = 20;
const fails = new Map<string, number[]>();

function recentFails(key: string, now: number): number[] {
  const list = (fails.get(key) ?? []).filter((t) => now - t < LOCKOUT_MS);
  fails.set(key, list);
  return list;
}

function lockedOut(address: string, now: number): boolean {
  return recentFails(address, now).length >= MAX_FAILS_PER_ADDRESS || recentFails("*", now).length >= MAX_FAILS_TOTAL;
}

function recordFail(address: string, now: number) {
  recentFails(address, now).push(now);
  recentFails("*", now).push(now);
}

/** The visitor's address: the first entry of X-Forwarded-For (set by the tunnel). */
function clientAddress(request: NextRequest): string {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

let warnedWeak = false;

function hostName(host: string): string {
  // "[::1]:3210" -> "[::1]", "localhost:3210" -> "localhost"
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

/**
 * Next.js puts the client's address in X-Forwarded-For (::1 for a browser on this machine).
 * A tunnel such as ngrok connects from this machine too, but adds the visitor's real address
 * to that list, even when it rewrites the Host header to localhost. So a request is local only
 * when every address in the list is this machine.
 */
function isLocal(request: NextRequest): boolean {
  const host = request.headers.get("host");
  if (!host || !LOCAL_HOSTS.has(hostName(host.toLowerCase()))) return false;
  if (request.headers.has("forwarded") || request.headers.has("x-real-ip")) return false;
  const chain = (request.headers.get("x-forwarded-for") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  return chain.every((a) => LOOPBACK.has(a));
}

/** The address the visitor used (e.g. the ngrok domain), for redirects. */
function publicUrl(request: NextRequest, pathAndQuery: string): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  return `${proto}://${host}${pathAndQuery}`;
}

const digest = (value: string) => createHash("sha256").update(`aviator-access:${value}`).digest();

function accessToken(): string | undefined {
  const token = process.env.AVIATOR_ACCESS_TOKEN?.trim();
  if (!token || token.length < MIN_TOKEN_LENGTH) return undefined;
  if (token.length < STRONG_TOKEN_LENGTH && !warnedWeak) {
    warnedWeak = true;
    console.warn(
      `[aviator] AVIATOR_ACCESS_TOKEN is only ${token.length} characters. Anyone who guesses it controls this computer; a long random passphrase is much safer.`,
    );
  }
  return token;
}

/** The cookie holds a hash of the token, never the token itself. */
function cookieValue(token: string): string {
  return digest(token).toString("hex");
}

function matches(candidate: string | undefined, expected: Buffer): boolean {
  if (!candidate) return false;
  const got = digest(candidate);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function deny(request: NextRequest, status: 401 | 403 | 429, message: string) {
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: message }, { status });
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviator</title>
<body style="font:15px/1.6 ui-monospace,monospace;background:#141414;color:#e6e6e6;padding:48px 20px;max-width:640px;margin:auto">
<h1 style="font-size:18px;color:#d77757">✻ Aviator</h1><p>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p></body>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  const changes = request.method !== "GET" && request.method !== "HEAD";

  if (!isLocal(request)) {
    const token = accessToken();
    if (!token) {
      return deny(
        request,
        403,
        `Remote access is off. To use Aviator from another device, set AVIATOR_ACCESS_TOKEN (at least ${MIN_TOKEN_LENGTH} characters; a long random passphrase is safest) on the computer running it, restart it, and open this address with ?token=<your token> once.`,
      );
    }
    const expected = digest(token);
    // First visit: ?token=… sets the access cookie, then the token is dropped from the address.
    const given = request.nextUrl.searchParams.get("token") ?? undefined;
    if (given !== undefined && !changes) {
      const now = Date.now();
      const address = clientAddress(request);
      if (lockedOut(address, now)) {
        return deny(request, 429, "Too many wrong tokens. Sign-in is paused for 15 minutes.");
      }
      if (!matches(given, expected)) {
        recordFail(address, now);
        return deny(request, 401, "That token isn't right.");
      }
      const params = new URLSearchParams(request.nextUrl.search);
      params.delete("token");
      const query = params.toString();
      const res = NextResponse.redirect(publicUrl(request, `${request.nextUrl.pathname}${query ? `?${query}` : ""}`));
      res.cookies.set(COOKIE, cookieValue(token), {
        httpOnly: true,
        secure: request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      });
      return res;
    }
    const cookie = request.cookies.get(COOKIE)?.value;
    const cookieOk = !!cookie && cookie.length === 64 && timingSafeEqual(Buffer.from(cookie), Buffer.from(cookieValue(token)));
    if (!cookieOk) return deny(request, 401, "Open this address with ?token=<your AVIATOR_ACCESS_TOKEN> once to sign in on this device.");
  }

  if (changes && request.nextUrl.pathname.startsWith("/api/") && !sameOrigin(request)) {
    return deny(request, 403, "Only Aviator's own page can make changes.");
  }
  return NextResponse.next();
}

// Every path: away from this machine even the page itself needs the token.
export const config = { matcher: "/:path*" };
