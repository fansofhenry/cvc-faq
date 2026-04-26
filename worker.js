// ════════════════════════════════════════════════════════════════════
// CVC FAQ Analytics Worker
// ════════════════════════════════════════════════════════════════════
// A small Cloudflare Worker that receives analytics events from the
// FAQ page and stores them in a Workers KV namespace for later review.
//
// Setup is documented in WORKER_SETUP.md.
//
// Endpoints:
//   POST /log            — accept a JSON event payload from the page
//   GET  /summary?key=…  — basic aggregate report (protected by an
//                          ADMIN_KEY secret); useful for Henry to review
//                          weekly without exposing all raw logs
//   GET  /                — health check
//
// CORS: allows requests from the GitHub Pages origin (wildcard fallback).
// ════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return json({ ok: true, service: 'cvc-faq-analytics' });
    }

    if (url.pathname === '/log' && request.method === 'POST') {
      return logEvent(request, env);
    }

    if (url.pathname === '/summary' && request.method === 'GET') {
      return summary(url, env);
    }

    return new Response('not found', { status: 404, headers: corsHeaders() });
  }
};

async function logEvent(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }

  // basic shape validation
  if (!body || typeof body.event !== 'string') {
    return json({ error: 'missing event' }, 400);
  }

  // size guard
  const keys = ['event', 'data', 'sid', 'page', 'lang', 'ts', 'ua'];
  const cleaned = {};
  for (const k of keys) cleaned[k] = body[k];
  cleaned.cf_country = request.cf?.country || null;
  cleaned.cf_colo = request.cf?.colo || null;
  cleaned.received = new Date().toISOString();

  const ts = body.ts || Date.now();
  const key = `log:${ts}:${Math.random().toString(36).slice(2, 8)}`;

  // store in KV with 90-day expiry
  if (env.LOGS) {
    try {
      await env.LOGS.put(key, JSON.stringify(cleaned), { expirationTtl: 60 * 60 * 24 * 90 });
    } catch (e) {
      return json({ error: 'kv write failed', detail: String(e) }, 500);
    }
  }

  // also bump a counter per event type (cheap aggregation)
  if (env.LOGS) {
    const counterKey = `count:${cleaned.event}`;
    try {
      const cur = parseInt((await env.LOGS.get(counterKey)) || '0', 10);
      await env.LOGS.put(counterKey, String(cur + 1));
    } catch (e) {}
  }

  return json({ ok: true });
}

async function summary(url, env) {
  const adminKey = url.searchParams.get('key');
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.LOGS) return json({ error: 'no kv binding' }, 500);

  const counters = {};
  const list = await env.LOGS.list({ prefix: 'count:' });
  for (const k of list.keys) {
    const v = await env.LOGS.get(k.name);
    counters[k.name.replace('count:', '')] = parseInt(v || '0', 10);
  }

  // Recent searches (last ~50)
  const recent = await env.LOGS.list({ prefix: 'log:', limit: 200 });
  const events = [];
  for (const k of recent.keys.reverse().slice(0, 50)) {
    const v = await env.LOGS.get(k.name);
    if (v) {
      try { events.push(JSON.parse(v)); } catch (e) {}
    }
  }

  // Aggregate top search queries
  const queryCounts = {};
  const noMatchQueries = [];
  for (const ev of events) {
    if (ev.event === 'search_query' && ev.data?.q) {
      const q = ev.data.q.toLowerCase().trim();
      queryCounts[q] = (queryCounts[q] || 0) + 1;
      if (ev.data.results === 0) noMatchQueries.push(q);
    }
  }
  const topQueries = Object.entries(queryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // Helpful ratio per top entry
  const helpful = { yes: {}, no: {} };
  for (const ev of events) {
    if (ev.event === 'helpful_yes' && ev.data?.top_id) {
      helpful.yes[ev.data.top_id] = (helpful.yes[ev.data.top_id] || 0) + 1;
    }
    if (ev.event === 'helpful_no' && ev.data?.top_id) {
      helpful.no[ev.data.top_id] = (helpful.no[ev.data.top_id] || 0) + 1;
    }
  }

  return json({
    counters,
    top_queries: topQueries,
    no_match_queries: [...new Set(noMatchQueries)].slice(0, 30),
    helpful,
    recent_events_sample: events.slice(0, 20),
    note: 'Aggregations are based on recent log entries. Counters are lifetime since deploy.'
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}
