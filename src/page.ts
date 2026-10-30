import { escapeHtml as e, statusOf, type Check, type Settings, type Status } from "./monitor";

const STATUS_LABEL: Record<Status, string> = {
  waiting: "Waiting for first ping",
  up: "Up",
  late: "Late (in grace)",
  down: "Down",
};

function ago(at: number | null, now: number): string {
  if (at === null) return "Never";
  const minutes = Math.floor((now - at) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

function row(check: Check, origin: string, now: number): string {
  const status = statusOf(check, now);
  const id = e(check.id);
  const form = `update-${id}`;
  return `<tr>
    <td class="${status}">${STATUS_LABEL[status]}</td>
    <td><input form="${form}" name="name" value="${e(check.name)}" maxlength="100" required aria-label="Name"></td>
    <td><input form="${form}" name="period" type="number" min="1" max="525600" value="${check.period_sec / 60}" required aria-label="Interval in minutes"></td>
    <td><input form="${form}" name="grace" type="number" min="1" max="525600" value="${check.grace_sec / 60}" required aria-label="Grace in minutes"></td>
    <td>${ago(check.last_ping_at, now)}</td>
    <td><code>${e(origin)}/ping/${id}</code></td>
    <td class="actions">
      <form id="${form}" method="post" action="/checks/${id}"><button>Save</button></form>
      <form method="post" action="/checks/${id}/delete"><button>Delete</button></form>
    </td>
  </tr>`;
}

export function renderPage(
  checks: Check[],
  settings: Settings,
  from: string,
  origin: string,
  now: number,
  testSent: boolean,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Healthcheck</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h2 { margin-top: 2rem; font-size: 1.1rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #ddd; }
  input { font: inherit; padding: .2rem .3rem; box-sizing: border-box; }
  input[type=number] { width: 6rem; }
  code { font-size: 12px; overflow-wrap: anywhere; }
  form { display: inline; }
  .actions { white-space: nowrap; }
  .up { color: #17803d; } .late { color: #a15c00; } .down { color: #c62828; font-weight: 600; } .waiting { color: #666; }
  .error { background: #fdecea; border: 1px solid #c62828; padding: .5rem .75rem; }
  .notice { background: #e8f5e9; border: 1px solid #17803d; padding: .5rem .75rem; }
  .hint { color: #666; font-size: 13px; }
</style>
</head>
<body>
<h1>Healthcheck</h1>
${settings.last_error ? `<p class="error"><strong>Last email failed:</strong> ${e(settings.last_error)}</p>` : ""}
${testSent ? `<p class="notice">Test email sent. Check your inbox.</p>` : ""}

<h2>Send alerts to</h2>
<form method="post" action="/settings">
  <input name="recipient" type="email" value="${e(settings.recipient ?? "")}" required placeholder="you@example.com" aria-label="Recipient email">
  <button>Save</button>
</form>
<form method="post" action="/test-email"><button>Send test email</button></form>
<p class="hint">Sent from ${e(from)}. The address must be a verified destination in your Cloudflare account.</p>

<h2>Checks</h2>
${
  checks.length === 0
    ? "<p>No checks yet.</p>"
    : `<table>
  <thead><tr><th>Status</th><th>Name</th><th>Interval (min)</th><th>Grace (min)</th><th>Last ping</th><th>Ping URL</th><th></th></tr></thead>
  <tbody>${checks.map((check) => row(check, origin, now)).join("")}</tbody>
</table>`
}

<h2>Add a check</h2>
<form method="post" action="/checks">
  <input name="name" required maxlength="100" placeholder="Name" aria-label="Name">
  <input name="period" type="number" min="1" max="525600" value="5" required aria-label="Interval in minutes"> min interval
  <input name="grace" type="number" min="1" max="525600" value="5" required aria-label="Grace in minutes"> min grace
  <button>Add</button>
</form>
</body>
</html>`;
}
