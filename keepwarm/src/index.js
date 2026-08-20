/**
 * Keeps the free Render instance awake during the hours teachers actually plan.
 *
 * Render's free web services sleep after 15 minutes idle, and waking one takes
 * roughly 50 seconds — on top of a 10 second generation. That is the difference
 * between "slow" and "broken" when it is a colleague's first impression.
 *
 * Deliberately NOT a 24/7 ping. Render's free tier grants ~750 instance-hours a
 * month and holding one service up around the clock spends ~730 of them to
 * serve a handful of requests a week, with no headroom left if Render counts
 * an hour slightly differently than expected. The cron below covers 6am-10pm
 * US Central, every day — evenings and weekends included, since that's when
 * take-home lesson planning happens, not just the school day — which is
 * ~480 hours a month and leaves real slack in the allowance.
 *
 * Costs nothing: Workers free allows 100,000 requests a day and this makes
 * a few hundred a month.
 */
export default {
  async scheduled(event, env, ctx) {
    const url = env.APP_URL;
    if (!url) return;
    try {
      // /api/health is the cheapest endpoint that proves the app is actually up
      // rather than just that something answered the port.
      const res = await fetch(`${url}/api/health`, {
        headers: { "user-agent": "flexed-keepwarm" },
      });
      console.log(`keepwarm ${res.status} ${url}`);
    } catch (err) {
      // A failed ping is not worth retrying — the next one is minutes away.
      console.log(`keepwarm failed: ${err}`);
    }
  },

  // Hitting the Worker's own URL warms the app too, which is handy for testing
  // that the binding is right without waiting for a cron tick.
  async fetch(request, env) {
    const url = env.APP_URL;
    if (!url) return new Response("APP_URL is not set", { status: 500 });
    const res = await fetch(`${url}/api/health`);
    return new Response(`pinged ${url} -> ${res.status}\n`, {
      headers: { "content-type": "text/plain" },
    });
  },
};
