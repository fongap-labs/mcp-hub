-- Prevent reuse of a TOTP code across admin login and OAuth approval.
CREATE TABLE IF NOT EXISTS admin_totp_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_step INTEGER NOT NULL DEFAULT -1
);
INSERT OR IGNORE INTO admin_totp_state (id,last_step) VALUES (1,-1);
