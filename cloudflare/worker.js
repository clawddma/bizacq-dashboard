/**
 * BizAcq API — Cloudflare Worker
 *
 * Backend de escritura para el dashboard BizAcq. Permite que Daniel y su socio
 * agreguen/muevan deals sin pegar mensajes a Claude. GitHub (deals.json) sigue
 * siendo la fuente de verdad — Claude accede vía git pull.
 *
 * Secrets (set con `wrangler secret put`):
 *   GITHUB_TOKEN  — fine-grained PAT con Contents:write sobre clawddma/bizacq-dashboard
 *
 * Endpoints:
 *   GET  /deals        → lee deals.json (proxy de GitHub raw, siempre fresco)
 *   POST /add-deal     → agrega lead crudo en estado PENDIENTE_ANALISIS + commit
 *   POST /update-deal  → cambia pipeline_status / discard_reason / manual_orders + commit
 *   GET  /health       → ping
 *
 * Protección (escritura "abierta" pero blindada contra bots):
 *   - Origin allowlist (solo el dashboard puede escribir)
 *   - Rate limit por IP (KV) — 30 escrituras/hora
 *   - Validación estricta del payload
 */

const REPO = 'clawddma/bizacq-dashboard';
const FILE = 'data/deals.json';
const BRANCH = 'main';
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}`;
const API_BASE = `https://api.github.com/repos/${REPO}/contents/${FILE}`;

const ALLOWED_ORIGINS = [
  'https://bizacq.bellapop.co',
  'https://clawddma.github.io',
  'http://localhost:8000',
  'http://localhost:3000',
];

const WRITE_LIMIT_PER_HOUR = 30;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ── Rate limit usando KV (opcional — si no hay KV binding, se omite) ──
async function rateLimited(env, ip) {
  if (!env.RATE_KV) return false; // sin KV configurado, no limita
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`; // por hora
  const current = parseInt((await env.RATE_KV.get(key)) || '0', 10);
  if (current >= WRITE_LIMIT_PER_HOUR) return true;
  await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 3700 });
  return false;
}

// ── GitHub helpers ──
async function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'bizacq-worker',
  };
}

async function getDealsFile(env) {
  const res = await fetch(`${API_BASE}?ref=${BRANCH}`, { headers: await ghHeaders(env) });
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const meta = await res.json();
  const decoded = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ''))));
  return { data: JSON.parse(decoded), sha: meta.sha };
}

async function putDealsFile(env, data, sha, message) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const res = await fetch(API_BASE, {
    method: 'PUT',
    headers: { ...(await ghHeaders(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha, branch: BRANCH }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub PUT ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ── GitHub helpers genéricos (para cualquier archivo, no solo deals.json) ──
async function getFile(env, path) {
  const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const res = await fetch(`${api}?ref=${BRANCH}`, { headers: await ghHeaders(env) });
  if (res.status === 404) return { data: null, sha: null }; // archivo aún no existe
  if (!res.ok) throw new Error(`GitHub GET ${path} ${res.status}`);
  const meta = await res.json();
  const decoded = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ''))));
  return { data: JSON.parse(decoded), sha: meta.sha };
}

async function putFile(env, path, data, sha, message) {
  const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const body = { message, content, branch: BRANCH };
  if (sha) body.sha = sha; // sha solo si el archivo ya existe
  const res = await fetch(api, {
    method: 'PUT',
    headers: { ...(await ghHeaders(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub PUT ${path} ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ── UUID v4 ──
function uuid() {
  return crypto.randomUUID();
}

// ── Validación del payload de add-deal ──
function sanitizeAddPayload(p) {
  const clean = {
    listingUrl: String(p.listingUrl || '').slice(0, 500),
    websiteUrl: String(p.websiteUrl || '').slice(0, 500),
    category: String(p.category || '').slice(0, 100),
    state: String(p.state || '').slice(0, 4).toUpperCase(),
    askingPrice: String(p.askingPrice || '').slice(0, 30),
    title: String(p.title || '').slice(0, 200),
    notes: String(p.notes || '').slice(0, 2000),
    author: String(p.author || 'socio').slice(0, 50),
  };
  // Al menos un URL o notas
  if (!clean.listingUrl && !clean.websiteUrl && !clean.notes) {
    return { error: 'Falta al menos un URL o notas' };
  }
  return { clean };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ── GET / — página de status amigable (para cuando abres la URL en el navegador) ──
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      let dealCount = '?';
      try {
        const r = await fetch(`${RAW_URL}?_=${Date.now()}`);
        const d = await r.json();
        dealCount = (d.deals || []).length;
      } catch {}
      const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BizAcq API</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px;max-width:520px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{margin:0 0 4px;font-size:22px}.ok{color:#34d399;font-weight:700}
.muted{color:#94a3b8;font-size:14px;line-height:1.6}
code{background:#0f172a;padding:2px 7px;border-radius:5px;font-size:13px;color:#a5b4fc}
.row{display:flex;gap:8px;margin-top:8px;align-items:center}
a{color:#60a5fa}</style></head><body>
<div class="card">
<h1>🟢 BizAcq API <span class="ok">activo</span></h1>
<p class="muted">Este es el backend (Cloudflare Worker) del dashboard BizAcq. No es una página para visitar — es la API que recibe los negocios que tú y tu socio agregan.</p>
<p class="muted"><strong>${dealCount}</strong> deals en la base de datos ahora mismo.</p>
<div class="row"><code>GET /health</code> <span class="muted">— ping</span></div>
<div class="row"><code>GET /deals</code> <span class="muted">— lee todos los deals</span></div>
<div class="row"><code>POST /add-deal</code> <span class="muted">— agrega negocio (desde el dashboard)</span></div>
<div class="row"><code>POST /update-deal</code> <span class="muted">— mueve/actualiza (desde el dashboard)</span></div>
<p class="muted" style="margin-top:20px">👉 El dashboard está en <a href="https://clawddma.github.io/bizacq-dashboard/">clawddma.github.io/bizacq-dashboard</a></p>
</div></body></html>`;
      return new Response(html, { headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // ── GET /health ──
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'bizacq-api' }, 200, cors);
    }

    // ── GET /deals ──
    if (request.method === 'GET' && url.pathname === '/deals') {
      try {
        const r = await fetch(`${RAW_URL}?_=${Date.now()}`);
        const txt = await r.text();
        return new Response(txt, { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return json({ error: String(e) }, 502, cors);
      }
    }

    // ── POST /checkpoint-apply — la routine nocturna remota escribe vía Worker ──
    // El remoto NO es browser (sin Origin), se autentica con CHECKPOINT_TOKEN en header.
    // Recibe el array `deals` ya reconciliado + una entrada de `logEntry`, y commitea ambos archivos.
    if (request.method === 'POST' && url.pathname === '/checkpoint-apply') {
      const auth = request.headers.get('X-Checkpoint-Token') || '';
      if (!env.CHECKPOINT_TOKEN || auth !== env.CHECKPOINT_TOKEN) {
        return json({ error: 'no autorizado' }, 401, cors);
      }
      if (!env.GITHUB_TOKEN) {
        return json({ error: 'GITHUB_TOKEN no configurado en el Worker' }, 500, cors);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400, cors); }
      const incoming = body.deals;
      // Validación anti-corrupción: debe ser un array no vacío de objetos con id.
      if (!Array.isArray(incoming) || incoming.length === 0) {
        return json({ error: 'payload.deals debe ser un array no vacío' }, 400, cors);
      }
      try {
        const { data, sha } = await getDealsFile(env);
        const existingCount = (data.deals || []).length;
        // Salvaguarda: no permitir que un run borre deals (cuenta no puede caer >20%).
        if (incoming.length < existingCount * 0.8) {
          return json({ error: `rechazado: incoming ${incoming.length} vs actual ${existingCount} (posible corrupción)` }, 409, cors);
        }
        if (!incoming.every((d) => d && typeof d.id === 'string')) {
          return json({ error: 'todos los deals deben tener id string' }, 400, cors);
        }
        data.deals = incoming;
        data.last_update = (body.lastUpdate ? String(body.lastUpdate).slice(0, 80) : new Date().toISOString().slice(0, 16).replace('T', ' ') + ' (checkpoint nocturno)');
        const msg = String(body.commitMessage || 'chore: checkpoint nocturno — categorías + disponibilidad (vía Worker)').slice(0, 200);
        await putDealsFile(env, data, sha, msg);

        // Append de la entrada de log (data/checkpoint_log.json) — append-only, más reciente al inicio.
        let logResult = 'sin logEntry';
        if (body.logEntry && typeof body.logEntry === 'object') {
          const { data: logData, sha: logSha } = await getFile(env, 'data/checkpoint_log.json');
          const arr = Array.isArray(logData) ? logData : [];
          arr.unshift(body.logEntry);
          if (arr.length > 120) arr.length = 120; // retener ~4 meses de runs diarios
          await putFile(env, 'data/checkpoint_log.json', arr, logSha, 'chore: checkpoint log nocturno');
          logResult = `log actualizado (${arr.length} entradas)`;
        }
        return json({ ok: true, deals_persisted: incoming.length, log: logResult }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 502, cors);
      }
    }

    // ── POST endpoints — escritura protegida ──
    if (request.method === 'POST') {
      // Origin allowlist (filtra abuso casual de bots/terceros)
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return json({ error: 'origin no permitido' }, 403, cors);
      }
      // Rate limit
      if (await rateLimited(env, ip)) {
        return json({ error: 'rate limit excedido (30/hora)' }, 429, cors);
      }
      if (!env.GITHUB_TOKEN) {
        return json({ error: 'GITHUB_TOKEN no configurado en el Worker' }, 500, cors);
      }

      let body;
      try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400, cors); }

      // ── POST /add-deal ──
      if (url.pathname === '/add-deal') {
        const { clean, error } = sanitizeAddPayload(body);
        if (error) return json({ error }, 400, cors);
        try {
          const { data, sha } = await getDealsFile(env);
          const id = uuid();
          const deal = {
            id,
            source: 'manual',
            source_url: clean.listingUrl || clean.websiteUrl || '',
            source_url_kind: 'listing',
            source_url_verified: false,
            added_manually: true,
            pending_analysis: true,
            title: clean.title || `Lead pendiente — ${clean.category || 'sin categoría'} (${clean.state || '??'})`,
            state: clean.state || '',
            city: '',
            business_type: clean.category || 'Sin categoría',
            years_operation: null,
            asking_price: parseInt(clean.askingPrice.replace(/[^0-9]/g, ''), 10) || null,
            reported_revenue: null,
            reported_sde: null,
            seller_financing: false,
            sba_prequalified: false,
            curated_source: false,
            raw_description: clean.notes || 'Agregado vía dashboard, pendiente de análisis por Claude.',
            pipeline_status: 'RADAR',
            filter_score: null,
            overall_score: null,
            priority: null,
            financial: null,
            strategy: null,
            legal_check: { done: false },
            events: [
              { created_at: new Date().toISOString().slice(0, 10), description: `Agregado por ${clean.author} vía dashboard (Cloudflare Worker) — PENDIENTE ANÁLISIS` },
            ],
            notes: clean.notes ? [{ author: clean.author, created_at: new Date().toISOString().slice(0, 10), text: clean.notes }] : [],
          };
          data.deals.push(deal);
          data.manual_orders = data.manual_orders || {};
          data.manual_orders.RADAR = data.manual_orders.RADAR || [];
          data.manual_orders.RADAR.push(id);
          data.last_update = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC (dashboard)';
          await putDealsFile(env, data, sha, `feat: nuevo lead pendiente análisis (${deal.title.slice(0, 50)}) — vía dashboard`);
          return json({ ok: true, id, deal }, 200, cors);
        } catch (e) {
          return json({ error: String(e) }, 502, cors);
        }
      }

      // ── POST /update-deal ──
      if (url.pathname === '/update-deal') {
        const dealId = String(body.dealId || '');
        if (!dealId) return json({ error: 'falta dealId' }, 400, cors);
        try {
          const { data, sha } = await getDealsFile(env);
          const deal = data.deals.find((d) => d.id === dealId);
          if (!deal) return json({ error: 'deal no encontrado' }, 404, cors);
          const changes = [];
          if (body.newStatus && body.newStatus !== deal.pipeline_status) {
            const old = deal.pipeline_status;
            const VALID = ['RADAR', 'EN_ANALISIS', 'PARA_CONTACTAR', 'EN_NEGOCIACION', 'CIERRE', 'DESCARTADO'];
            if (!VALID.includes(body.newStatus)) return json({ error: 'status inválido' }, 400, cors);
            deal.pipeline_status = body.newStatus;
            if (body.discardReason) deal.discard_reason = String(body.discardReason).slice(0, 500);
            deal.events = deal.events || [];
            deal.events.push({ created_at: new Date().toISOString().slice(0, 10), description: `Movido ${old} → ${body.newStatus} (dashboard)` });
            changes.push(`${(deal.title || dealId).slice(0, 30)} → ${body.newStatus}`);
          }
          if (body.note) {
            deal.notes = deal.notes || [];
            deal.notes.push({ author: String(body.author || 'socio').slice(0, 50), created_at: new Date().toISOString().slice(0, 10), text: String(body.note).slice(0, 2000) });
            changes.push(`nota en ${(deal.title || dealId).slice(0, 30)}`);
          }
          if (body.document && (body.document.url || body.document.name)) {
            const VALID_KINDS = ['listing', 'broker', 'benchmark', 'legal', 'financiero', 'otro'];
            const doc = {
              name: String(body.document.name || body.document.url || 'documento').slice(0, 200),
              url: String(body.document.url || '').slice(0, 1000),
              kind: VALID_KINDS.includes(body.document.kind) ? body.document.kind : 'otro',
              added_by: String(body.author || 'socio').slice(0, 50),
              added_at: new Date().toISOString().slice(0, 10),
            };
            deal.documents = deal.documents || [];
            deal.documents.push(doc);
            deal.events = deal.events || [];
            deal.events.push({ created_at: doc.added_at, description: `📎 Documento adjuntado (${doc.kind}): ${doc.name.slice(0, 60)}` });
            changes.push(`doc en ${(deal.title || dealId).slice(0, 30)}`);
          }
          if (body.removeDocumentUrl) {
            const before = (deal.documents || []).length;
            deal.documents = (deal.documents || []).filter((x) => x.url !== body.removeDocumentUrl);
            if (deal.documents.length !== before) changes.push(`doc removido en ${(deal.title || dealId).slice(0, 30)}`);
          }
          if (Array.isArray(body.manualOrder) && body.manualOrderColumn) {
            data.manual_orders = data.manual_orders || {};
            data.manual_orders[body.manualOrderColumn] = body.manualOrder.map(String).slice(0, 500);
            changes.push(`orden ${body.manualOrderColumn}`);
          }
          if (changes.length === 0) return json({ ok: true, noop: true }, 200, cors);
          data.last_update = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC (dashboard)';
          await putDealsFile(env, data, sha, `chore: ${changes.slice(0, 3).join(', ')} — vía dashboard`);
          return json({ ok: true, changes }, 200, cors);
        } catch (e) {
          return json({ error: String(e) }, 502, cors);
        }
      }

      // ── POST /request-analysis — marca el deal para que la routine lo procese ──
      if (url.pathname === '/request-analysis') {
        const dealId = String(body.dealId || '');
        if (!dealId) return json({ error: 'falta dealId' }, 400, cors);
        try {
          const { data, sha } = await getDealsFile(env);
          const deal = data.deals.find((d) => d.id === dealId);
          if (!deal) return json({ error: 'deal no encontrado' }, 404, cors);
          deal.deep_analysis_requested = true;
          deal.deep_analysis_requested_at = new Date().toISOString();
          deal.events = deal.events || [];
          deal.events.push({ created_at: new Date().toISOString().slice(0, 10), description: 'Análisis profundo solicitado vía dashboard — la routine lo procesará con búsqueda web real' });
          data.last_update = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC (dashboard)';
          await putDealsFile(env, data, sha, `chore: fact-check solicitado — ${(deal.title || dealId).slice(0, 45)}`);
          return json({ ok: true, id: dealId }, 200, cors);
        } catch (e) {
          return json({ error: String(e) }, 502, cors);
        }
      }

      return json({ error: 'endpoint no encontrado' }, 404, cors);
    }

    return json({ error: 'método no soportado' }, 405, cors);
  },
};
