-- Scheduled jobs. Run once in the SQL editor of a hosted project (pg_cron and
-- pg_net must be enabled under Database, Extensions). Kept out of migrations
-- because the local test database has neither extension.
--
-- Store the two secrets in Vault first:
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/dispatch-notifications', 'dispatch_url');
--   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'cron_secret');

-- Mark doses missed 60 minutes after their time, every 5 minutes.
select cron.schedule('mark-missed-doses', '*/5 * * * *', $$ select public.mark_missed_doses(); $$);

-- Send pending notifications every minute.
select cron.schedule(
  'dispatch-notifications',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
