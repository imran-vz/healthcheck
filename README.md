# Healthcheck

Emails you when something stops pinging it. It runs on Cloudflare Workers, away from the machine it watches, so it still alerts when that machine is off.

Each check has a ping URL, an interval and a grace time. If no ping arrives within interval + grace, you get one `DOWN` email, then one `UP` email at the next ping. A check starts monitoring after its first ping.

## Setup

You need [Vite+](https://viteplus.dev) (`vp`) and the Cloudflare account that holds `imran.codes`.

1. In the Cloudflare dashboard, enable Email Routing for the **subdomain** `hc.imran.codes`, then add and verify the address that should receive alerts. Sending to a verified address is free on all plans. Do not enable it on `imran.codes` itself: that domain's mail goes through Zoho, and Email Routing changes MX records.
2. Create the database, and copy the printed ID into `database_id` in `wrangler.jsonc`:
   ```sh
   vp install
   vp exec wrangler login
   vp exec wrangler d1 create healthcheck
   ```
3. Deploy, then set the password for the page (any username works):
   ```sh
   vp run db:migrate
   vp run deploy
   vp exec wrangler secret put ADMIN_PASSWORD
   ```
4. Open https://hc.imran.codes, save your email, and click **Send test email**.

Each client IP is limited to 60 requests a minute, counting pings and page requests together. Raise the limit in `wrangler.jsonc` if the Mac Mini has more than about 50 checks.

## Pinging from the Mac Mini

Create one check per thing you want to watch. Add these with `crontab -e`, using the URLs from the page:

```cron
# The machine itself is up
* * * * * curl -fsS -m 10 --retry 3 https://hc.imran.codes/ping/MAC_MINI_ID >/dev/null

# A service answers its own health endpoint: the ping only fires if it succeeds
* * * * * curl -fsS -m 5 http://localhost:3000/health >/dev/null && curl -fsS -m 10 --retry 3 https://hc.imran.codes/ping/SERVICE_ID >/dev/null
```

The Mac Mini must not sleep, or it will be reported as down: `sudo pmset -a sleep 0`.

## Development

```sh
vp test
vp check
vp run typecheck
vp run db:migrate:local
echo 'ADMIN_PASSWORD=dev' > .dev.vars
vp run dev
curl http://localhost:8787/cdn-cgi/local/scheduled   # cron does not fire by itself locally
```
