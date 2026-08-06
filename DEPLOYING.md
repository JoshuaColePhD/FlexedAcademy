# Deploying, and iterating after you have

The short version: **the site runs `master`. Everything else is yours to break.**

## The loop

```bash
git checkout -b try-something      # site keeps running the old version
# ...edit, run ./run.sh, look at localhost:8010...
git add -A && git commit -m "..."  # still nothing happens to the site
git push -u origin try-something   # STILL nothing — Render only watches master
```

When you actually like it:

```bash
git checkout master
git merge try-something
git push                           # <- this is the deploy
```

Render sees the push to `master`, rebuilds, and swaps the site over. That's the
only step that touches production. If you never merge, the site never changes.

To throw the experiment away instead: `git checkout master && git branch -D try-something`.

## What "deploy" actually costs

The build runs the whole pipeline — `npm ci`, `vite build`, `pip install` — so
even a one-word change is several minutes on the free plan, and **the site is
down while it swaps**. Batch your changes; don't push ten times in a row.

## The one thing that is NOT isolated

Your laptop and the live site share **one Supabase database**.

Code is isolated by the branch. Data is not. Concretely:

* Reading is harmless. Editing the UI, the prompts, the layout, the copy — all
  of that is safe. You are just looking at the same rows the site looks at.
* **Generating a plan locally creates a real plan.** It shows up on the live
  site, in your real list.
* **A new migration applied locally changes the live schema.** `db.connect()`
  runs `migrate()` at boot, so this happens the moment you start the server —
  and again, automatically, the moment Render deploys.

So: iterate on the interface freely. Be deliberate about generating, deleting,
and anything in `MIGRATIONS`.

If that stops being comfortable — most likely the day another teacher has plans
in there you would hate to lose — a second Supabase project is free. Point
`DATABASE_URL` in your local `.env` at it, leave Render's pointing at the real
one, and the two stop touching. The dev database needs the corpus loaded
(`python scripts/02_embed_store.py`, a few cents of OpenAI embedding) or
retrieval comes back empty and every generation refuses.

## Adding a migration

`MIGRATIONS` in `backend/db.py` is append-only and applied at boot, by version
index. Never edit or reorder an existing entry — `MIGRATIONS[version:]` is what
decides what still needs running.

Because it applies automatically on deploy, a new migration is the one change
worth reading twice before merging. Write it idempotent (`IF NOT EXISTS`,
guarded backfills) so a replay after a failed deploy is safe.

## Rolling back

Render keeps previous deploys and can roll back from the dashboard. From git:

```bash
git revert <bad-commit> && git push
```

which is a normal deploy of the previous state, and is usually less confusing
than a dashboard rollback that leaves `master` disagreeing with the site.
