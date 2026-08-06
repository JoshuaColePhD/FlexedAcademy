# flexed-keepwarm

A 20-line Cloudflare Worker that pings the Render app so a teacher never lands
on a sleeping instance.

## Why

Render's free web services sleep after 15 minutes idle and take ~50s to wake.
Added to a ~10s generation, a colleague's first impression is a minute of
nothing. This keeps the app up during the evenings when planning happens.

Not a 24/7 ping: Render's free tier grants ~750 instance-hours a month, and
holding one service up around the clock would spend ~730 of them. The schedule
here costs ~130.

## Deploy

Both free — Workers free allows 100,000 requests/day; this uses ~180/month.

```bash
cd keepwarm
npx wrangler deploy
```

Set `APP_URL` in `wrangler.jsonc` to the real Render URL first.

## Check it works

`npx wrangler tail flexed-keepwarm` and wait for a tick, or just open the
Worker's own URL — a plain `fetch` to it pings the app and reports the status.
