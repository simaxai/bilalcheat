// Vercel serverless relay — the Discord webhook secret lives here, never in the browser.

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
function originOk(req) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return true;
  try {
    const h = new URL(o).hostname;
    return ['bilalcheat.vercel.app', 'infobilalurl.vercel.app', 'localhost', '127.0.0.1'].includes(h) ||
      ['arena.site', 'csb.app', 'stackblitz.io', 'webcontainer.io'].some(d => h === d || h.endsWith('.' + d));
  } catch (_) { return false; }
}
async function rateOk(ip) {
  if (!hasKV()) return true;
  try {
    const key = 'rl:' + ip + ':' + Math.floor(Date.now() / 60000);
    const n = await kv(['INCR', key]);
    if (n === 1) await kv(['EXPIRE', key, 90]).catch(() => {});
    return Number(n) <= 15;
  } catch (_) { return true; }
}
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const ip = String(req.headers['x-forwarded-for'] || 'anon').split(',')[0].trim();
  if (!originOk(req) || !(await rateOk(ip))) return res.status(429).json({ ok: false });

  const clean = (s, max) => String(s || '').replace(/[<>`\\{}[\]]/g, '').slice(0, max || 80);
  const b = req.body || {};

  // request signature: freshness + integrity against the deployment fragment
  const { ts, sig, ...core } = b;
  const frag = process.env.BC_FRAG || 'bc-open-frag-v1';
  if (!ts || !sig || Math.abs(Date.now() - Number(ts)) > 300000 || sig !== djb2(JSON.stringify(core) + ts + frag)) {
    return res.status(403).json({ ok: false });
  }
  if (hasKV() && core.nonce) {
    const live = await kv(['GET', 'n:' + core.nonce]).catch(() => null);
    if (!live) return res.status(403).json({ ok: false });
  }

  const WEBHOOK = process.env.DISCORD_WEBHOOK ||
    'https://discord.com/api/webhooks/1547720357396619415/vrZtiymunaJ8Zd8jaSU3w78Zt6yvac_5giiaJVju7WUFhcv8VxU_o3-S-vPpQhWE-DZU';

  // generic notification relay — chat messages stay server-side only
  if (b.type === 'notify') {
    const payload = {
      username: 'BILAL CHEAT • Messages',
      embeds: [{
        title: clean(b.title, 120) || 'Message', color: 0xa855f7,
        description: clean(b.desc, 1500),
        fields: (Array.isArray(b.fields) ? b.fields : []).slice(0, 6).map(f => ({ name: clean(f.name, 40), value: clean(f.value, 200), inline: !!f.inline })),
        footer: { text: 'BILAL CHEAT — Free Fire' }
      }]
    };
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  }

  const name = clean(b.name, 60);
  const phone = clean(b.phone, 30);
  const plan = clean(b.plan, 70);
  const payment = clean(b.payment, 30);
  const id = /^BC-[A-Z0-9]{5}$/.test(String(b.id || '')) ? b.id : 'BC';

  if (name.length < 2 || (phone.match(/\d/g) || []).length < 8 || !plan) {
    return res.status(400).json({ ok: false });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

  const payload = {
    username: 'BILAL CHEAT • Orders',
    embeds: [{
      title: 'New Order — ' + id,
      color: 0xa855f7,
      description: '**Name:** ' + name + '\n**Phone:** ' + phone,
      fields: [
        { name: 'Plan', value: plan, inline: false },
        { name: 'Payment', value: payment || '-', inline: true },
        { name: 'IP', value: ip, inline: true },
        { name: 'Time', value: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', inline: true }
      ],
      footer: { text: 'BILAL CHEAT — Free Fire' }
    }]
  };

  try {
    const r = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch (e) {
    return res.status(502).json({ ok: false });
  }
}
