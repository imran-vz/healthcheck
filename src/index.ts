import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { alertOverdue, type Check, type Env, getSettings, recordPing, sendMail } from "./monitor";
import { renderPage } from "./page";

const MAX_MINUTES = 525600; // one year

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

function backToPage(query = ""): Response {
  return new Response(null, { status: 303, headers: { location: `/${query}` } });
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Compares digests so the check takes the same time wherever the passwords differ. */
async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  a.forEach((byte, i) => (diff |= byte ^ b[i]!));
  return diff === 0;
}

/** HTTP Basic auth. Any username works; with no password set, the page stays locked. */
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const [scheme, encoded] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  try {
    const decoded = atob(encoded);
    return await passwordMatches(decoded.slice(decoded.indexOf(":") + 1), env.ADMIN_PASSWORD);
  } catch {
    return false;
  }
}

/** Browsers attach Basic credentials to cross-site POSTs, so reject those. */
function isCrossSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
}

/** Fails open: a limiter outage must not drop pings and cause false "down" emails. */
async function isRateLimited(request: Request, env: Env): Promise<boolean> {
  try {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    return !(await env.RATE_LIMITER.limit({ key })).success;
  } catch (e) {
    console.error("rate limiter failed:", e);
    return false;
  }
}

/** Reads the name, interval and grace fields, or returns a message describing the problem. */
function parseCheck(
  form: FormData,
): { name: string; periodSec: number; graceSec: number } | string {
  const name = String(form.get("name") ?? "").trim();
  const period = Number(form.get("period"));
  const grace = Number(form.get("grace"));
  if (!name || name.length > 100) return "Name must be 1 to 100 characters.";
  for (const minutes of [period, grace]) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
      return `Interval and grace must be whole minutes from 1 to ${MAX_MINUTES}.`;
    }
  }
  return { name, periodSec: period * 60, graceSec: grace * 60 };
}

async function handlePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { results } = await env.DB.prepare(
    "SELECT * FROM checks ORDER BY name COLLATE NOCASE",
  ).all<Check>();
  const html = renderPage(
    results,
    await getSettings(env),
    env.EMAIL_FROM,
    url.origin,
    Date.now(),
    url.searchParams.has("sent"),
  );
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

async function handleAction(request: Request, env: Env, path: string): Promise<Response> {
  if (isCrossSite(request)) return text("Cross-site request refused.", 403);
  const form = await request.formData();

  if (path === "/settings") {
    const recipient = String(form.get("recipient") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
      return text("Enter a valid email address.", 400);
    await env.DB.prepare("UPDATE settings SET recipient = ? WHERE id = 1").bind(recipient).run();
    return backToPage();
  }

  if (path === "/test-email") {
    const sent = await sendMail(
      env,
      "Healthcheck test email",
      "Alerts from your healthcheck service will arrive here.",
    );
    return backToPage(sent ? "?sent" : "");
  }

  if (path === "/checks") {
    const check = parseCheck(form);
    if (typeof check === "string") return text(check, 400);
    await env.DB.prepare(
      "INSERT INTO checks (id, name, period_sec, grace_sec, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), check.name, check.periodSec, check.graceSec, Date.now())
      .run();
    return backToPage();
  }

  const match = path.match(/^\/checks\/([^/]+)(\/delete)?$/);
  if (!match) return text("Not found.", 404);
  const id = match[1]!;

  if (match[2]) {
    await env.DB.prepare("DELETE FROM checks WHERE id = ?").bind(id).run();
    return backToPage();
  }
  const check = parseCheck(form);
  if (typeof check === "string") return text(check, 400);
  await env.DB.prepare("UPDATE checks SET name = ?, period_sec = ?, grace_sec = ? WHERE id = ?")
    .bind(check.name, check.periodSec, check.graceSec, id)
    .run();
  return backToPage();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (await isRateLimited(request, env))
      return text("Too many requests.\n", 429, { "retry-after": "60" });

    const path = new URL(request.url).pathname;

    // Public: the unguessable ID in the URL is the credential.
    const ping = path.match(/^\/ping\/([^/]+)$/);
    if (ping) {
      const { found, recovered } = await recordPing(env, ping[1]!, Date.now());
      if (!found) return text("Unknown check.\n", 404);
      if (recovered) {
        ctx.waitUntil(sendMail(env, `UP: ${recovered}`, `${recovered} is pinging again.`));
      }
      return text("OK\n");
    }

    if (!(await isAuthorized(request, env))) {
      return text("Authentication required.", 401, {
        "www-authenticate": 'Basic realm="Healthcheck"',
      });
    }
    if (request.method === "GET" && path === "/") return handlePage(request, env);
    if (request.method === "POST") return handleAction(request, env, path);
    return text("Not found.", 404);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await alertOverdue(env, Date.now());
  },
};
