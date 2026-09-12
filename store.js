// Cloud message store per customer (keyed by phone) — Vercel KV free tier.
// Enable once: Vercel dashboard → Storage → Create KV database. Env vars are injected automatically.
// Without KV configured the endpoint answers 501 and clients keep using device + Discord layers.

const hasKV = () => process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

async function kv(cmd) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return Array.isArray(j) ? j[j.length - 1].result : j.result;
}

const clean = (s, n) => String(s || '').replace(/[<>`\\]/g, '').slice(0, n || 500);
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); }

// only the real front-ends may talk to this API
function originOk(req) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return true;
  try {
    const h = new URL(o).hostname;
    return ['bilalcheat.vercel.app', 'infobilalurl.vercel.app', 'localhost', '127.0.0.1'].includes(h) ||
      ['arena.site', 'csb.app', 'stackblitz.io', 'webcontainer.io'].some(d => h === d || h.endsWith('.' + d));
  } catch (_) { return false; }
}
// per-IP minute bucket — stops relay spam (active when KV is attached)
async function rateOk(ip) {
  if (!hasKV()) return true;
  try {
    const key = 'rl:' + ip + ':' + Math.floor(Date.now() / 60000);
    const n = await kv(['INCR', key]);
    if (n === 1) await kv(['EXPIRE', key, 90]).catch(() => {});
    return Number(n) <= 15;
  } catch (_) { return true; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ip = String(req.headers['x-forwarded-for'] || 'anon').split(',')[0].trim();

  // deployment-bound fragment + one-time nonce — replay-proof signatures
  if (req.method === 'GET' && req.query.handshake) {
    if (!(await rateOk(ip))) return res.status(429).json({ ok: false });
    const nonce = Math.random().toString(16).slice(2) + Date.now().toString(16);
    if (hasKV()) await kv(['SET', 'n:' + nonce, String(Date.now()), 'EX', '600']).catch(() => {});
    return res.status(200).json({ ok: true, frag: process.env.BC_FRAG || 'bc-open-frag-v1', nonce });
  }
  if (!hasKV()) return res.status(501).json({ ok: false, reason: 'kv-not-configured' });

  if (req.method === 'POST') {
    if (!originOk(req) || !(await rateOk(ip))) return res.status(429).json({ ok: false });
    const { ts, sig, ...core } = req.body || {};
    const frag = process.env.BC_FRAG || 'bc-open-frag-v1';
    if (!ts || !sig || Math.abs(Date.now() - Number(ts)) > 300000 || sig !== djb2(JSON.stringify(core) + ts + frag)) {
      return res.status(403).json({ ok: false });
    }
    if (hasKV() && core.nonce) {
      const live = await kv(['GET', 'n:' + core.nonce]).catch(() => null);
      if (!live) return res.status(403).json({ ok: false });
    }
  }

  // admin presence heartbeat (cross-device)
  if (req.method === 'GET' && req.query.presence) {
    const raw = await kv(['GET', 'bc:presence']).catch(() => null);
    let presence = null;
    try { presence = raw ? JSON.parse(raw) : null; } catch (_) {}
    return res.status(200).json({ ok: true, presence });
  }
  if (req.method === 'POST' && (req.body || {}).type === 'presence') {
    await kv(['SET', 'bc:presence', JSON.stringify({ t: Date.now() })]).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  const src = req.method === 'GET' ? req.query : req.body;
  const phone = String((src && src.phone) || '').replace(/\D/g, '');
  if (phone.length < 8) return res.status(400).json({ ok: false });
  const key = 'bc:' + phone;

  if (req.method === 'GET') {
    const raw = await kv(['GET', key]).catch(() => null);
    let rec = null;
    try { rec = raw ? JSON.parse(raw) : null; } catch (_) {}
    return res.status(200).json({ ok: true, rec });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const raw = await kv(['GET', key]).catch(() => null);
    let rec;
    try { rec = raw ? JSON.parse(raw) : null; } catch (_) { rec = null; }
    if (!rec) rec = { phone, name: '', plan: '', photo: null, messages: [] };

    if (b.name) rec.name = clean(b.name, 60);
    if (b.plan) rec.plan = clean(b.plan, 40);
    if (b.photo && String(b.photo).startsWith('data:image')) rec.photo = String(b.photo).slice(0, 400000);

    const from = clean(b.from, 8) === 'admin' ? 'admin' : 'customer';
    if (b.msg) rec.messages.push({ from, text: clean(b.msg, 800), t: Date.now() });
    if (b.file && (b.file.key || String(b.file.data || '').startsWith('data:'))) {
      rec.messages.push({ from, text: '', t: Date.now(), file: {
        name: clean(b.file.name, 80), size: +b.file.size || 0,
        type: clean(b.file.type, 40),
        key: b.file.key ? clean(b.file.key, 40) : undefined,
        data: b.file.data ? String(b.file.data).slice(0, 3000000) : undefined
      }});
    }
    rec.messages = rec.messages.slice(-200);
    await kv(['SET', key, JSON.stringify(rec)]);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false });
}
