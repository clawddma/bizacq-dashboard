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
  const sellerFinance=acquisitionSignals(d).seller_financing==='advertised';
  add('Facilidad de estructuración',5,sellerFinance?85:null,sellerFinance?'Financiación del vendedor anunciada; términos y elegibilidad pendientes.':'Términos de financiación no publicados. No se presume elegibilidad SBA.');
  const known=parts.filter(p=>p.known),weight=known.reduce((s,p)=>s+p.weight,0);
  // A score requires public price and earnings. Never turn one optional signal into a 100.
  let score=multiple===null?null:Math.round(known.reduce((s,p)=>s+p.points,0)/weight*100);
  if(revenue>0&&earnings>=revenue){score=null;flags.push('Ganancia igual o superior a ingresos: cifras inconsistentes; score suspendido hasta aclarar con el broker.');}
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

// Public acquisition signals: no inferred owner age, loan approval or seller terms.
export function acquisitionSignals(d) {
  const facts=d.public_facts||{},text=String(facts.description||d.raw_description||''),title=String(d.title||'');
  const primary=(title+' '+text).replace(/\s+/g,' ');
  const excerpt=pattern=>{const m=pattern.exec(primary);return m?primary.slice(Math.max(0,m.index-55),m.index+m[0].length+150).trim():null;};
  const reasonMatch=/(?:reason for (?:selling|sale)|motivo de venta)\s*:?\s*(.{1,240})/i.exec(primary);
  const reason=reasonMatch?.[1]?.split(/\s+(?:Business Description|Business Details|Detailed Information|Company Overview|Franchise Overview|Support|Contact|Description|Seller Financing|Price)\s*:|\.\s+/i)[0]?.trim()||null;
  const reasonText=reason||primary;
  const retiring=(reason?/\b(retirement|retiring|retire|jubilaci[oó]n)\b/i.test(reason):/\b(?:(?:owner|seller|founder|partner)s?[^.]{0,30}retir(?:e|ement|ing)|retir(?:e|ement|ing)[^.]{0,30}(?:owner|seller|founder)|retirement sale|retiro del (?:dueño|propietario))\b/i.test(primary))&&!/(?:not|no) (?:due to )?retirement|not (?:planning to )?retir/i.test(reasonText);
  const succession=/\b(?:no (?:family )?successor|without (?:a )?successor|lack of succession|no succession plan|children (?:are )?not interested|sin sucesor)\b/i.test(primary);
  const financeNegative=/(?:no|without|not (?:offering|available))\s+(?:seller|owner) financ|(?:seller|owner) financ(?:ing)?\s*:\s*(?:no|not available)|(?:seller|owner) (?:will not|won't) financ/i.test(primary);
  const financeMention=/\b(?:seller|owner) financ(?:ing|e)?\b|seller carry|seller (?:will|can|may) (?:carry|finance)/i.test(primary);
  const seller=financeNegative?'not_offered':financeMention||facts.seller_financing===true?'advertised':'unknown';
  const pctMatch=/(?:seller|owner)\s+(?:financ(?:ing|e)?|(?:will|can|may) (?:carry|finance)|carry)\s*(?::|[-–]|of|for|up to|available(?:\s+(?:at|for))?)?\s*(?:up to\s+)?(\d{1,2}(?:\.\d+)?|100)\s*%|\b(\d{1,2}(?:\.\d+)?|100)\s*%\s*(?:seller|owner) financ/i.exec(primary);
  let sellerPercent=seller==='advertised'&&pctMatch?Number(pctMatch[1]||pctMatch[2]):null;
  if(sellerPercent===null&&seller==='advertised'&&Number.isFinite(facts.seller_financing_percent)&&facts.seller_financing_percent>=0&&facts.seller_financing_percent<=100)sellerPercent=facts.seller_financing_percent;
  const sellerEvidence=excerpt(/\b(?:seller|owner) financ(?:ing|e)?\b|seller carry|seller (?:will|can|may) (?:carry|finance)/i);
  const sbaEvidence=excerpt(/\bSBA(?:\s+7\(?a\)?)?\s+(?:pre[- ]?(?:approved|qualified)|eligible|approved|available|financ\w*)|(?:eligible|qualif\w*|pre[- ]?approved)\s+(?:for\s+)?SBA\b/i);
  const sba=!!sbaEvidence&&!/(?:not|no|without)\s+(?:eligible for\s+)?SBA|SBA\s*(?:eligible|financing)?\s*:\s*no/i.test(primary);
  const price=facts.asking_price??(d.source==='empire_flippers'?d.asking_price:null);
  const earnings=facts.reported_sde??facts.reported_net_profit??facts.reported_cash_flow??(d.source==='empire_flippers'?d.reported_net_profit:null);
  const revenue=facts.reported_revenue??(d.source==='empire_flippers'?d.reported_revenue:null);
  const conflict=revenue>0&&earnings>=revenue;
  const financials=price>0&&earnings>0&&!conflict;
  const termsLabel=seller==='not_offered'?'No ofrecida según el anuncio':seller==='unknown'?'No informada':sellerPercent!==null?sellerPercent+'% anunciado · sujeto a condiciones':'Anunciada · porcentaje no publicado';
  return {version:'prospect-v1',retirement:retiring,succession_gap:succession,reason_for_sale:reason,retirement_evidence:retiring||succession?excerpt(/retirement|retiring|retire|no (?:family )?successor|without (?:a )?successor|lack of succession|no succession plan|children (?:are )?not interested|sin sucesor/i):null,seller_financing:seller,seller_percent:sellerPercent,seller_label:termsLabel,seller_evidence:sellerEvidence,sba_advertised:sba,sba_evidence:sba?sbaEvidence:null,financials_usable:financials,financial_conflict:conflict,source_url:d.source_url,questions:[...(retiring||succession?['¿Qué funciones y relaciones dependen del dueño y cuántos meses acompañaría la transición?']:[]),...(seller==='advertised'?['Confirmar porcentaje, tasa, plazo, garantías, subordinación y condiciones del pagaré del vendedor.']:[]),'Validar caja, concentración de clientes, capital de trabajo y capex antes de estructurar la compra.']};
}

export function scoreAllDeals(data,now=new Date().toISOString()) {
  for(const d of data.deals){d.screening=screenDeal(d,now);d.prospecting=acquisitionSignals(d);}
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

    if(request.method==='GET'&&url.pathname==='/investment-report') {
      try {const {data}=await getDealsFile(env);const r=(data.investment_reports||[]).find(x=>x.id===url.searchParams.get('id'));if(!r)return json({error:'Informe no encontrado'},404,cors);
        const d=data.deals.find(x=>x.id===r.deal_id);const headers={...cors,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors https://bizacq-radar.danielmesar959464.chatgpt.site http://127.0.0.1:8789; base-uri 'none'; form-action 'none'"};
        if(url.searchParams.get('download')==='1')headers['Content-Disposition']='attachment; filename="BizAcq-informe-'+r.id+'.html"';return new Response(renderInvestmentReport(r,d),{headers});
      }catch(e){return json({error:String(e)},502,cors);}
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
          if(!d){if(!['published','email_alert'].includes(row.status)||!row.title)continue;const hostname=new URL(row.source_url).hostname;d={id:uuid(),source:hostname.includes('bizbuysell')?'bizbuysell':hostname.includes('bizquest')?'bizquest':hostname.replace(/^www\./,''),source_url:row.source_url,source_url_kind:'listing',title:String(row.title).slice(0,500),business_type:String(row.business_type||'Sin categoría').slice(0,100),state:String(row.state||'').slice(0,2),city:String(row.city||'').slice(0,100),pipeline_status:'RADAR',pending_analysis:true,created_at:row.checked_at,source_imported_at:row.checked_at,notes:[],events:[{created_at:row.checked_at,description:'Nueva oferta pública incorporada al Radar.'}],documents:[],reported_sde:null};data.deals.push(d);added++;}
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
            if(row.source_category&&!d.added_manually)d.category_evidence={source_label:String(row.source_category).slice(0,300),method:String(row.category_method||'categoría del portal').slice(0,200),checked_at:row.checked_at};
            d.listing_evidence={source_url:d.source_url,checked_at:row.checked_at,status:'published',evidence:String(row.evidence||'Ficha individual observada en el portal o broker. Cifras declaradas, no auditadas.').slice(0,500),publication_source:d.listing_evidence?.publication_source||null,published_at:d.listing_evidence?.published_at||null,publication_evidence:d.listing_evidence?.publication_evidence||null};
            if(row.publication_evidence&&/^\d{4}-\d{2}-\d{2}$/.test(row.published_at||'')&&Number.isFinite(Date.parse(row.published_at))&&Date.parse(row.published_at)<=Date.now())Object.assign(d.listing_evidence,{publication_source:'portal',published_at:row.published_at,publication_evidence:String(row.publication_evidence).slice(0,300)});
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
        try {const initial=await getDealsFile(env);const original=initial.data.deals.find(d=>d.id===body.dealId);if(!original)return json({error:'deal no encontrado'},404,cors);
          const signature=reportSignature(original);const digital=await auditDigitalOpportunity(original);
          // Read after external research: concurrent notes and stage decisions are preserved.
          const {data,sha}=await getDealsFile(env);const d=data.deals.find(x=>x.id===body.dealId);if(!d)return json({error:'deal no encontrado'},404,cors);
          if(reportSignature(d)!==signature)return json({error:'La fuente cambió durante el análisis. Reintentar con los datos nuevos.'},409,cors);
          d.screening=screenDeal(d);d.prospecting=acquisitionSignals(d);d.digital_analysis=digital;d.preliminary_analysis={performed_at:new Date().toISOString(),model:'screen-v2',summary:`Afinidad preliminar ${d.screening.score===null?'sin calcular':d.screening.score+'/100'}. Información pública y escenarios; cifras pendientes de diligencia.`,questions:d.screening.questions};
          const report=saveInvestmentReport(data,d);
          await putDealsFile(env,data,sha,'data: informe de inversión — '+d.id);return json({ok:true,screening:d.screening,analysis:d.preliminary_analysis,digital_analysis:d.digital_analysis,report},200,cors);
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

// Reports are immutable public-source snapshots; CRM notes and decisions are never copied.
export function reportFacts(d) {
  const f=d.public_facts||{},from=k=>f[k]??(d.source==='empire_flippers'?d[k]:null);
  const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
  const income=[['reported_sde','SDE declarado'],['reported_net_profit','Beneficio neto declarado'],['reported_cash_flow','Flujo del broker']].find(([k])=>finite(from(k))!==null);
  const price=finite(from('asking_price')),revenue=finite(from('reported_revenue')),earnings=income?finite(from(income[0])):null;
  return {price,revenue,earnings,basis:income?.[1]||'Ganancia no publicada',sde:finite(from('reported_sde')),net_profit:finite(from('reported_net_profit')),cash_flow:finite(from('reported_cash_flow')),ebitda:finite(from('reported_ebitda')),years:finite(f.years_operation),multiple:price>0&&earnings>0?price/earnings:null,margin:revenue>0&&earnings!==null?earnings/revenue*100:null,conflict:revenue>0&&earnings>=revenue};
}
export function reportSignature(d) {
  return JSON.stringify([d.title,d.state,d.city,d.business_type,d.source_url,reportFacts(d),d.public_facts?.description||d.raw_description||'',d.listing_evidence?.status||null,d.digital_analysis?.website||null,(d.digital_analysis?.observations||[]).map(x=>[x.name,x.status])]);
}
export function reportSector(kind) {
 const k=String(kind||'').toLowerCase();
 if(/manufactur|machine|fabricat/.test(k))return {name:'Manufactura',naics:'31–33',attraction:'La especialización técnica y las relaciones B2B pueden favorecer pedidos repetidos. Validar barreras de entrada, certificaciones y costos de cambio.',risks:['Concentración por cliente y dependencia de un técnico o programador clave.','Capex de mantenimiento, estado de máquinas, scrap y capital inmovilizado en inventario.'],indicators:['Utilización de máquinas y horas vendibles','Scrap y retrabajo / ventas','Entrega a tiempo, cartera y días de inventario'],pilots:['Agente de cotizaciones que prepare costos y plazos desde órdenes históricas, con aprobación del responsable.','Conciliación de inventario, órdenes y compras; seguimiento de mantenimiento y desviaciones.']};
 if(/saas|digital|technology|e.commerce|agency/.test(k))return {name:'Tecnología y canales digitales',naics:'Por validar según actividad',attraction:'Suscripciones, clientes repetidos y distribución digital pueden facilitar experimentos medibles de adquisición y retención. Confirmar recurrencia y propiedad de los activos.',risks:['Dependencia de plataforma, tráfico pagado, clientes o código del fundador.','Churn, devoluciones, seguridad, propiedad intelectual y concentración de canales.'],indicators:['Retención y churn por cohorte','Margen de contribución tras publicidad y devoluciones','Costo de adquisición, recuperación del costo y concentración por canal'],pilots:['Agente de seguimiento comercial, recuperación de pagos y retención con grupos de control.','Clasificación de soporte, conciliación de ventas e inventario y reporting con trazabilidad.']};
 if(/health|medical|dental|veterin|med spa/.test(k))return {name:'Salud y servicios clínicos',naics:'62 · confirmar subindustria',attraction:'Continuidad de atención y relaciones locales pueden sostener demanda recurrente. Validar mezcla de pagadores, licencias y dependencia clínica antes de asumir transferibilidad.',risks:['Licencias profesionales, reglas de propiedad de clínicas y permanencia del profesional.','Cartera, glosas, concentración de pagadores, privacidad y responsabilidad clínica.'],indicators:['Ocupación y ausencias de agenda','Ingreso cobrado por servicio y días de cartera','Concentración por profesional y pagador'],pilots:['Seguimiento administrativo de agenda, recordatorios y reactivación con consentimiento.','Conciliación de cobros y cartera; clasificación de documentos con revisión humana y controles de privacidad.']};
 if(/construction|hvac|plumb|electrical|roof|repair|landscap|clean|home service/.test(k))return {name:'Servicios técnicos y construcción',naics:'23 o 81 · confirmar actividad',attraction:'Demanda local, mantenimiento y contratos de servicio pueden favorecer compras repetidas. Validar recurrencia efectiva, densidad de rutas y disponibilidad de técnicos.',risks:['Dependencia del dueño para cotizar, vender o mantener la licencia.','Estacionalidad, garantías, backlog no vinculante y contratación de personal.'],indicators:['Conversión de cotizaciones y ticket medio','Horas facturadas / horas disponibles','Margen por trabajo, repetición y costo de adquisición'],pilots:['Agente de respuesta, agenda y seguimiento de cotizaciones para reducir leads sin atender.','Preparación de presupuestos, coordinación de técnicos y revisión del margen por trabajo.']};
 if(/transport|route|logistic|distribut|wholesale/.test(k))return {name:'Distribución y logística',naics:'42 o 48–49 · confirmar actividad',attraction:'Carteras recurrentes y densidad de distribución pueden crear economías operativas. Confirmar contratos transferibles y margen por cliente o ruta.',risks:['Concentración en proveedor, cliente, concesión o contrato de ruta.','Inventario, combustible, flota, siniestros y capital de trabajo.'],indicators:['Margen por cliente, pedido y ruta','Pedidos por parada y utilización de flota','Rotación de inventario, cartera y entrega completa'],pilots:['Agente de reposición y recuperación de clientes inactivos con aprobación de pedidos.','Conciliación de rutas, inventario, facturas y entregas; detección de excepciones.']};
 return {name:String(kind||'Actividad por confirmar'),naics:'Por validar',attraction:'La tesis depende de demanda repetida, capacidad de transferir la operación y margen después de reemplazar al dueño. Estas condiciones requieren evidencia específica del negocio.',risks:['Dependencia del dueño, de clientes clave y de permisos o contratos.','Diferencias entre utilidad declarada y efectivo disponible después de reinversión.'],indicators:['Retención y concentración de clientes','Margen por producto o servicio','Horas del dueño, productividad y conversión comercial'],pilots:['Seguimiento comercial y reactivación de clientes con consentimiento y medición de conversión.','Automatización administrativa y reporting de caja con revisión de excepciones.']};
}
export function reportTax(state) {
 const contexts={
 FL:['Florida: referencia de impuesto corporativo de 5,5% para ejercicios iniciados desde 2022. La aplicación depende de la entidad, base imponible y ajustes; no es una tasa efectiva del negocio.','https://floridarevenue.com/taxes/taxesfees/Pages/corporate.aspx'],
 TX:['Texas aplica franchise tax a entidades sujetas. Para el reporte 2026, el umbral no tax due es USD 2.650.000 de ingresos anualizados totales; revisar grupo combinado y obligaciones informativas. No equivale a impuesto total cero.','https://comptroller.texas.gov/forms/05-915.pdf'],
 CA:['California: referencia general de 8,84% para C corporations distintas de bancos y financieras. Otras entidades tienen reglas diferentes; revisar mínimos, nexus y gravámenes locales.','https://www.ftb.ca.gov/file/business/tax-rates.html'],
 WV:['West Virginia: referencia de impuesto corporativo de 6,5%. Confirmar entidad, base imponible, deducciones y obligaciones estatales y locales.','https://tax.wv.gov/business/corporateincometax/pages/corporateincometax.aspx']};
 const x=contexts[state];return {state:state||'No informado',summary:x?.[0]||'La tasa aplicable aún no está verificada para este estado y tipo de entidad. Revisar la autoridad fiscal estatal antes de presupuestar el cierre o el flujo después de impuestos.',url:x?.[1]||'https://www.irs.gov/businesses/small-businesses-self-employed/state-government-websites',reviewed_at:x?'2026-10-16':null};
}
export function reportScenario(f,s={}) {
 const n=(k,def)=>s[k]===undefined?def:Number(s[k]);
 const v={sellerPct:n('sellerPct',0),bankPct:n('bankPct',0),sellerRate:n('sellerRate',8),bankRate:n('bankRate',10),sellerYears:n('sellerYears',5),bankYears:n('bankYears',10),targetCoverage:n('targetCoverage',1.5),manager:n('manager',0),capex:n('capex',0),working:n('working',0),tax:n('tax',0),existingDebt:n('existingDebt',0),closing:n('closing',0),initialWorking:n('initialWorking',0),uplift:n('uplift',0),contribution:n('contribution',0),savings:n('savings',0),tech:n('tech',0)};
 const valid=Object.values(v).every(x=>Number.isFinite(x)&&x>=0)&&v.sellerPct+v.bankPct<=100&&v.sellerRate<=100&&v.bankRate<=100&&v.sellerYears>=1&&v.sellerYears<=40&&v.bankYears>=1&&v.bankYears<=40&&v.targetCoverage>=1&&v.targetCoverage<=5&&v.uplift<=100&&v.contribution<=100;
 if(!valid)return {valid:false};
 const pmt=(p,r,y)=>{const i=r/1200,t=y*12;return i===0?p/t:p*i/(1-Math.pow(1+i,-t));};
 const income=f.earnings!==null&&!f.conflict?f.earnings:null,adjustments=v.manager+v.capex+v.working+v.tax;
 const available=income===null?null:income-adjustments,seller=f.price===null?null:f.price*v.sellerPct/100,bank=f.price===null?null:f.price*v.bankPct/100;
 const sellerAnnual=seller===null?null:pmt(seller,v.sellerRate,v.sellerYears)*12,bankAnnual=bank===null?null:pmt(bank,v.bankRate,v.bankYears)*12;
 const budget=available===null?null:Math.max(0,available/v.targetCoverage-v.existingDebt-(sellerAnnual||0));
 const debtCapacity=budget===null?null:budget/(pmt(1,v.bankRate,v.bankYears)*12);
 const totalDebt=bankAnnual===null?null:bankAnnual+sellerAnnual+v.existingDebt,annualCash=available===null||totalDebt===null?null:available-totalDebt;
 const equity=f.price===null?null:f.price-seller-bank+v.closing+v.initialWorking;
 const stress=income===null?null:income*.8-adjustments;
 const ai=f.revenue===null?null:f.revenue*v.uplift/100*v.contribution/100+v.savings-v.tech;
 return {valid:true,values:v,available,seller,bank,totalDebt,debtCapacity,equity,annualCash,monthlyCash:annualCash===null?null:annualCash/12,coverage:totalDebt>0&&available!==null?available/totalDebt:null,stressCoverage:totalDebt>0&&stress!==null?stress/totalDebt:null,cashOnCash:equity>0&&annualCash!==null?100*annualCash/equity:null,payback:annualCash>0&&equity>0?equity/annualCash:null,aiBenefit:ai};
}
export function buildInvestmentReport(d,data,now=new Date().toISOString()) {
 const f=reportFacts(d),p=acquisitionSignals(d),sector=reportSector(d.business_type);
 const peers=(data.deals||[]).filter(x=>x.id!==d.id&&x.business_type===d.business_type&&x.screening?.disposition==='eligible'&&!['CIERRE','DESCARTADO'].includes(x.pipeline_status)).map(reportFacts).filter(x=>x.basis===f.basis&&!x.conflict&&x.multiple!==null);
 const median=arr=>{const a=arr.sort((x,y)=>x-y),n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;};
 const margins=peers.map(x=>x.margin).filter(x=>x!==null);
 return {id:uuid(),deal_id:d.id,version:1,generated_at:now,title:d.title,industry:d.business_type||'Sin categoría',state:d.state||'',city:d.city||'',stage_at_generation:d.pipeline_status,source_url:d.source_url,source_checked_at:d.listing_evidence?.checked_at||null,published_at:d.listing_evidence?.published_at||null,source_signature:reportSignature(d),description:String(d.public_facts?.description||d.raw_description||'El anuncio no describe la operación.').slice(0,2800),financials:f,score:d.screening?.score??null,flags:d.screening?.flags||[],availability:d.screening?.disposition||'revalidate',prospecting:p,sector,tax:reportTax(d.state),peers:{count:peers.length,basis:f.basis,median_multiple:peers.length>=5?median(peers.map(x=>x.multiple)):null,margin_count:margins.length,median_margin:margins.length>=5?median(margins):null},digital:d.digital_analysis?{status:d.digital_analysis.status,website:d.digital_analysis.website,observations:d.digital_analysis.observations||[],opportunities:d.digital_analysis.opportunities||[],limitations:d.digital_analysis.limitations||[],sources:d.digital_analysis.sources||[]}:null,sources:[{title:'Anuncio del negocio',url:d.source_url,as_of:d.listing_evidence?.checked_at||null},{title:'Contexto fiscal estatal',url:reportTax(d.state).url,as_of:reportTax(d.state).reviewed_at},{title:'BLS · indicadores por industria',url:'https://www.bls.gov/iag/',as_of:null},{title:'SBA · propiedad, ciudadanía y residencia',url:'https://legacy.sba.gov/document/procedural-notice-5000-876626-revised-applicant-ownership-citizenship-residency-requirements-7a-504-loans',as_of:'2026-10-16'},{title:'IRS · asignación del precio en compras de activos',url:'https://www.irs.gov/instructions/i8594',as_of:'2026-10-16'}]};
}
export function saveInvestmentReport(data,d,now=new Date().toISOString()) {
 data.investment_reports=data.investment_reports||[];
 const signature=reportSignature(d),existing=[...data.investment_reports].reverse().find(r=>r.deal_id===d.id&&r.source_signature===signature&&r.availability===(d.screening?.disposition||'revalidate'));
 if(existing)return existing;
 const report=buildInvestmentReport(d,data,now);report.version=1+data.investment_reports.filter(r=>r.deal_id===d.id).length;data.investment_reports.push(report);return report;
}
export function renderInvestmentReport(r,current=null) {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const url=v=>{try{const u=new URL(v);return u.protocol==='https:'?u.href:'#';}catch{return '#';}};
 const money=v=>v===null||v===undefined?'No publicado':new Intl.NumberFormat('es-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v);
 const num=(v,suffix='')=>v===null||v===undefined?'No calculable':Number(v).toFixed(2)+suffix;
 const list=items=>'<ul>'+items.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>';
 const f=r.financials,p=r.prospecting,sector=r.sector;
 const changed=current&&(reportSignature(current)!==r.source_signature||current.screening?.disposition!==r.availability);
 const rows=[['Precio solicitado',f.price],['Ingresos declarados',f.revenue],['SDE declarado',f.sde],['Beneficio neto declarado',f.net_profit],['Flujo del broker',f.cash_flow],['EBITDA publicado',f.ebitda]].map(([label,v])=>`<tr><td>${label}</td><td>${money(v)}</td><td>Declaración del anuncio</td></tr>`).join('');
 const sections=['Tesis','Compañía','Industria','Financials','Compra y deuda','Small business','Taxes','IA y tecnología','Diligencia','Fuentes'];
 const scriptData=JSON.stringify(f).replace(/</g,'\\u003c');
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tesis de inversión · ${esc(r.title)}</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#eef2f1;color:#173329;font:15px/1.65 system-ui,-apple-system,sans-serif}a{color:#22594c;overflow-wrap:anywhere}h1{font-size:clamp(27px,4vw,44px);line-height:1.16;letter-spacing:-1px}h2{font-size:24px;line-height:1.3;margin:0 0 18px}h3{font-size:17px}p{margin:10px 0}.shell{max-width:1240px;margin:auto;display:grid;grid-template-columns:180px minmax(0,1fr);gap:28px;padding:28px}aside{position:sticky;top:20px;align-self:start}aside a{display:block;padding:8px;text-decoration:none;font-size:13px}main{min-width:0}header{background:#0d2e28;color:#fff;padding:32px;border-radius:12px}header a{color:#9de4d4}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:2px}.muted{color:#607d76;font-size:13px}.tag{display:inline-block;padding:4px 9px;background:#e6eeea;border-radius:20px;font-size:11px;color:#224f40;margin:3px}section{background:#fafaf9;border:1px solid #dfe6e2;border-radius:12px;padding:28px;margin:22px 0;scroll-margin-top:16px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.kpi{border-left:3px solid #2dc5ab;padding:8px 14px}.kpi strong{font-size:25px;display:block}.callout{padding:15px;background:#e6eeea;border-radius:8px}.warn{background:#fff0d9;color:#6b480e;padding:14px;border-radius:8px}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:12px 8px;border-bottom:1px solid #dde5e0;text-align:left;vertical-align:top}th{background:#e6eeea}ul{padding-left:20px}li{margin:8px 0}label{display:block;font-size:12px;color:#4c695d}input{width:100%;min-width:0;padding:9px;margin-top:4px;border:1px solid #bdcec4;border-radius:6px;background:white;font-size:16px;color:#173329}button,.button{cursor:pointer;border:1px solid #aac2b6;padding:9px 12px;border-radius:7px;background:#fafaf9;color:#173329;font:inherit;font-size:13px;text-decoration:none;display:inline-block}summary{cursor:pointer;font-weight:600}details{margin:16px 0}.source{font-size:12px;border-top:1px solid #dbe5df;padding-top:10px;overflow-wrap:anywhere}.description{white-space:pre-wrap;overflow-wrap:anywhere}.footer{font-size:12px;color:#607d76;margin:30px 0}.screen-only{display:block}
@media(max-width:760px){.shell{display:block;padding:12px}aside{position:static;display:flex;gap:6px;overflow-x:auto;margin-bottom:14px}aside a{white-space:nowrap}header,section{padding:20px}.grid{grid-template-columns:1fr}h2{font-size:22px}td,th{padding:9px 5px}.kpi strong{font-size:23px}}@media print{body{background:white;font-size:11px}.shell{display:block;padding:0}aside,.screen-only{display:none}header{background:white;color:#173329;border-bottom:3px solid #173329}header a{color:#173329}section{break-inside:auto;border:0;border-top:1px solid #ccc;padding:20px 0;margin:12px 0}.kpi,table tr{break-inside:avoid}details>div{display:block!important}input{border:0;padding:0}.grid{grid-template-columns:1fr 1fr}a{color:inherit}h2,h3{break-after:avoid}}
</style></head><body><div class="shell"><aside aria-label="Índice del informe">${sections.map((s,i)=>`<a href="#s${i}">${String(i+1).padStart(2,'0')} · ${s}</a>`).join('')}</aside><main>
<header><span class="eyebrow">BizAcq · Memorando de inversión</span><h1>${esc(r.title)}</h1><p>${esc(r.industry)} · ${esc([r.city,r.state,'Estados Unidos'].filter(Boolean).join(', '))}</p><p>Versión ${r.version} · ${esc(r.generated_at.slice(0,10))} · Información pública preliminar</p><a href="${url(r.source_url)}" target="_blank" rel="noopener">Anuncio original ↗</a><div class="screen-only" style="margin-top:16px"><button onclick="window.print()">Imprimir / guardar PDF</button></div></header>
${changed?'<p class="warn">El inventario tiene información posterior. Este informe conserva su fotografía original; generar una nueva versión desde la oportunidad.</p>':''}
${current&&['DESCARTADO','CIERRE'].includes(current.pipeline_status)?`<p class="warn">Estado actual de la oportunidad: ${esc(current.pipeline_status)}. El informe es histórico.</p>`:''}
<section id="s0"><span class="eyebrow">01 · Decisión preliminar</span><h2>${r.availability!=='eligible'?'Revalidar la oportunidad antes de avanzar':f.conflict?'Aclarar las cifras antes de valorar':f.price>0&&f.earnings>0?'Investigar con condiciones verificables':'Completar las cifras para valorar'}</h2><div class="grid"><div class="kpi">Precio solicitado<strong>${money(f.price)}</strong></div><div class="kpi">${esc(f.basis)}<strong>${money(f.earnings)}</strong></div><div class="kpi">Precio / ganancia declarada<strong>${num(f.multiple,'×')}</strong></div><div class="kpi">Afinidad preliminar<strong>${r.score===null?'Sin score':esc(r.score)+' / 100'}</strong></div></div><p><strong>Lectura de los números:</strong> ${f.price>0&&f.earnings>0?'El precio de '+money(f.price)+' equivale a '+num(f.multiple)+' años de '+esc(f.basis.toLowerCase())+' de '+money(f.earnings)+'.':'Faltan precio o ganancias para contrastar la valoración.'} ${f.margin!==null?'La ganancia anunciada representa '+num(f.margin,'%')+' de los ingresos.':''} ${r.peers.median_multiple!==null?'La mediana de los '+r.peers.count+' anuncios comparables es '+num(r.peers.median_multiple,'×')+'.':'La muestra comparable no alcanza para afirmar un múltiplo de mercado.'}</p><p>La tesis consiste en comprar una operación transferible y mejorar ventas o productividad mediante procesos y tecnología. El precio solo se sostiene si la ganancia se convierte en caja después de reemplazar al dueño y reinvertir.</p><p class="callout">${p.retirement?'El anuncio declara retiro: investigar el acompañamiento del dueño y la continuidad comercial. ':'Motivo de retiro no confirmado. '}${esc(p.seller_label)}. Son señales de negociación, no compromisos.</p>${list(r.flags)}<p class="muted">El score prioriza investigación; no mide probabilidad de éxito ni sustituye valoración o diligencia.</p></section>
<section id="s1"><span class="eyebrow">02 · La compañía</span><h2>Qué se compra y dónde opera</h2><p><strong>Actividad:</strong> ${esc(r.industry)} · <strong>Ubicación anunciada:</strong> ${esc([r.city,r.state].filter(Boolean).join(', ')||'No informada')} · <strong>Trayectoria:</strong> ${f.years===null?'No publicada':esc(f.years)+' años declarados'}</p><p>La identidad legal, domicilio operativo y perímetro de activos deben confirmarse. El título comercial del anuncio puede mantener confidencial el nombre de la empresa.</p><details><summary>Descripción publicada · texto de la fuente</summary><div class="description">${esc(r.description)}</div></details><p><strong>Motivo de venta:</strong> ${esc(p.reason_for_sale|| (p.retirement?'Retiro mencionado en el anuncio; detalle por confirmar.':'No publicado.'))}</p><p><strong>Sucesión:</strong> ${p.succession_gap?'Falta de sucesor declarada.':'No se ha acreditado falta de sucesor.'}</p></section>
<section id="s2"><span class="eyebrow">03 · Industria y mercado</span><h2>${esc(sector.name)}</h2><p>${esc(sector.attraction)}</p><p class="muted">Tesis sectorial para validar; clasificación NAICS orientativa: ${esc(sector.naics)}.</p><h3>Indicadores que deben gobernar la compra</h3>${list(sector.indicators)}<h3>Comparables del Radar</h3><p>${r.peers.count} anuncios de la misma categoría y base de ganancias, activos al construir el informe. Se excluyen cifras contradictorias y etapas terminales.</p><div class="grid"><div class="kpi">Mediana de precio / ganancias<strong>${num(r.peers.median_multiple,'×')}</strong></div><div class="kpi">Mediana de margen declarado<strong>${num(r.peers.median_margin,'%')}</strong></div></div><p class="muted">Muestra de anuncios, no de transacciones ni benchmark representativo de toda la industria. Se exige un mínimo de cinco observaciones para publicar cada mediana. Margen con ${r.peers.margin_count} observaciones; fecha ${esc(r.generated_at.slice(0,10))}.</p><p><a href="https://www.bls.gov/iag/" target="_blank" rel="noopener">BLS · empleo, salarios y actividad por industria ↗</a>. Crecimiento sectorial, tamaño de mercado y múltiplos de ventas cerradas: pendientes de una fuente comparable en fecha, geografía y actividad.</p>${list(sector.risks)}</section>
<section id="s3"><span class="eyebrow">04 · Financials</span><h2>Cifras publicadas y calidad de caja</h2><div class="table"><table><thead><tr><th>Indicador</th><th>USD</th><th>Base</th></tr></thead><tbody>${rows}</tbody></table></div><p><strong>Margen sobre ingresos:</strong> ${num(f.margin,'%')} · base ${esc(f.basis)}. SDE, beneficio neto, EBITDA y flujo del broker no son equivalentes. Periodicidad y ajustes por confirmar.</p>${f.conflict?'<p class="warn">Ganancia igual o superior a ingresos: contradicción pendiente. El simulador suspende la capacidad de deuda basada en esas cifras.</p>':''}<h3>Puente pendiente entre ganancia y caja</h3>${list(['Conciliar 24–36 meses de P&G con declaraciones fiscales, bancos y cobros.','Desglosar costos directos, nómina, gastos, remuneración del dueño y add-backs documentados.','Separar capex de mantenimiento, variaciones de capital de trabajo, impuestos y deuda existente.','Pedir balance, deuda, cartera, inventario y contingencias; el anuncio no acredita estos saldos.'])}</section>
<section id="s4"><span class="eyebrow">05 · Estructura de compra</span><h2>Deuda, efectivo y retorno del escenario</h2><p>Simulador con cuotas mensuales amortizables y pago constante. Las tasas y plazos iniciales son referencias de cálculo, no cotizaciones. Los ajustes en cero son supuestos visibles, no gastos reales conocidos. Los cambios del simulador no modifican el informe guardado; imprimir conserva los valores de esta vista.</p><p class="warn">Capacidad calculada = techo matemático sobre ${esc(f.basis)} después de los ajustes ingresados. Falta demostrar caja disponible para deuda, garantías, comprador y condiciones del prestamista. No representa una aprobación.</p><div id="scenario"><h3>Fuentes de financiación · % del precio</h3><div class="grid">${[['sellerPct','Vendedor (%)',0],['bankPct','Banco convencional (%)',0],['sellerRate','Tasa vendedor (% anual)',8],['bankRate','Tasa banco (% anual)',10],['sellerYears','Plazo vendedor (años)',5],['bankYears','Plazo banco (años)',10],['targetCoverage','Cobertura objetivo de deuda (veces)',1.5],['closing','Costos iniciales de cierre (USD)',0],['initialWorking','Capital de trabajo inicial (USD)',0]].map(([k,l,v])=>`<label>${l}<input data-scenario="${k}" aria-label="${l}" type="number" min="0" step="any" value="${v}"></label>`).join('')}</div><p><strong>Lo anunciado por el vendedor:</strong> ${esc(p.seller_label)}.</p><h3>Ajustes anuales de caja · supuestos en USD</h3><p class="muted">Ingresar únicamente ajustes no incluidos ya en la cifra de partida para evitar descontarlos dos veces.</p><div class="grid">${[['manager','Reemplazo del dueño / año',0],['capex','Capex de mantenimiento / año',0],['working','Incremento de capital de trabajo / año',0],['tax','Impuestos pagados / año',0],['existingDebt','Servicio de deuda existente / año',0]].map(([k,l,v])=>`<label>${l}<input data-scenario="${k}" aria-label="${l}" type="number" min="0" step="any" value="${v}"></label>`).join('')}</div><p id="scenarioError" class="warn" hidden>Revisar valores: financiación total hasta 100%, tasas hasta 100%, plazos de 1 a 40 años y cobertura de 1 a 5 veces.</p><div class="table"><table><tbody>${[['equity','Efectivo inicial del escenario'],['totalDebt','Servicio anual de toda la deuda'],['debtCapacity','Techo calculado para deuda bancaria'],['coverage','Cobertura de toda la deuda (veces)'],['monthlyCash','Flujo mensual después de deuda'],['cashOnCash','Flujo anual / efectivo aportado (%)'],['payback','Recuperación simple (años)'],['stressCoverage','Cobertura con ganancia −20% (veces)']].map(([k,l])=>`<tr><td>${l}</td><td data-result="${k}">Completar escenario</td></tr>`).join('')}</tbody></table></div><p class="muted">Recuperación simple sin valor terminal ni descuento. El estrés reduce la ganancia de partida 20% y mantiene ajustes y deuda; no es un pronóstico de ventas. La capacidad bancaria descuenta servicio de deuda existente y del vendedor.</p></div></section>
<section id="s5"><span class="eyebrow">06 · Small business</span><h2>Financiación y comprador elegible</h2><p>El programa SBA ofrece garantías a prestamistas para empresas elegibles; no financia automáticamente una adquisición por ser pequeña. El anuncio ${p.sba_advertised?'menciona SBA; esa etiqueta no acredita aprobación':'no publica una aprobación SBA'}.</p><p class="warn">La política SBA efectiva desde marzo de 2026 restringe 7(a) y 504 por ciudadanía y propiedad. La estructura de compradores extranjeros debe revisarse antes de incorporar SBA. Este escenario utiliza únicamente banco convencional y vendedor.</p>${list(['Confirmar ciudadanía, propiedad directa e indirecta, residencia, capacidad de operación y garantías del comprador.','Verificar tamaño SBA por NAICS, actividad permitida, uso de fondos y requisitos del prestamista.','Si SBA no aplica, contrastar banco convencional, pagaré del vendedor y capital propio sin presuponer porcentajes aprobados.','Separar permiso de operar o trabajar de la propiedad del negocio; evaluación migratoria independiente.'])}<a href="${url(r.sources[3].url)}" target="_blank" rel="noopener">SBA · reglas oficiales ↗</a></section>
<section id="s6"><span class="eyebrow">07 · Taxes</span><h2>Impuestos y estructura de la operación · ${esc(r.state||'estado pendiente')}</h2><p>${esc(r.tax.summary)}</p><p class="muted">${r.tax.reviewed_at?'Referencia consultada el '+esc(r.tax.reviewed_at)+'.':'Tasa específica pendiente.'} Tasas normativas no equivalen a tasa efectiva. No se aplican automáticamente a SDE ni al flujo del broker.</p>${list(['Definir compra de activos o participaciones, entidad adquirente y asignación del precio.','Revisar sales/use tax, nómina, propiedad, franchise/gross receipts, nexus multiestado e impuestos locales.','Confirmar pasivos fiscales heredados, certificados de cumplimiento y obligaciones de retención.','En compras de activos cubiertas por §1060, coordinar la asignación del precio y la presentación del Form 8594 entre comprador y vendedor.'])}<p><a href="${url(r.tax.url)}" target="_blank" rel="noopener">Fuente fiscal estatal ↗</a> · <a href="https://www.irs.gov/instructions/i8594" target="_blank" rel="noopener">IRS · Form 8594 ↗</a></p><p>El cálculo de impuestos de la operación requiere entidad, bases fiscales, nexus y perímetro del acuerdo. El simulador acepta un importe anual explícito, sin asumir ahorro fiscal.</p></section>
<section id="s7"><span class="eyebrow">08 · Creación de valor</span><h2>IA, automatización y tecnología</h2><p>Hipótesis adaptadas a ${esc(sector.name)}; los resultados deben medirse en la operación.</p>${list(sector.pilots)}<h3>Ingresos</h3><p>Medir leads, tasa de contacto, conversión, ticket, recompra y margen incremental. La mejora solo cuenta si produce contribución después de publicidad, devoluciones y costos variables.</p><h3>Costos y gastos</h3><p>Medir horas, costo por hora, errores, retrabajo y capacidad. Distinguir reducción efectiva de desembolsos de tiempo liberado; descontar implementación, herramientas y supervisión.</p>${r.digital?`<details><summary>Auditoría digital observada · ${esc(r.digital.status)}</summary><div>${list(r.digital.observations.map(o=>o.name+': '+o.status))}${list(r.digital.limitations)}</div></details>`:'<p class="muted">Web e identidad digital pendientes de identificación suficiente.</p>'}<h3>Experimento de 90 días</h3>${list(['Días 1–30: medir línea base, documentar proceso y seleccionar un flujo con dueño responsable.','Días 31–60: piloto acotado, revisión humana y comparación con un grupo o período de control.','Días 61–90: ampliar solo si mejora contribución o caja neta y se conserva calidad, privacidad y continuidad.'])}<details><summary>Cuantificar una hipótesis · sin proyección automática</summary><div class="grid">${[['uplift','Aumento de ingresos (%)',0],['contribution','Margen de contribución incremental (%)',0],['savings','Ahorro efectivo anual (USD)',0],['tech','Implementación y operación anual (USD)',0]].map(([k,l,v])=>`<label>${l}<input data-scenario="${k}" aria-label="${l}" type="number" min="0" step="any" value="${v}"></label>`).join('')}</div><p>Contribución adicional antes de impuestos: <strong data-result="aiBenefit">Sin escenario</strong>. No representa un ahorro demostrado.</p></details></section>
<section id="s8"><span class="eyebrow">09 · Diligencia y decisión</span><h2>Qué debe demostrarse para avanzar</h2>${list([...p.questions,'Conseguir P&G, balance, impuestos y bancos; conciliación de calidad de ganancias.','Revisar contratos, change-of-control, licencias, litigios, seguros y obligaciones laborales.','Validar concentración, cartera comercial, clientes perdidos, pipeline y transferencia de relaciones.','Acordar acompañamiento del dueño, retención de personal y condiciones del pagaré.'])}<p class="callout">Próxima decisión: seleccionar documentación y condiciones para investigar. Cambiar de etapa en el pipeline requiere una decisión del equipo; generar este informe conserva las etapas y notas.</p></section>
<section id="s9"><span class="eyebrow">10 · Trazabilidad</span><h2>Fuentes, límites y fecha de corte</h2><p>Anuncio comprobado: ${esc(r.source_checked_at||'Sin comprobación reciente')} · publicación original: ${esc(r.published_at||'No informada')}. Generado: ${esc(r.generated_at)}.</p>${r.sources.map(s=>`<p class="source"><a href="${url(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a><br>${esc(s.as_of?'Referencia: '+s.as_of:'Recurso de consulta; no se ha extraído una serie estadística.')}</p>`).join('')}<p>El informe conserva una fotografía de datos publicados y cálculos reproducibles. La existencia del anuncio no acredita disponibilidad para negociar; confirmar directamente con el broker. No incorpora notas privadas del CRM ni presume verificación de balances, impuestos o identidad legal.</p></section><footer class="footer">BizAcq Intelligence · Análisis de adquisición para socios · USD · versión ${r.version}</footer>
</main></div><script>const __name=(fn)=>fn;const facts=${scriptData};const calculate=${reportScenario.toString()};function refresh(){const s={};document.querySelectorAll('[data-scenario]').forEach(e=>s[e.dataset.scenario]=e.value);const r=calculate(facts,s);document.getElementById('scenarioError').hidden=r.valid;document.querySelectorAll('[data-result]').forEach(e=>{let k=e.dataset.result,v=r[k];e.textContent=!r.valid?'Escenario inválido':v===null||v===undefined?'No calculable':k==='coverage'||k==='stressCoverage'?v.toFixed(2)+'×':k==='payback'?v.toFixed(1)+' años':k==='cashOnCash'?v.toFixed(1)+'%':new Intl.NumberFormat('es-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v)});}document.querySelectorAll('[data-scenario]').forEach(e=>e.addEventListener('input',refresh));refresh();</script></body></html>`;
}
