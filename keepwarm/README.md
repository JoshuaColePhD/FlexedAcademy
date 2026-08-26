# flexed-keepwarm

A 20-line Cloudflare Worker that pings the Render app so a teacher never lands
on a sleeping instance.

## Why

Render's free web services sleep after 15 minutes idle and take ~50s to wake.
Added to a ~10s generation, a colleague's first impression is a minute of
nothing. This keeps the app up 6am-10pm US Central, every day including evenings and
weekends — take-home lesson planning happens then too, not just the school
day this originally targeted (see wrangler.jsonc's `triggers.crons` and
src/index.js's own comment, which are the source of truth for the actual
schedule).

Not a 24/7 ping: Render's free tier grants ~750 instance-hours a month, and
holding one service up around the clock would spend ~730 of them. The current
schedule (~16 hours × 30 days) costs ~480 — comfortably clear of the limit.

## Deploy

Both free — Workers free allows 100,000 requests/day; this schedule (every 10
minutes, 16 hours/day) fires roughly 2,900 times a month.

```bash
cd keepwarm
npx wrangler deploy
```

`APP_URL` in `wrangler.jsonc` is already set to the production domain — only
touch it if that domain ever changes.

## Check it works

`npx wrangler tail flexed-keepwarm` and wait for a tick, or just open the
Worker's own URL — a plain `fetch` to it pings the app and reports the status.
