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

// Preliminary acquisition affinity uses public listing information only.
// Deep-dive evidence (tax/bank reconciliations, contracts, legal opinion) is separate.
export function screenDeal(d, now=new Date().toISOString()) {
  const ageDays=v=>v&&Number.isFinite(Date.parse(v))?Math.max(0,Math.floor((Date.parse(now)-Date.parse(v))/86400000)):null;
  const e=d.listing_evidence||{},m=d.operating_metrics||{},facts=d.public_facts||{};
  const checked=ageDays(e.checked_at),age=e.publication_source==='portal'?ageDays(e.published_at):null;
  const lastAttempt=d.revalidation||{};
  const newerUnconfirmed=['blocked','blocked_source','unavailable','identity_unresolved','not_found','sold','withdrawn'].includes(lastAttempt.status)&&Date.parse(lastAttempt.checked_at)>Date.parse(e.checked_at);
  const direct=d.source_url_kind==='listing'&&e.status==='published'&&checked!==null&&checked<=7&&!newerUnconfirmed&&(!e.source_url||e.source_url===d.source_url);
  const text=String(facts.description||d.raw_description||'').toLowerCase(),parts=[],flags=[],questions=[];
  if(!direct)flags.push('Disponibilidad no comprobada recientemente; revisar el intento de revalidación.');
  if(d.source_url_kind!=='listing')flags.push('El enlace de categoría no identifica una oportunidad concreta.');
  if(age!==null&&age>365)flags.push('Anuncio de más de un año, aún publicado según el portal; confirmar condiciones con el vendedor.');
  const inconsistent=/flowers bread route/i.test(d.title||'')&&/cleaning/i.test(JSON.stringify(d.financial||{}));
  if(d.revalidation?.status==='non_operating_asset')flags.push('Ficha de inmueble: falta identificar una empresa operativa incluida en la venta.');
  if(inconsistent)flags.push('Análisis histórico de otra actividad: no se utiliza para el score.');
  const use=(k)=>facts[k]??(d.source==='empire_flippers'?d[k]:null);
  const price=use('asking_price'),earnings=use('reported_sde')||use('reported_net_profit')||use('reported_cash_flow'),revenue=use('reported_revenue');
  const basis=use('reported_sde')?'SDE publicado':use('reported_net_profit')?'beneficio neto publicado':use('reported_cash_flow')?'flujo del broker (definición por confirmar)':null;
  const multiple=price>0&&earnings>0?price/earnings:null;
  const add=(name,weight,value,evidence,kind='publicado')=>parts.push({name,weight,value,points:value===null?null:Math.round(value*weight)/100,known:value!==null,evidence,kind});
  add('Precio frente a ganancias',40,multiple===null?null:multiple<=2?95:multiple<=3?85:multiple<=3.5?72:multiple<=4.5?55:multiple<=6?30:10,multiple===null?'Falta precio o ganancia anual publicada.':multiple.toFixed(2)+'× '+basis+'; sin deuda ni ajustes de diligencia.');
  const margin=earnings>0&&revenue>0?earnings/revenue:null;
  if(margin!==null&&margin>0.8)flags.push('Margen publicado excepcional: verificar definición, cifras y ajustes antes de contactar.');
  add('Margen publicado',15,margin===null?null:margin>1?0:margin>=.3?90:margin>=.2?80:margin>=.1?60:35,margin===null?'El anuncio no publica ambas cifras.':(margin*100).toFixed(1)+'% sobre ingresos; base '+basis+'.');
  const years=facts.years_operation??(m.first_made_money_at?ageDays(m.first_made_money_at)/365:null);
  add('Trayectoria operativa',10,years===null?null:years>=5?90:years>=3?75:years>=2?60:35,years===null?'Años de operación no publicados.':Math.floor(years)+' años de operación declarados.');
  const recurrence=/(?:recurring|subscription|monthly recurring|retainer|service contracts|repeat customers|membership)/.test(text)||m.mrr>0;
  add('Recurrencia declarada',10,recurrence?85:null,recurrence?'El anuncio declara ingresos repetidos, suscripción o contratos; se validarán en el deep dive.':'Recurrencia no descrita; no se interpreta como ausencia.');
  const hours=typeof m.hours_worked_per_week==='number'?m.hours_worked_per_week:null;
  const absentee=/(?:semi.absentee|absentee.owner|management (?:team|in place)|manager (?:in place|run)|owner works|3pl|documented (?:process|procedure)|virtual employee)/.test(text);
  add('Delegación y transferencia',10,hours!==null?(hours<=10?90:hours<=25?70:40):absentee?80:null,hours!==null?'Dueño: '+hours+' h/semana declaradas.':absentee?'Operación delegada o procesos documentados según el anuncio.':'Dedicación del dueño y equipo no descritos.');
  const industry=String(d.business_type||'').toLowerCase();
  const digital=/(saas|e.commerce|digital|agency|accounting|insurance)/.test(industry),service=/(hvac|plumbing|cleaning|landscap|restaurant|salon|med spa|home services|construction|repair|health)/.test(industry);
  add('Afinidad con IA y procesos',10,digital?85:service?75:null,digital?'Hipótesis sectorial: adquisición digital, soporte, reporting y operaciones. No es auditoría del negocio.':service?'Hipótesis sectorial: agenda, cotización, seguimiento y coordinación operativa. No es ahorro demostrado.':'Actividad insuficientemente clasificada para proponer un encaje.', 'hipótesis sectorial');
  const sellerFinance=facts.seller_financing===true||/(?:seller financ|owner financ|seller carry)/.test(text);
  add('Facilidad de estructuración',5,sellerFinance?85:null,sellerFinance?'Financiación del vendedor anunciada; términos y elegibilidad pendientes.':'Términos de financiación no publicados. No se presume elegibilidad SBA.');
  const known=parts.filter(p=>p.known),weight=known.reduce((s,p)=>s+p.weight,0);
  // A score requires public price and earnings. Never turn one optional signal into a 100.
  let score=multiple===null?null:Math.round(known.reduce((s,p)=>s+p.points,0)/weight*100);
  if(score!==null&&known.length<3)score=Math.min(score,69);
  const evidenceLevel=known.length>=5?'amplia':known.length>=3?'intermedia':'limitada';
  questions.push('Confirmar disponibilidad, motivo de venta y condiciones vigentes.','Solicitar el detalle que respalda la ganancia publicada y sus ajustes.','Validar concentración de clientes/canales, recurrencia y horas reales del dueño.','Medir una palanca de ventas y una tarea automatizable antes de proyectar retornos.','Antes de ofertar: conciliar cifras, deuda, capex, capital de trabajo, contratos y permisos.');
  return {version:'screen-v2',calculated_at:now,score,signals_available:known.length,signals_total:parts.length,evidence_level:evidenceLevel,confidence:evidenceLevel,coverage:null,disposition:direct&&!inconsistent&&d.revalidation?.status!=='non_operating_asset'?'eligible':'revalidate',listing_age_days:age,checked_age_days:checked,earnings_basis:basis,multiple:multiple===null?null:Math.round(multiple*100)/100,components:parts,flags,unknowns:parts.filter(p=>!p.known).map(p=>p.name),questions,explanation:'Afinidad preliminar sobre criterios públicos disponibles; pesos normalizados. No mide avance de diligencia ni probabilidad de éxito. Con menos de tres señales se limita a 69. Sin precio y ganancias no se calcula.'};
}

export async function auditDigitalOpportunity(d, fetcher=fetch) {
  const now=new Date().toISOString(),observations=[],sources=[],limits=[],candidates=[];
  const safe=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(u.hostname)&&!/(?:localhost|\.local|\.internal)$/i.test(u.hostname)&&!/^\d+(?:\.\d+)+$/.test(u.hostname)?u.href:null;}catch{return null;}};
  const read=async url=>{const r=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{Accept:'text/html,application/xml'}});if(!r.ok)throw new Error('HTTP '+r.status);const reader=r.body.getReader();let size=0,out='';const dec=new TextDecoder();try{while(size<250000){const {done,value}=await reader.read();if(done)break;size+=value.length;out+=dec.decode(value,{stream:true});}}finally{await reader.cancel();}return out;};
  let website=safe(d.website_url||d.digital_presence?.website||d.public_facts?.website_url||''),listing='';
  if(safe(d.source_url))try {listing=await read(d.source_url);sources.push({url:d.source_url,kind:'anuncio',checked_at:now});
    if(!website){const match=listing.match(/(?:business website|company website|website url)[\s\S]{0,100}?(https:\/\/[^\s"<>]+)/i);if(match)website=safe(match[1]);}
  }catch(e){limits.push('No se pudo leer el anuncio desde el motor: '+e.message);}
  if(!website){
    // Search results are candidates, never proof that a marketplace's confidential business owns that domain.
    const query=String(d.title||'').replace(/\$[\d.,]+[MK]?|per month/gi,'').slice(0,110)+' '+String(d.city||'')+' official business website';
    const keywords=(String(d.title||'')+' '+String(d.raw_description||'').slice(0,250)).toLowerCase().match(/[a-z]{5,}/g)||[];
    try {const searchUrl='https://www.bing.com/search?format=rss&q='+encodeURIComponent(query);const xml=await read(searchUrl);sources.push({url:searchUrl,kind:'búsqueda de identidad',checked_at:now});
      for(const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)){const link=item[1].match(/<link>(.*?)<\/link>/)?.[1],title=item[1].match(/<title>(.*?)<\/title>/)?.[1];if(safe(link)&&!/(bizbuysell|bizquest|empireflippers|dealledger|bing.com|facebook.com|linkedin.com|wikipedia.org|moneywiki)/i.test(link)&&new Set(keywords.filter(k=>String(title||'').toLowerCase().includes(k))).size>=2)candidates.push({title:String(title||'').replace(/<[^>]+>/g,'').slice(0,180),url:link});if(candidates.length>=3)break;}
    }catch(e){limits.push('Búsqueda de identidad no disponible: '+e.message);}
    limits.push('Web del negocio no identificada con evidencia suficiente. Esto no demuestra que no tenga web. La identidad puede ser confidencial.');
  }
  let audited=false;
  if(website)try {const body=await read(website);audited=true;sources.push({url:website,kind:'web del negocio',checked_at:now});
    const checks=[['Título de página',/<title>[^<]+<\/title>/i.test(body)],['Descripción para buscadores',/<meta[^>]+name=["']description["']/i.test(body)],['Configuración móvil',/<meta[^>]+name=["']viewport["']/i.test(body)],['Señal de reserva o cotización',/(book (?:now|online)|schedule|appointment|request (?:a )?quote|calendly|reserva|cotiza)/i.test(body)],['Formulario de contacto',/<form\b/i.test(body)],['Enlaces a redes sociales',/(instagram.com|facebook.com|linkedin.com)/i.test(body)],['Señal de reseñas',/(aggregateRating|reviewCount|testimonials|customer reviews)/i.test(body)]];
    for(const [name,found]of checks)observations.push({name,status:found?'detectada':'no detectada en la página leída',evidence_url:website});
    limits.push('Lectura de la página pública: no mide tráfico, conversiones, posición SEO, calidad de reseñas, velocidad ni funcionamiento de reservas.');
  }catch(e){limits.push('No se pudo auditar la web identificada: '+e.message);}
  const kind=String(d.business_type||'').toLowerCase(),online=/saas|digital|e.commerce|agency/.test(kind);
  const publicText=String(d.public_facts?.description||d.raw_description||'').toLowerCase();
  const recurring=/(subscription|subscribers|recurring|membership)/.test(publicText),outsourced=/(3pl|fulfillment|amazon fba)/.test(publicText);
  if(recurring)observations.push({name:'Recurrencia',status:'El anuncio menciona suscripciones o compras repetidas; falta medir retención y churn.',evidence_url:d.source_url});
  if(outsourced)observations.push({name:'Logística',status:'El anuncio describe logística externalizada; validar inventario, tarifas, stock y dependencia de plataforma.',evidence_url:d.source_url});
  const opportunities=[{area:'Ingresos',proposal:recurring?'Agente de retención de suscriptores: detectar riesgo de baja, recuperar pagos fallidos y probar reactivación o venta cruzada con consentimiento.':online?'Agente de seguimiento de leads, recuperación de carritos o reactivación de clientes, según el canal real.':'Agente de respuesta y agenda que dé seguimiento a llamadas, consultas y cotizaciones pendientes.',baseline:'Leads/mes, tasa de contacto, conversión y margen por venta.',pilot:'Comparar conversión y margen incremental frente a una línea base durante 30 días.'},{area:'Costos y gastos',proposal:outsourced?'Agente de inventario y conciliación entre tienda, 3PL y FBA: alertar quiebres, exceso de stock, devoluciones y diferencias; aprobar compras manualmente.':online?'Automatizar clasificación de soporte, reportes y conciliación operativa con revisión humana.':'Automatizar agenda, preparación de cotizaciones, recordatorios y coordinación de servicios con revisión humana.',baseline:'Horas por tarea, costo por hora, errores, retrabajo y costo de herramientas.',pilot:'Medir horas netas ahorradas y calidad; descontar implementación, supervisión y herramientas.'},{area:'Capacidad y control',proposal:'Agente de reporting de ventas, servicio y caja que detecte incidencias y derive excepciones al responsable.',baseline:'Volumen atendido, tiempos de respuesta, capacidad, margen y excepciones.',pilot:'Probar un proceso con registro auditable y límites de actuación antes de ampliarlo.'}].map(o=>({...o,status:'hipótesis de mejora; requiere validación con la empresa'}));
  return {version:'digital-v1',performed_at:now,status:audited?'web_observed':'identity_pending',website,website_candidates:candidates,observations,opportunities,sources,limitations:limits,financial_method:{incremental_profit:'Ventas adicionales × margen de contribución − costo comercial y herramientas.',net_savings:'Horas eliminadas × costo efectivo − implementación, herramientas, supervisión y retrabajo.',valuation:'Sin proyecciones de crecimiento, ahorro o múltiplo de salida hasta medir una línea base.'}};
}

export function applyAvailabilityObservation(data,d,row,now=new Date().toISOString()) {
  if(d.source_url_kind!=='listing'||d.source_url!==row.source_url)return false;
  const checked=new Date(row.checked_at),clock=new Date(now);
  if(!Number.isFinite(checked.getTime())||checked>clock||clock-checked>7*86400000)return false;
  const day=checked.toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
  let reason=null;
  if(['sold','withdrawn'].includes(row.status)&&row.availability_confirmed===true&&Array.isArray(row.status_evidence)&&row.status_evidence.some(e=>typeof e==='string'&&e.length>0)){
    reason=row.status==='sold'?'Vendido — confirmado en la ficha de origen':'Ya no está disponible — retirado en la ficha de origen';
  }
  if(row.status==='not_found'){
    const prior=d.retirement_checks||{};
    const count=prior.source_url===row.source_url?(prior.last_day===day?prior.count:(prior.count||0)+1):1;
    d.retirement_checks={source_url:row.source_url,last_day:day,count};
    if(count>=3)reason='Ya no está disponible en el enlace original — 404/410 en tres cortes diarios';
  }else if(row.status==='published')delete d.retirement_checks;
  else if(!['sold','withdrawn'].includes(row.status))delete d.retirement_checks;
  if(!reason||!['RADAR','EN_ANALISIS','PARA_CONTACTAR','EN_NEGOCIACION'].includes(d.pipeline_status))return false;
  const previous=d.pipeline_status;d.pipeline_status='DESCARTADO';d.discard_reason=reason;
  d.auto_discard={at:now,previous_status:previous,source_url:row.source_url,evidence:row.status_evidence||[],reason};
  d.events=d.events||[];d.events.push({created_at:now,event_type:'status_change',old_value:{status:previous},new_value:{status:'DESCARTADO',trigger:'auto',actor:'availability_monitor'},description:`Movido ${previous} → DESCARTADO: ${reason}`});
  if(data.manual_orders)for(const key of Object.keys(data.manual_orders))if(Array.isArray(data.manual_orders[key]))data.manual_orders[key]=data.manual_orders[key].filter(id=>id!==d.id);
  if(data.manual_orders&&Array.isArray(data.manual_orders.DESCARTADO))data.manual_orders.DESCARTADO.push(d.id);
  return true;
}

export function scoreAllDeals(data,now=new Date().toISOString()) {
  for(const d of data.deals)d.screening=screenDeal(d,now);
  data.screening_model={version:'screen-v2',updated_at:now,description:'Afinidad preliminar con información publicada; sin exigir documentos de debida diligencia.'};
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

    if(request.method==='POST'&&url.pathname==='/portal-sync') {
      if(!env.SOURCE_SYNC_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.SOURCE_SYNC_TOKEN}`)return json({error:'no autorizado'},401,cors);
      try {const body=await request.json();if(!Array.isArray(body.records)||body.records.length>250) return json({error:'lote inválido'},400,cors);
        const {data,sha}=await getDealsFile(env);let added=0,updated=0;const summary={};
        for(const row of body.records){if(!row.source_url||!/^https:\/\//.test(row.source_url)||!row.checked_at)throw new Error('evidencia inválida');
          let d=row.deal_id?data.deals.find(d=>d.id===row.deal_id):data.deals.find(d=>d.source_url?.replace(/\/$/,'')===row.source_url.replace(/\/$/,''));
          if(row.deal_id&&!d)throw new Error('identificador de ficha desconocido');
          if(d&&d.source_url.replace(/\/$/,'')!==row.source_url.replace(/\/$/,''))throw new Error('identidad de origen distinta');
          if(!d){if(!['published','email_alert'].includes(row.status)||!row.title)continue;const hostname=new URL(row.source_url).hostname;d={id:uuid(),source:hostname.includes('bizbuysell')?'bizbuysell':hostname.includes('bizquest')?'bizquest':hostname.replace(/^www\./,''),source_url:row.source_url,source_url_kind:'listing',title:String(row.title).slice(0,500),business_type:String(row.business_type||'Sin categoría').slice(0,100),state:String(row.state||'').slice(0,2),city:String(row.city||'').slice(0,100),pipeline_status:'RADAR',pending_analysis:true,notes:[],events:[],documents:[],reported_sde:null};data.deals.push(d);added++;}
          else updated++;
          if(row.status!=='email_alert'||!d.revalidation)d.revalidation={status:row.status,http_status:row.http_status??null,checked_at:row.checked_at,method:String(row.method||'lectura pública directa').slice(0,100),reason:String(row.reason||'').slice(0,600),content_hash:row.content_hash||null};
          summary[row.status]=(summary[row.status]||0)+1;
          if(row.status==='email_alert'){
            // Email is discovery evidence, never proof of current availability.
            // A fresh direct observation is not downgraded by an incoming alert.
            d.email_alert={received_at:row.checked_at,source_url:d.source_url,evidence:String(row.evidence||'Alerta oficial por correo; disponibilidad por confirmar.').slice(0,500)};
            if(!d.listing_evidence)d.listing_evidence={source_url:d.source_url,checked_at:row.checked_at,status:'email_alert',evidence:d.email_alert.evidence};
          }
          if(row.status==='published'){
            if(row.title&&!d.added_manually&&['bizbuysell','bizquest'].includes(d.source))d.title=String(row.title).slice(0,500);
            if(row.business_type&&row.business_type!=='Sin categoría'&&!d.added_manually)d.business_type=String(row.business_type).slice(0,100);
            d.listing_evidence={source_url:d.source_url,checked_at:row.checked_at,status:'published',evidence:String(row.evidence||'Ficha individual observada en el portal o broker. Cifras declaradas, no auditadas.').slice(0,500),publication_source:d.listing_evidence?.publication_source||null,published_at:d.listing_evidence?.published_at||null,publication_evidence:d.listing_evidence?.publication_evidence||null};
            const facts={...(d.public_facts||{}),observed_at:row.checked_at,source_url:d.source_url};
            for(const k of ['asking_price','reported_sde','reported_net_profit','reported_cash_flow','reported_revenue','years_operation'])if(row.fields?.[k]!=null){if(!Number.isFinite(row.fields[k])||row.fields[k]<0)throw new Error('importe o años inválidos');facts[k]=row.fields[k];if(k!=='years_operation')d[k]=row.fields[k];}
            if(row.fields?.seller_financing===true)facts.seller_financing=true;
            if(row.description)facts.description=String(row.description).slice(0,3000);
            d.public_facts=facts;
          }else if(['sold','withdrawn','not_found'].includes(row.status)){d.listing_evidence={...d.listing_evidence,source_url:d.source_url,checked_at:row.checked_at,status:row.status,evidence:['sold','withdrawn'].includes(row.status)?'La ficha identifica el negocio como retirado o vendido.':'La URL no está disponible (404/410); no prueba venta.'};}
          applyAvailabilityObservation(data,d,row);
        }
        scoreAllDeals(data);data.portal_refresh={checked_at:body.checked_at||new Date().toISOString(),added,updated,summary,sources:body.sources||[],coverage:'partial'};
        await putDealsFile(env,data,sha,'data: revalidación multifuente y ofertas públicas — '+added+' nuevas, '+updated+' comprobadas');return json({ok:true,added,updated,total:data.deals.length,summary},200,cors);
      }catch(e){return json({error:String(e)},502,cors);}
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
            website_url: clean.websiteUrl || null,
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
          d.screening=screenDeal(d);d.digital_analysis=await auditDigitalOpportunity(d);d.preliminary_analysis={performed_at:new Date().toISOString(),model:'screen-v2',summary:`Afinidad preliminar ${d.screening.score===null?'sin calcular':d.screening.score+'/100'}. ${d.screening.signals_available}/${d.screening.signals_total} señales públicas disponibles. ${d.screening.disposition==='revalidate'?'Revalidar el anuncio antes de avanzar.':'Solicitar documentación para diligencia.'} No incluye auditoría ni verificación legal.`,questions:d.screening.questions};
          await putDealsFile(env,data,sha,'data: análisis preliminar — '+d.id);return json({ok:true,screening:d.screening,analysis:d.preliminary_analysis,digital_analysis:d.digital_analysis},200,cors);
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
