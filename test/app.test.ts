import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import worker from "../src/index";
import type { Env } from "../src/monitor";

const MINUTE = 60_000;
const AUTH = { authorization: `Basic ${btoa("admin:secret")}` };
const realNow = Date.now;

interface Sent {
  to: string;
  subject: string;
}

let db: DatabaseSync;
let sent: Sent[];
let sendError: (Error & { code?: string }) | null;
let env: Env;
let pending: Promise<unknown>[];
let clock: number;
let limiter: (key: string) => Promise<{ success: boolean }>;

/** Just enough of D1's API, backed by real SQLite so the SQL itself is exercised. */
function fakeD1(database: DatabaseSync) {
  const query = (sql: string) => database.prepare(sql) as any;
  const execute = (sql: string, params: unknown[]) => {
    const results = query(sql).all(...params);
    const { changes } = query("SELECT changes() AS changes").get();
    return { results, meta: { changes } };
  };
  const prepare = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => prepare(sql, next),
    first: () => Promise.resolve(query(sql).get(...params) ?? null),
    all: () => Promise.resolve(execute(sql, params)),
    run: () => Promise.resolve(execute(sql, params)),
    execute: () => execute(sql, params),
  });
  return {
    prepare: (sql: string) => prepare(sql),
    batch: (statements: { execute(): unknown }[]) => {
      database.exec("BEGIN");
      const results = statements.map((s) => s.execute());
      database.exec("COMMIT");
      return Promise.resolve(results);
    },
  };
}

const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await worker.fetch(
    new Request(`https://hc.test${path}`, init),
    env,
    ctx as never,
  );
  await Promise.all(pending);
  return response;
}

function post(
  path: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = AUTH,
) {
  return call(path, { method: "POST", headers, body: new URLSearchParams(fields) });
}

const page = async () => await (await call("/", { headers: AUTH })).text();
const cron = () => worker.scheduled({} as never, env);
const advance = (minutes: number) => (clock += minutes * MINUTE);
const row = (sql: string) => db.prepare(sql).get() as any;

async function addCheck(period = "5", grace = "2"): Promise<string> {
  await post("/checks", { name: "mac-mini", period, grace });
  return row("SELECT id FROM checks").id;
}

function t(name: string, fn: () => Promise<void>) {
  test(name, async () => {
    clock = Date.UTC(2026, 0, 1);
    Date.now = () => clock;
    db = new DatabaseSync(":memory:");
    db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
    db.exec("UPDATE settings SET recipient = 'me@example.com'");
    sent = [];
    sendError = null;
    pending = [];
    limiter = () => Promise.resolve({ success: true });
    env = {
      DB: fakeD1(db) as never,
      RATE_LIMITER: { limit: ({ key }) => limiter(key) },
      EMAIL_FROM: "hc@example.com",
      ADMIN_PASSWORD: "secret",
      EMAIL: {
        send: (message) => {
          if (sendError) return Promise.reject(sendError);
          sent.push(message);
          return Promise.resolve({ messageId: "1" });
        },
      },
    };
    try {
      await fn();
    } finally {
      Date.now = realNow;
      db.close();
    }
  });
}

t("emails once only after both period and grace have passed", async () => {
  const id = await addCheck();
  assert.equal((await call(`/ping/${id}`)).status, 200);

  advance(7); // exactly at the deadline: still in grace
  await cron();
  assert.equal(sent.length, 0);

  advance(1);
  await cron();
  await cron();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.subject, "DOWN: mac-mini");
  assert.equal(sent[0]!.to, "me@example.com");
});

t("regular pings never alert", async () => {
  const id = await addCheck();
  for (let i = 0; i < 5; i++) {
    await call(`/ping/${id}`);
    advance(6);
    await cron();
  }
  assert.equal(sent.length, 0);
});

t("a check that has never pinged does not alert", async () => {
  await addCheck();
  advance(10_000);
  await cron();
  assert.equal(sent.length, 0);
});

t("a ping after an alert sends one recovery email and rearms the check", async () => {
  const id = await addCheck();
  await call(`/ping/${id}`);
  advance(8);
  await cron();

  await call(`/ping/${id}`);
  await call(`/ping/${id}`);
  assert.deepEqual(
    sent.map((m) => m.subject),
    ["DOWN: mac-mini", "UP: mac-mini"],
  );

  advance(8);
  await cron();
  assert.equal(sent.length, 3);
});

t("a failed send is retried on the next run and shown on the page", async () => {
  const id = await addCheck();
  await call(`/ping/${id}`);
  advance(8);

  sendError = Object.assign(new Error("not verified"), { code: "E_RECIPIENT_NOT_ALLOWED" });
  await cron();
  assert.equal(sent.length, 0);
  assert.ok((await page()).includes("E_RECIPIENT_NOT_ALLOWED: not verified"));

  sendError = null;
  await cron();
  assert.equal(sent.length, 1);
  assert.ok(!(await page()).includes("Last email failed"));
});

t("with no recipient the alert stays pending and the page says why", async () => {
  db.exec("UPDATE settings SET recipient = NULL");
  const id = await addCheck();
  await call(`/ping/${id}`);
  advance(8);
  await cron();
  assert.ok((await page()).includes("No recipient email is configured"));

  await post("/settings", { recipient: "new@example.com" });
  await cron();
  assert.equal(sent[0]!.to, "new@example.com");
});

t("pings accept any method and reject unknown IDs, without auth", async () => {
  const id = await addCheck();
  for (const method of ["GET", "POST", "HEAD"]) {
    assert.equal((await call(`/ping/${id}`, { method })).status, 200);
  }
  assert.equal((await call("/ping/nope")).status, 404);
});

t("the page requires the password and stays locked if none is set", async () => {
  assert.equal((await call("/")).status, 401);
  assert.equal(
    (await call("/", { headers: { authorization: `Basic ${btoa("a:wrong")}` } })).status,
    401,
  );
  assert.equal((await call("/", { headers: { authorization: "Basic !!!" } })).status, 401);
  assert.equal((await call("/", { headers: AUTH })).status, 200);

  env.ADMIN_PASSWORD = undefined;
  assert.equal((await call("/", { headers: AUTH })).status, 401);
});

t("cross-site form posts are refused", async () => {
  const fields = { recipient: "evil@example.com" };
  assert.equal(
    (await post("/settings", fields, { ...AUTH, "sec-fetch-site": "cross-site" })).status,
    403,
  );
  assert.equal(
    (await post("/settings", fields, { ...AUTH, origin: "https://evil.test" })).status,
    403,
  );
  assert.equal(row("SELECT recipient FROM settings").recipient, "me@example.com");
});

t("requests over the limit get 429 and do nothing, keyed by client IP", async () => {
  const id = await addCheck();
  const keys: string[] = [];
  limiter = (key) => {
    keys.push(key);
    return Promise.resolve({ success: false });
  };
  const limited = await call(`/ping/${id}`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(limited.status, 429);
  assert.deepEqual(keys, ["203.0.113.9"]);
  assert.equal(row("SELECT last_ping_at FROM checks").last_ping_at, null);
  assert.equal((await post("/settings", { recipient: "x@example.com" })).status, 429);
});

t("a limiter outage does not drop pings", async () => {
  const id = await addCheck();
  limiter = () => Promise.reject(new Error("outage"));
  assert.equal((await call(`/ping/${id}`)).status, 200);
});

t("bad input is rejected", async () => {
  assert.equal((await post("/settings", { recipient: "not-an-email" })).status, 400);
  for (const fields of [
    { name: "", period: "5", grace: "5" },
    { name: "x", period: "0", grace: "5" },
    { name: "x", period: "1.5", grace: "5" },
    { name: "x", period: "5", grace: "999999" },
  ]) {
    assert.equal((await post("/checks", fields)).status, 400);
  }
});

t("names are escaped on the page and checks can be edited and deleted", async () => {
  const id = await addCheck();
  await post(`/checks/${id}`, { name: "<script>x</script>", period: "10", grace: "3" });
  const html = await page();
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes("&lt;script&gt;x"));
  const { period_sec, grace_sec } = row("SELECT period_sec, grace_sec FROM checks");
  assert.deepEqual([period_sec, grace_sec], [600, 180]);

  await post(`/checks/${id}/delete`);
  assert.equal((await call(`/ping/${id}`)).status, 404);
});
