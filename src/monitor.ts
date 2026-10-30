import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  EMAIL: {
    send(message: {
      to: string;
      from: string;
      subject: string;
      html: string;
      text: string;
    }): Promise<{ messageId: string }>;
  };
  RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  EMAIL_FROM: string;
  ADMIN_PASSWORD?: string;
}

export interface Check {
  id: string;
  name: string;
  period_sec: number;
  grace_sec: number;
  created_at: number;
  last_ping_at: number | null;
  alerted_at: number | null;
}

export interface Settings {
  recipient: string | null;
  last_error: string | null;
}

export type Status = "waiting" | "up" | "late" | "down";

export function statusOf(check: Check, now: number): Status {
  if (check.last_ping_at === null) return "waiting";
  const due = check.last_ping_at + check.period_sec * 1000;
  if (now <= due) return "up";
  return now <= due + check.grace_sec * 1000 ? "late" : "down";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function getSettings(env: Env): Promise<Settings> {
  const row = await env.DB.prepare(
    "SELECT recipient, last_error FROM settings WHERE id = 1",
  ).first<Settings>();
  return row ?? { recipient: null, last_error: null };
}

/** Sends to the configured recipient. Failures are recorded for the page, never thrown. */
export async function sendMail(env: Env, subject: string, body: string): Promise<boolean> {
  let error: string | null = null;
  try {
    const { recipient } = await getSettings(env);
    if (!recipient) throw new Error("No recipient email is configured");
    await env.EMAIL.send({
      to: recipient,
      from: env.EMAIL_FROM,
      subject,
      text: body,
      html: `<p>${escapeHtml(body)}</p>`,
    });
  } catch (e) {
    const { code, message } = e as { code?: string; message?: string };
    error = [code, message].filter(Boolean).join(": ") || "Unknown error";
    console.error("email failed:", error);
  }
  await env.DB.prepare("UPDATE settings SET last_error = ? WHERE id = 1").bind(error).run();
  return error === null;
}

/**
 * Emails once for each check whose period and grace have both run out. The check
 * is marked only after the send succeeds, so a failure retries on the next run:
 * a duplicate email is better than a missed one.
 */
export async function alertOverdue(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM checks
     WHERE alerted_at IS NULL AND last_ping_at IS NOT NULL
       AND last_ping_at + (period_sec + grace_sec) * 1000 < ?`,
  )
    .bind(now)
    .all<Check>();

  for (const check of results) {
    const lastPing = new Date(check.last_ping_at!).toISOString();
    const sent = await sendMail(
      env,
      `DOWN: ${check.name}`,
      `${check.name} has not pinged since ${lastPing}, and its grace time has run out.`,
    );
    if (!sent) continue;
    // A ping may have landed during the send; leave that check unmarked.
    await env.DB.prepare("UPDATE checks SET alerted_at = ? WHERE id = ? AND last_ping_at = ?")
      .bind(now, check.id, check.last_ping_at)
      .run();
  }
}

/** Records a ping. `found` is false for an unknown ID; `recovered` names a check that had gone down. */
export async function recordPing(
  env: Env,
  id: string,
  now: number,
): Promise<{ found: boolean; recovered: string | null }> {
  const [cleared, pinged] = await env.DB.batch<{ name: string }>([
    env.DB.prepare(
      "UPDATE checks SET alerted_at = NULL WHERE id = ? AND alerted_at IS NOT NULL RETURNING name",
    ).bind(id),
    env.DB.prepare("UPDATE checks SET last_ping_at = ? WHERE id = ?").bind(now, id),
  ]);
  return {
    found: (pinged?.meta.changes ?? 0) > 0,
    recovered: cleared?.results[0]?.name ?? null,
  };
}
