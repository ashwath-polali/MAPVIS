-- Slowing down somebody guessing a password.
--
-- scrypt already costs ~100ms per attempt, which is real friction but is
-- mitigation rather than a lock: a patient attacker still gets ten tries a
-- second across parallel connections.
--
-- Backoff rather than a hard lockout, deliberately. A hard lock lets anybody
-- who knows an email address lock its owner out of their own account by failing
-- on purpose, which turns a defence into an attack. Growing the wait instead
-- makes guessing hopeless while leaving the real owner a way in by waiting.
--
-- In the database and not in memory, because on a serverless host every request
-- may be a different process and an in-memory counter would reset constantly.
alter table users add column failed_logins integer not null default 0;
alter table users add column last_failed_at timestamptz;
