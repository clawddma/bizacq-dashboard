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
  'https://bizacq-radar.danielmesar959464.chatgpt.site',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8789',
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
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control':'no-store' },
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
  if (meta.content) {
    const decoded = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ''))));
    return { data: JSON.parse(decoded), sha: meta.sha };
  }
  // GitHub omits inline content above 1 MB; retain the metadata SHA for CAS.
  const raw = await fetch(API_BASE, {headers:{...(await ghHeaders(env)),Accept:'application/vnd.github.raw+json'}});
  if (!raw.ok) throw new Error(`GitHub raw GET ${raw.status}`);
  return {data:await raw.json(),sha:meta.sha};
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

// Deterministic preliminary screen. Unknown evidence earns no points; coverage is separate.
export function screenDeal(d, now=new Date().toISOString()) {
  const days=v=>v && Number.isFinite(Date.parse(v)) ? Math.max(0,Math.floor((Date.parse(now)-Date.parse(v))/86400000)):null;
  const e=d.listing_evidence||{},m=d.operating_metrics||{},flags=[],unknowns=[];
  const age=e.publication_source==='portal'?days(e.published_at):null,checked=days(e.checked_at);
  const direct=d.source_url_kind==='listing'&&e.status==='published'&&checked!==null&&checked<=7;
  if(d.source_url_kind!=='listing')flags.push('No hay enlace a una oferta individual identificada');
  if(!direct)flags.push('Disponibilidad pendiente de comprobación directa reciente');
  if(age!==null&&age>365)flags.push('Más de un año publicada: confirmar disponibilidad, precio y motivo de permanencia');
  else if(age!==null&&age>180)flags.push('Más de seis meses publicada: revisar cambios de precio y motivo de venta');
  if(/flowers bread route/i.test(d.title||'')&&/cleaning/i.test(JSON.stringify(d.financial||{})))flags.push('Análisis histórico inconsistente con la actividad del negocio');
  const parts=[];
  const add=(name,weight,points,known,evidence)=>{parts.push({name,weight,points:Math.round(Math.max(0,Math.min(weight,points))*10)/10,coverage:known,evidence});if(known<weight)unknowns.push(name);};
  add('Identidad y vigencia',15,direct?(age!==null&&age>365?8:age!==null&&age>180?11:15):0,direct?15:0,direct?'Oferta individual marcada disponible por el portal; no equivale a confirmación del vendedor':'Falta comprobar una oferta individual disponible');
  const basis=d.reported_net_profit>0?'Beneficio neto anual publicado':d.reported_sde>0?'SDE histórico sin conciliación':d.reported_cash_flow>0?'Flujo publicado; definición pendiente':null;
  const earnings=d.reported_net_profit>0?d.reported_net_profit:d.reported_sde>0?d.reported_sde:d.reported_cash_flow>0?d.reported_cash_flow:null;
  const multiple=d.asking_price>0&&earnings>0?d.asking_price/earnings:null;
  // Value is indicative only: no debt/capex/working-capital deductions are known yet.
  add('Valoración indicativa',20,multiple===null?0:multiple<=2?20:multiple<=3?16:multiple<=4?11:multiple<=5?6:2,multiple===null?0:20,multiple===null?'Faltan precio o utilidades anuales':multiple.toFixed(2)+'× · '+basis+'; conciliar ajustes, deuda, inventario y caja');
  const operatingAge=days(m.first_made_money_at),trend=typeof m.net_profit_trend_percent==='number'?m.net_profit_trend_percent:null;
  add('Calidad y trayectoria financiera',15,(operatingAge===null?0:operatingAge>=1095?5:operatingAge>=365?3:1)+(trend===null?0:trend>=0?5:trend>=-10?2:0), (operatingAge===null?0:5)+(trend===null?0:5), 'Antigüedad operativa '+(operatingAge===null?'no informada':Math.floor(operatingAge/365)+' años')+'; tendencia del beneficio '+(trend===null?'no informada':trend+'% en '+(m.net_profit_trend_percent_months||'?')+' meses')+'; faltan estados y conciliación bancaria/fiscal');
  add('Recurrencia y retención',15,m.mrr>0?5:0,m.mrr>0?5:0,m.mrr>0?'MRR publicado: '+m.mrr+'; faltan cohortes, churn y contratos':'Faltan contratos recurrentes, retención, cohortes y churn');
  add('Concentración y canales',10,0,0,'Faltan porcentajes por cliente, proveedor, plataforma y canal de adquisición');
  const hours=typeof m.hours_worked_per_week==='number'?m.hours_worked_per_week:null;
  add('Dependencia del dueño y transferencia',10,hours===null?0:hours<=10?5:hours<=25?3:1,hours===null?0:5,hours===null?'Faltan horas del dueño, equipo, procesos y transferibilidad':'Dueño: '+hours+' h/semana publicadas; falta validar sustitución, equipo y transferencia de activos');
  add('Automatización y crecimiento',10,0,0,'Hipótesis por validar: tareas, horas, costo de implementación, adopción y demanda; no se presume aumento de ventas');
  add('Viabilidad de la transacción',5,0,0,'Faltan deuda, capex, capital de trabajo, permisos, estructura y condiciones de compra');
  let disposition=(!direct||(age!==null&&age>365))?'revalidate':'eligible';
  if(flags.some(x=>x.startsWith('Análisis histórico')))disposition='revalidate';
  const score=Math.round(parts.reduce((a,p)=>a+p.points,0)),coverage=parts.reduce((a,p)=>a+p.coverage,0);
  return {version:'screen-v1',calculated_at:now,score,coverage,confidence:coverage>=75?'alta':coverage>=40?'media':'baja',disposition,listing_age_days:age,checked_age_days:checked,earnings_basis:basis,multiple:multiple===null?null:Math.round(multiple*100)/100,components:parts,flags,unknowns,questions:['Conciliar 24–36 meses de P&G, declaraciones fiscales y movimientos bancarios; justificar add-backs del SDE.','¿Qué clientes, proveedores y plataformas concentran ventas y margen? Solicitar porcentajes y contratos.','¿Cuánto capital de trabajo, inventario, capex y deuda exige la operación al cierre?','¿Qué tareas realiza el dueño y qué activos, permisos, contratos e IP son transferibles?','Medir tareas automatizables, costo de implantación y ahorro neto; validar crecimiento con demanda y capacidad.','Confirmar disponibilidad con el broker, motivo de venta y evolución del precio.']};
}
export function scoreAllDeals(data,now=new Date().toISOString()) {
  for(const d of data.deals)d.screening=screenDeal(d,now);
  data.screening_model={version:'screen-v1',updated_at:now,description:'Puntos respaldados sobre 100. Los datos faltantes no suman. Modelo preliminar, no predictor calibrado ni recomendación de compra.'};
  return {total:data.deals.length,revalidate:data.deals.filter(d=>d.screening.disposition==='revalidate').length};
}

export function mergeSourceBatch(data, body) {
  const run = body.run;
  if (data.refresh?.last_run?.id === run.id) return {added:0,updated:0,noop:true};
  let added=0,updated=0;
  const seen = new Set();
  for (const row of body.listings) {
    if (!row || typeof row.external_id !== 'string' || !row.external_id || typeof row.title !== 'string' || !row.title.trim()) throw new Error('anuncio inválido');
    let parsed;
    try { parsed=new URL(row.source_url); } catch { throw new Error('URL inválida'); }
    if (parsed.protocol !== 'https:' || row.title.length > 500 || row.external_id.length > 200) throw new Error('anuncio inválido');
    for (const field of ['asking_price','reported_revenue','reported_cash_flow','reported_net_profit']) if (row[field] != null && (!Number.isFinite(row[field]) || row[field] < 0)) throw new Error('importe inválido');
    if (seen.has(row.source_url)) continue;
    seen.add(row.source_url);
    let deal=data.deals.find(d=>String(d.source_url||'').replace(/\/$/,'')===row.source_url.replace(/\/$/,'') || (d.source==='dealledger' && d.external_id===row.external_id));
    const source=row.source==='empire_flippers'?'empire_flippers':'dealledger';
    if (deal && deal.source !== source) continue; // retain manual/other-source facts
    const fields={external_id:row.external_id,source,source_url:row.source_url,source_url_kind:'listing',title:row.title,state:String(row.state||'').slice(0,2),city:String(row.city||'').slice(0,100),business_type:String(row.business_type||'Sin categoría').slice(0,100),asking_price:row.asking_price??null,reported_revenue:row.reported_revenue??null,reported_cash_flow:row.reported_cash_flow??null,reported_net_profit:row.reported_net_profit??null,raw_description:String(row.raw_description||'').slice(0,2000),source_first_seen_at:row.first_seen_at||null,source_last_seen_at:row.last_seen_at||null,source_broker:String(row.broker||'').slice(0,200),source_observation_url:'https://dealledger.org/',source_imported_at:run.finished_at};
    if(source==='empire_flippers') {
      fields.operating_metrics={};
      for(const key of ['first_made_money_at','hours_worked_per_week','net_profit_trend_percent','net_profit_trend_percent_months','mrr','churn_percent','gross_revenue_trend_percent'])if(row.operating_metrics?.[key]!=null)fields.operating_metrics[key]=row.operating_metrics[key];
      if(parsed.hostname!=='empireflippers.com')throw new Error('URL del portal inválida');
      fields.listing_evidence={source_url:row.source_url,checked_at:run.finished_at,status:'published',evidence:'API oficial: listing_status For Sale',publication_source:'portal',published_at:row.published_at||null,publication_evidence:row.published_at?'API oficial first_listed_at':null};
    }
    if (!deal) {
      deal={id:uuid(),...fields,pipeline_status:'RADAR',pending_analysis:true,reported_sde:null,overall_score:null,filter_score:null,priority:null,financial:null,strategy:null,legal_check:{done:false},notes:[],events:[{created_at:run.finished_at,description:'Importado de '+source+'; pendiente de análisis y confirmación comercial.'}],documents:[],added_manually:false,source_url_verified:false,seller_financing:false,sba_prequalified:false,curated_source:false};
      data.deals.push(deal); added++;
    } else {
      const diff=['asking_price','reported_revenue','reported_cash_flow','reported_net_profit'].filter(k=>deal[k]!==fields[k]);
      if(diff.length) {
        deal.source_changes=deal.source_changes||[];
        deal.source_changes.unshift({at:run.finished_at,fields:Object.fromEntries(diff.map(k=>[k,{before:deal[k]??null,after:fields[k]}]))});
        deal.source_changes=deal.source_changes.slice(0,60);
        deal.pending_analysis=true;
      }
      Object.assign(deal,fields);updated++;
    }
  }
  if(Array.isArray(run.primary_listing_urls)&&run.sources?.some(h=>h.source==='empire_flippers'&&h.status==='success'&&h.coverage==='complete')) {
    const active=new Set(run.primary_listing_urls);
    for(const d of data.deals)if(d.source==='empire_flippers'&&!active.has(d.source_url)){d.listing_evidence={...d.listing_evidence,checked_at:run.finished_at,status:'not_in_current_catalog',evidence:'No aparece en el catálogo completo actual. No confirma venta ni cierre.'};}
  }
  data.refresh=data.refresh||{};
  data.refresh.schedule={time:'00:00',timezone:'America/Bogota',engine:'local',llm:false};
  data.refresh.last_run={...run,added,updated};
  if(run.status==='success') data.refresh.last_success_at=run.finished_at;
  data.refresh.history=[data.refresh.last_run,...(data.refresh.history||[])].slice(0,31);
  data.last_update=run.finished_at+' · actualización de fuentes';
  return {added,updated};
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
        const {data} = await getDealsFile(env);
        return json(data,200,cors);
      } catch (e) {
        return json({ error: String(e) }, 502, cors);
      }
    }

    // Isolated live QA record. Cannot delete or replace a real opportunity.
    if(request.method==='POST'&&url.pathname==='/qa-fixture') {
      if(!env.SOURCE_SYNC_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.SOURCE_SYNC_TOKEN}`)return json({error:'no autorizado'},401,cors);
      try {const body=await request.json();const {data,sha}=await getDealsFile(env);const id='bizacq-isolated-qa';
        if(body.action==='remove')data.deals=data.deals.filter(d=>!(d.id===id&&d.is_test_record===true));
        else if(body.action==='create'&&!data.deals.some(d=>d.id===id))data.deals.push({id,is_test_record:true,title:'PRUEBA TÉCNICA TEMPORAL — no es una oferta',source:'qa',source_url:'https://example.com/listing/qa',source_url_kind:'listing',business_type:'QA',state:'',city:'',pipeline_status:'RADAR',notes:[],events:[],documents:[],listing_evidence:{status:'published',checked_at:new Date().toISOString()},pending_analysis:true});
        else return json({error:'acción inválida o fixture existente'},400,cors);
        for(const k of Object.keys(data.manual_orders||{}))data.manual_orders[k]=data.manual_orders[k].filter(v=>v!==id);
        scoreAllDeals(data);await putDealsFile(env,data,sha,'test: '+body.action+' isolated live QA fixture');return json({ok:true,id},200,cors);
      }catch(e){return json({error:String(e)},502,cors);}
    }
    if(request.method==='POST'&&url.pathname==='/screening-rebuild') {
      if(!env.SOURCE_SYNC_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.SOURCE_SYNC_TOKEN}`)return json({error:'no autorizado'},401,cors);
      try {const {data,sha}=await getDealsFile(env);const result=scoreAllDeals(data);await putDealsFile(env,data,sha,'data: screening preliminar y depuración sin modificar decisiones');return json({ok:true,...result},200,cors);}catch(e){return json({error:String(e)},502,cors);}
    }

    // Bounded nightly ingestion: merge source-owned fields, never replace CRM state.
    if (request.method === 'POST' && url.pathname === '/source-sync') {
      if (!env.SOURCE_SYNC_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.SOURCE_SYNC_TOKEN}`) {
        return json({error:'no autorizado'},401,cors);
      }
      let body;
      try { body = await request.json(); } catch { return json({error:'JSON inválido'},400,cors); }
      if (!Array.isArray(body.listings) || body.listings.length > 250 || !body.run || !['dealledger','empire_flippers','open_sources'].includes(body.run.source)) return json({error:'lote inválido'},400,cors);
      try {
        const {data,sha} = await getDealsFile(env);
        const changes = mergeSourceBatch(data,body);
        scoreAllDeals(data);
        await putDealsFile(env,data,sha,`data: actualización nocturna — ${changes.added} nuevos, ${changes.updated} actualizados`);
        return json({ok:true,...changes,total:data.deals.length,run_id:body.run.id},200,cors);
      } catch(e) { return json({error:String(e)},502,cors); }
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
            const allowed={RADAR:['EN_ANALISIS','DESCARTADO'],EN_ANALISIS:['RADAR','PARA_CONTACTAR','DESCARTADO'],PARA_CONTACTAR:['EN_NEGOCIACION','DESCARTADO'],EN_NEGOCIACION:['CIERRE','DESCARTADO'],CIERRE:['DESCARTADO'],DESCARTADO:['RADAR']};
            if(!allowed[old]?.includes(body.newStatus))return json({error:'Transición no permitida',allowed:allowed[old]},422,cors);
            deal.pipeline_status = body.newStatus;
            if(body.newStatus==='DESCARTADO'&&!String(body.discardReason||'').trim())return json({error:'Indica el motivo del descarte'},400,cors);
            if(body.newStatus!=='DESCARTADO')delete deal.discard_reason;
            if (body.discardReason) deal.discard_reason = String(body.discardReason).slice(0, 500);
            deal.events = deal.events || [];
            deal.events.push({ created_at: new Date().toISOString().slice(0, 10), description: `Movido ${old} → ${body.newStatus} (dashboard)` });
            changes.push(`${(deal.title || dealId).slice(0, 30)} → ${body.newStatus}`);
          }
          if (body.review) {
            const r=body.review;
            if (![0,1,2,3,4,5].includes(Number(r.rating)) || !['pendiente','mirar','finalista','no_encaja'].includes(r.decision)) return json({error:'evaluación inválida'},400,cors);
            deal.review={rating:Number(r.rating),decision:r.decision,automation_thesis:String(r.automation_thesis||'').slice(0,1500),next_action:String(r.next_action||'').slice(0,500),updated_at:new Date().toISOString(),author:String(body.author||'equipo').slice(0,50)};
            deal.events=deal.events||[];
            deal.events.push({created_at:deal.review.updated_at,description:`Evaluación del equipo: ${r.decision}, ${r.rating}/5`});
            changes.push(`evaluación en ${(deal.title||dealId).slice(0,30)}`);
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

      if(url.pathname==='/analyze-deal') {
        try {const {data,sha}=await getDealsFile(env);const d=data.deals.find(d=>d.id===body.dealId);if(!d)return json({error:'deal no encontrado'},404,cors);
          d.screening=screenDeal(d);d.preliminary_analysis={performed_at:new Date().toISOString(),model:'screen-v1',summary:`Score preliminar ${d.screening.score}/100. Cobertura ${d.screening.coverage}%. ${d.screening.disposition==='revalidate'?'Revalidar el anuncio antes de avanzar.':'Solicitar documentación para diligencia.'} No incluye auditoría ni verificación legal.`,questions:d.screening.questions};
          await putDealsFile(env,data,sha,'data: análisis preliminar — '+d.id);return json({ok:true,screening:d.screening,analysis:d.preliminary_analysis},200,cors);
        }catch(e){return json({error:String(e)},502,cors);}
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
          deal.events.push({ created_at: new Date().toISOString().slice(0, 10), description: 'Análisis profundo solicitado vía dashboard — pendiente de investigación manual, sin ejecución automática' });
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
