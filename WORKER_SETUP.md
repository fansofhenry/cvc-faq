# Analytics Worker — setup

Lightweight analytics for the FAQ. Logs which questions students ask, which entries get clicked, and which entries actually solve the problem ("Did this help?" feedback). Uses Cloudflare Workers free tier (no monthly cost at expected volumes).

Until you deploy this, all events are stored client-side in `localStorage` under the key `cvc_logs`. Open the live page, run `cvcLogs()` in the browser console to see them. So the analytics work even without the worker — they just don't get aggregated centrally.

---

## What you'll need

- A free Cloudflare account ([dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up))
- 10 minutes
- The `worker.js` file in this repo

---

## Setup steps

### 1. Install Wrangler (Cloudflare's CLI)

```bash
npm install -g wrangler
wrangler login
```

This opens a browser to authorize Wrangler against your Cloudflare account.

### 2. Create a KV namespace

KV is Cloudflare's lightweight key-value store. Free tier is 1 GB and 100k writes/day — way more than this FAQ will ever use.

```bash
wrangler kv namespace create LOGS
```

The command prints a namespace `id`. Copy it.

### 3. Create `wrangler.toml` next to `worker.js`

```toml
name = "cvc-faq-analytics"
main = "worker.js"
compatibility_date = "2026-01-01"

[[kv_namespaces]]
binding = "LOGS"
id = "PASTE_THE_KV_ID_HERE"
```

### 4. Set an admin key for the summary endpoint

```bash
wrangler secret put ADMIN_KEY
```

It prompts for a value — pick a long random string (e.g., from a password manager). This is what you'll use to authenticate when fetching the summary report.

### 5. Deploy

```bash
wrangler deploy
```

You'll get a URL like `https://cvc-faq-analytics.YOUR-SUBDOMAIN.workers.dev`. Save it.

### 6. Wire the page to the worker

Edit `index.html`. Find this line:

```js
const ANALYTICS_URL = window.CVC_ANALYTICS_URL || '';
```

Change to:

```js
const ANALYTICS_URL = 'https://cvc-faq-analytics.YOUR-SUBDOMAIN.workers.dev/log';
```

Or, cleaner — add this `<script>` tag near the top of `<body>` so the URL stays separate from the main code:

```html
<script>window.CVC_ANALYTICS_URL = 'https://cvc-faq-analytics.YOUR-SUBDOMAIN.workers.dev/log';</script>
```

Commit and push. The page now sends events to your worker.

---

## Reading the data

```bash
curl 'https://cvc-faq-analytics.YOUR-SUBDOMAIN.workers.dev/summary?key=YOUR_ADMIN_KEY'
```

Returns:
- **counters** — lifetime counts per event type (`page_view`, `search_query`, `entry_open`, `result_click`, `helpful_yes`, `helpful_no`, `chip_click`, `voice_start`, `link_copied`, `lang_switch`, etc.)
- **top_queries** — most common search queries (last ~200 events)
- **no_match_queries** — queries that returned zero results (these are the most actionable — they tell you what tags to add)
- **helpful** — per-entry yes/no counts
- **recent_events_sample** — last 20 events for spot-checking

For a more polished dashboard later, you can build a simple HTML page that fetches `/summary` and renders it.

---

## What the events look like

Each event sent by the page has this shape:

```json
{
  "event": "search_query",
  "data": { "q": "i paid but it didnt work", "results": 4, "top_id": "sym-paid", "top_score": 92 },
  "sid": "k3j2h1g0",
  "page": "/cvc-faq/",
  "lang": "en",
  "ts": 1745700000000,
  "ua": "Mozilla/5.0 ..."
}
```

`sid` is a per-session random ID — not personally identifying, but lets you tell "one student looking around" from "many separate students."

---

## Privacy notes

- No names, emails, CCCIDs, or PII are sent — only what students type into the search box.
- Cloudflare logs the IP at the network level (you can't avoid this), but the worker doesn't store IPs in KV.
- Events expire from KV after 90 days automatically.
- Lifetime counters don't expire (just numeric totals per event type).

If you want to be extra cautious about students' search text being stored, you can edit `worker.js` to truncate or hash `data.q` before storage.

---

## Cost expectation

At expected FAQ volume (a few hundred sessions/month), you'll stay well within Cloudflare's free tier:
- Free tier includes 100,000 worker requests/day and 1,000 KV writes/day
- This worker writes ~1–10 events per student session
- Even a high-traffic month would use <5% of free tier

If somehow this exceeds free tier, the next paid tier is $5/month for 10x the limit.
