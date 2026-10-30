CREATE TABLE checks (
  id           TEXT PRIMARY KEY, -- random UUID, also the secret in the ping URL
  name         TEXT NOT NULL,
  period_sec   INTEGER NOT NULL,
  grace_sec    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_ping_at INTEGER,          -- epoch ms; NULL until the first ping
  alerted_at   INTEGER           -- epoch ms; set while a "down" email is outstanding
);

CREATE TABLE settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  recipient  TEXT,
  last_error TEXT                -- most recent email failure, shown on the page
);

INSERT INTO settings (id) VALUES (1);
