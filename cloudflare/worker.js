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
export function reportEnglishSector(kind) {
 const k=String(kind||'').toLowerCase();
 if(/manufactur|machine|fabricat/.test(k))return {name:'Manufacturing',attraction:'Technical specialization and B2B relationships can support repeat orders. Validate barriers to entry, certifications and switching costs.',risks:['Customer concentration and reliance on a key technician or programmer.','Maintenance capex, machine condition, scrap and cash tied up in inventory.'],indicators:['Machine utilization and billable production hours','Scrap and rework / revenue','On-time delivery, receivables and inventory days'],pilots:['A quoting assistant that prepares costs and lead times from historical orders, subject to management approval.','Reconcile inventory, orders and purchases; monitor maintenance and exceptions.']};
 if(/saas|digital|technology|e.commerce|agency/.test(k))return {name:'Technology & digital channels',attraction:'Subscriptions, repeat customers and digital distribution can support measurable acquisition and retention experiments. Validate recurring revenue and ownership of the assets.',risks:['Platform, paid-traffic, customer or founder-code dependency.','Churn, returns, security, intellectual property and channel concentration.'],indicators:['Cohort retention and churn','Contribution margin after advertising and returns','Acquisition cost, payback and channel concentration'],pilots:['Lead follow-up, payment recovery and retention agents tested against a control group.','Support triage, sales and inventory reconciliation, and traceable reporting.']};
 if(/health|medical|dental|veterin|med spa/.test(k))return {name:'Healthcare & clinical services',attraction:'Continuity of care and local relationships can support recurring demand. Validate payer mix, licenses and clinical dependency before assuming transferability.',risks:['Professional licensing, clinical ownership rules and practitioner retention.','Receivables, payer concentration, privacy and clinical liability.'],indicators:['Appointment utilization and no-shows','Cash collected per service and receivable days','Practitioner and payer concentration'],pilots:['Administrative scheduling, reminders and patient reactivation with consent.','Collections reconciliation and document classification with human review and privacy controls.']};
 if(/construction|hvac|plumb|electrical|roof|repair|landscap|clean|home service/.test(k))return {name:'Technical services & construction',attraction:'Local demand, maintenance and service contracts can support repeat purchases. Validate actual recurrence, route density and technician availability.',risks:['Owner dependency in estimating, selling or holding the operating license.','Seasonality, warranties, non-binding backlog and hiring constraints.'],indicators:['Quote conversion and average order value','Billed hours / available hours','Job margin, repeat business and acquisition cost'],pilots:['Response, scheduling and quote follow-up agents to reduce unserved leads.','Estimate preparation, technician coordination and job-margin monitoring.']};
 if(/transport|route|logistic|distribut|wholesale/.test(k))return {name:'Distribution & logistics',attraction:'Recurring accounts and distribution density can create operating efficiencies. Validate transferable contracts and margins by account or route.',risks:['Supplier, customer, concession or route-contract concentration.','Inventory, fuel, fleet, claims and working capital requirements.'],indicators:['Margin by account, order and route','Orders per stop and fleet utilization','Inventory turns, receivable days and delivery completeness'],pilots:['Replenishment and dormant-account follow-up with human order approval.','Route, inventory, invoice and delivery reconciliation with exception detection.']};
 return {name:String(kind||'Business activity to confirm'),attraction:'The thesis depends on repeat demand, operational transferability and margins after replacing the owner. These conditions require company-specific evidence.',risks:['Owner and key-customer dependency, licenses and contracts.','Gaps between reported earnings and cash after reinvestment.'],indicators:['Customer retention and concentration','Margin by product or service','Owner hours, productivity and sales conversion'],pilots:['Consent-based sales follow-up and customer reactivation measured against a baseline.','Administrative automation and cash reporting with human exception review.']};
}
export function renderInvestmentReport(r,current=null) {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const safe=v=>{try{const u=new URL(v);return u.protocol==='https:'?u.href:'#';}catch{return '#';}};
 const money=v=>v===null||v===undefined?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v);
 const number=(v,s='')=>v===null||v===undefined?'—':Number(v).toFixed(2)+s;
 const f=r.financials,p=r.prospecting;
 const changed=current&&(reportSignature(current)!==r.source_signature||current.screening?.disposition!==r.availability);
 const basisEN={'SDE declarado':'Reported SDE','Beneficio neto declarado':'Reported net profit','Flujo del broker':'Broker-reported cash flow','Ganancia no publicada':'Earnings not disclosed'};
 const flagEN={
 'Disponibilidad no comprobada recientemente; revisar el intento de revalidación.':'Availability has not been verified recently. Review the latest validation attempt.',
 'El enlace de categoría no identifica una oportunidad concreta.':'The category link does not identify an individual acquisition opportunity.',
 'Anuncio de más de un año, aún publicado según el portal; confirmar condiciones con el vendedor.':'The listing is over one year old and still published. Confirm current terms with the seller.',
 'Ficha de inmueble: falta identificar una empresa operativa incluida en la venta.':'Real-estate listing: an operating business included in the sale has not been identified.',
 'Análisis histórico de otra actividad: no se utiliza para el score.':'Historical analysis describes a different business activity and is excluded from scoring.',
 'Margen publicado excepcional: verificar definición, cifras y ajustes antes de contactar.':'Unusually high reported margin: verify definitions, figures and adjustments.',
 'Ganancia igual o superior a ingresos: cifras inconsistentes; score suspendido hasta aclarar con el broker.':'Reported earnings equal or exceed revenue. Scoring is suspended pending clarification.'};
 const taxEN={FL:'Florida: the reference corporate income tax rate is 5.5% for tax years beginning in 2022 or later. Application depends on entity type, taxable income and adjustments; this is not the company’s effective rate.',TX:'Texas imposes franchise tax on taxable entities. The 2026 report no-tax-due threshold is USD 2,650,000 in annualized total revenue. Review combined groups and information filings; this does not mean all taxes are zero.',CA:'California: the general reference rate is 8.84% for C corporations other than banks and financial institutions. Other entity types follow different rules; review minimum taxes, nexus and local charges.',WV:'West Virginia: the reference corporate income tax rate is 6.5%. Confirm entity type, taxable income, deductions and state and local obligations.'};
 function view(lang) {
  const t=(es,en)=>lang==='es'?es:en,sector=lang==='es'?r.sector:reportEnglishSector(r.industry),basis=lang==='es'?f.basis:(basisEN[f.basis]||'Reported earnings');
  const list=a=>'<ul>'+a.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>';
  const seller=p.seller_financing==='not_offered'?t('No ofrecida según el anuncio','Not offered according to the listing'):p.seller_financing==='advertised'?(p.seller_percent!==null?t(p.seller_percent+'% anunciado · sujeto a condiciones',p.seller_percent+'% advertised · subject to terms'):t('Anunciada · porcentaje no publicado','Advertised · percentage not disclosed')):t('No informada','Not disclosed');
  const headings=t(['Tesis','Compañía','Industria','Financials','Compra y deuda','Small business','Impuestos','IA y tecnología','Diligencia','Fuentes'],['Investment thesis','Company','Industry','Financials','Acquisition & debt','Small business','Tax context','AI & technology','Due diligence','Sources']);
  const section=(i,k,title,body)=>`<section id="${lang}-s${i}" aria-labelledby="${lang}-h${i}"><div class="section-heading"><span class="section-number">${String(i+1).padStart(2,'0')}</span><div><p class="eyebrow">${k}</p><h2 id="${lang}-h${i}">${title}</h2></div></div>${body}</section>`;
  const cite=(i)=>`<a class="cite" href="#${lang}-source-${i}" aria-label="${t('Fuente','Source')} ${i}">[${i}]</a>`;
  const input=(k,label,v)=>`<label>${label}<input data-scenario="${k}" aria-label="${label}" inputmode="decimal" type="number" min="0" step="any" value="${v}"></label>`;
  const chart=(a,b,title,suffix,caption)=>{
   const values=[a,b].filter(x=>x!==null&&Number.isFinite(x));if(!values.length||f.conflict)return `<p class="note">${t('Gráfico suspendido: cifras insuficientes o contradictorias.','Chart withheld: insufficient or contradictory figures.')}</p>`;
   const scale=Math.max(...values,1)*1.12;
   return `<figure class="exhibit"><figcaption><span class="eyebrow">${t('Exposición','Exhibit')} 01</span><h3>${title}</h3></figcaption>${[[t('Esta compañía','This company'),a,'company'],[t('Mediana del Radar','Radar median'),b,'peer']].map(([l,v,c])=>`<div class="bar-label"><span>${l}</span><strong>${number(v,suffix)}</strong></div><div class="bar-track"><div class="bar ${c}" style="width:${v===null?0:Math.max(0,v)/scale*100}%"></div></div>`).join('')}<div class="axis"><span>0${suffix}</span><span>${number(scale,suffix)}</span></div><p class="source-note">${caption}</p></figure>`;
  };
  let decision=r.availability!=='eligible'?t('Revalidar antes de avanzar','Revalidate before proceeding'):f.conflict?t('Aclarar las cifras antes de valorar','Clarify the numbers before valuation'):f.price>0&&f.earnings>0?t('Investigar con condiciones verificables','Investigate against verifiable conditions'):t('Completar las cifras para valorar','Complete the financial picture');
  const financialRows=[[t('Precio solicitado','Asking price'),f.price],[t('Ingresos declarados','Reported revenue'),f.revenue],[t('SDE declarado','Reported SDE'),f.sde],[t('Beneficio neto declarado','Reported net profit'),f.net_profit],[t('Flujo del broker','Broker-reported cash flow'),f.cash_flow],[t('EBITDA publicado','Reported EBITDA'),f.ebitda]];
  let s0=`<p class="decision">${decision}</p><div class="headline-metrics">${[[t('Precio solicitado','Asking price'),money(f.price)],[esc(basis),money(f.earnings)],[t('Precio / ganancias','Price / earnings'),number(f.multiple,'×')],[t('Afinidad preliminar','Preliminary fit'),r.score===null?'—':r.score+' / 100']].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><p class="lead">${f.price>0&&f.earnings>0?t('El precio equivale a '+number(f.multiple)+' años de la ganancia declarada. La compra se sostiene solo si esa ganancia se convierte en caja después de reemplazar al dueño y reinvertir.','The asking price represents '+number(f.multiple)+' years of reported earnings. The acquisition works only if those earnings convert into cash after owner replacement and reinvestment.'):t('La información pública todavía no permite contrastar precio y ganancias. La siguiente decisión es obtener las cifras faltantes.','Public information is not yet sufficient to compare price and earnings. The next decision is to obtain the missing figures.')}</p><div class="thesis-note"><p class="eyebrow">${t('Señal de negociación','Negotiation signal')}</p><p>${p.retirement?t('Retiro declarado: validar transición y continuidad comercial.','Retirement is stated: validate transition support and commercial continuity.'):t('Retiro no confirmado.','Retirement is not confirmed.')} ${esc(seller)}.</p></div>${r.flags.length?`<div class="risk-note"><h3>${t('Puntos que condicionan la tesis','Conditions to resolve')}</h3>${list(r.flags.map(x=>lang==='es'?x:flagEN[x]||'Source note (original language): '+x))}</div>`:''}<p class="note">${t('El score organiza la investigación; no es una valoración ni una probabilidad de éxito.','The score prioritizes research; it is neither a valuation nor a probability of success.')}</p>`;
  let s1=`<div class="fact-table"><table><tbody><tr><th>${t('Actividad anunciada','Listed activity')}</th><td>${esc(r.industry)}</td></tr><tr><th>${t('Ubicación anunciada','Listed location')}</th><td>${esc([r.city,r.state,t('Estados Unidos','United States')].filter(Boolean).join(', '))}</td></tr><tr><th>${t('Trayectoria declarada','Stated operating history')}</th><td>${f.years===null?t('No publicada','Not disclosed'):f.years+t(' años',' years')}</td></tr><tr><th>${t('Sucesión','Succession')}</th><td>${p.succession_gap?t('Falta de sucesor declarada','Absence of a successor is stated'):t('Falta de sucesor no acreditada','Absence of a successor is not established')}</td></tr></tbody></table></div><p>${t('El nombre legal, domicilio operativo y perímetro de activos requieren confirmación. El título del anuncio puede mantener confidencial la identidad del negocio.','Legal name, operating address and the perimeter of assets require confirmation. The listing title may keep the company’s identity confidential.')} ${cite(1)}</p>${p.reason_for_sale?`<blockquote><span>${t('Motivo de venta · cita original','Reason for sale · original quotation')}</span>${esc(p.reason_for_sale)}</blockquote>`:''}<details><summary>${t('Descripción del anuncio · idioma original','Listing description · original language')}</summary><div class="description">${esc(r.description)}</div></details>`;
  let s2=`<p class="lead">${esc(sector.attraction)}</p><p class="note">${t('Hipótesis sectorial por validar. NAICS orientativo:','Sector hypothesis to validate. Indicative NAICS:')} ${esc(r.sector.naics)}.</p><h3>${t('Indicadores para evaluar la industria','Industry evaluation indicators')}</h3>${list(sector.indicators)}${chart(f.multiple,r.peers.median_multiple,t('Precio pedido frente a ganancias declaradas','Asking price relative to reported earnings'),'×',t('Fuente: fotografía del Radar al '+r.generated_at.slice(0,10)+'. '+r.peers.count+' anuncios comparables; misma categoría y base de ganancia.','Source: Radar snapshot on '+r.generated_at.slice(0,10)+'. '+r.peers.count+' comparable listings; same category and earnings basis.'))}<p class="note">${t('Son anuncios, no transacciones cerradas ni una muestra representativa de toda la industria. Se exigen cinco observaciones para mostrar cada mediana. Margen: '+r.peers.margin_count+' observaciones.','These are listings, not closed transactions or a representative industry sample. Five observations are required to display each median. Margin sample: '+r.peers.margin_count+' observations.')}</p><h3>${t('Riesgos de la actividad','Industry-specific risks')}</h3>${list(sector.risks)}<p>${t('El crecimiento, tamaño de mercado y múltiplos de operaciones cerradas requieren fuentes comparables en actividad, fecha y geografía. BLS es el recurso oficial para contrastar empleo, salarios y actividad.','Growth, market size and closed-transaction multiples require sources matched by activity, date and geography. BLS is the official resource for employment, wages and industry activity.')} ${cite(3)}</p>`;
  let s3=`<figure class="exhibit"><figcaption><span class="eyebrow">${t('Exposición','Exhibit')} 02</span><h3>${t('Financials del anuncio','Listing financials')}</h3></figcaption><div class="table"><table><thead><tr><th>${t('Indicador','Metric')}</th><th class="numeric">USD</th><th>${t('Evidencia','Evidence')}</th></tr></thead><tbody>${financialRows.map(([label,v])=>`<tr><td>${label}</td><td class="numeric">${money(v)}</td><td class="note">${v===null?t('No publicado','Not disclosed'):t('Declaración del anunciante','Listing statement')}</td></tr>`).join('')}</tbody></table></div><p class="source-note">${t('Fuente: anuncio original. Periodicidad y ajustes por confirmar.','Source: original listing. Reporting period and adjustments require confirmation.')} ${cite(1)}</p></figure><div class="inline-metric"><span>${t('Margen sobre ingresos · '+basis,'Reported margin · '+basis)}</span><strong>${number(f.margin,'%')}</strong></div><p>${t('SDE, beneficio neto, EBITDA y flujo del broker no son equivalentes. La cifra declarada no acredita caja disponible para deuda.','SDE, net profit, EBITDA and broker-reported cash flow are not interchangeable. Reported earnings do not establish cash available for debt service.')}</p>${f.conflict?`<p class="risk-note">${t('Ganancia igual o superior a ingresos: cálculo de deuda suspendido hasta aclarar la contradicción.','Earnings equal or exceed revenue: debt-capacity calculations are suspended pending clarification.')}</p>`:''}<h3>${t('Puente entre ganancia y caja','Bridge from earnings to cash')}</h3>${list(t(['Conciliar 24–36 meses de P&G con declaraciones fiscales, bancos y cobros.','Desglosar costos, nómina, remuneración del dueño y add-backs documentados.','Separar mantenimiento, capital de trabajo, impuestos, deuda y contingencias.'],['Reconcile 24–36 months of P&L with tax returns, bank statements and collections.','Separate costs, payroll, owner compensation and documented add-backs.','Identify maintenance capex, working capital, taxes, debt and contingencies.']))}`;
  let s4=`<p class="lead">${t('Una estructura de compra debe dejar caja suficiente después de operar, reinvertir y pagar toda la deuda.','An acquisition structure must retain enough cash after operations, reinvestment and all debt service.')}</p><p class="note">${t('Cuotas mensuales amortizables. Tasas y plazos son supuestos de cálculo, no cotizaciones. Los ajustes en cero no son gastos conocidos. Los cambios son locales; el enlace comparte el informe guardado.','Monthly amortizing payments. Rates and terms are calculation assumptions, not quotes. Zero adjustments are not known expenses. Changes are local; the link shares the saved report.')}</p><div class="scenario-panel"><h3>${t('Fuentes de financiación','Funding sources')}</h3><figure class="funding-figure"><figcaption>${t('Composición del precio · escenario','Purchase-price funding · scenario')}</figcaption><div class="funding-bar" aria-hidden="true"><i data-funding="equity"></i><i data-funding="seller"></i><i data-funding="bank"></i></div><div class="funding-legend"><span><i class="equity-key"></i>${t('Capital propio','Buyer equity')}</span><span><i class="seller-key"></i>${t('Vendedor','Seller')}</span><span><i class="bank-key"></i>${t('Banco','Bank')}</span></div></figure><div class="input-grid">${[['sellerPct',t('Vendedor (%)','Seller (%)'),0],['bankPct',t('Banco convencional (%)','Conventional bank (%)'),0],['sellerRate',t('Tasa vendedor (% anual)','Seller interest (% annually)'),8],['bankRate',t('Tasa banco (% anual)','Bank interest (% annually)'),10],['sellerYears',t('Plazo vendedor (años)','Seller term (years)'),5],['bankYears',t('Plazo banco (años)','Bank term (years)'),10],['targetCoverage',t('Cobertura objetivo (veces)','Target debt coverage (times)'),1.5],['closing',t('Costos de cierre (USD)','Closing costs (USD)'),0],['initialWorking',t('Capital de trabajo inicial (USD)','Initial working capital (USD)'),0]].map(x=>input(...x)).join('')}</div><p class="source-note">${t('Lo anunciado por el vendedor:','Seller’s advertised terms:')} ${esc(seller)}. ${cite(1)}</p><details><summary>${t('Ajustes anuales de caja · supuestos en USD','Annual cash adjustments · assumptions in USD')}</summary><p class="note">${t('Incluir únicamente ajustes no descontados ya de la ganancia de partida.','Include only adjustments not already deducted from the starting earnings figure.')}</p><div class="input-grid">${[['manager',t('Reemplazo del dueño / año','Owner replacement / year'),0],['capex',t('Capex de mantenimiento / año','Maintenance capex / year'),0],['working',t('Incremento de capital de trabajo / año','Working-capital increase / year'),0],['tax',t('Impuestos pagados / año','Cash taxes / year'),0],['existingDebt',t('Servicio de deuda existente / año','Existing debt service / year'),0]].map(x=>input(...x)).join('')}</div></details><p data-error class="risk-note" role="status" hidden>${t('Escenario inválido. Revisar importes, financiación total hasta 100%, tasas hasta 100%, plazos de 1 a 40 años y cobertura de 1 a 5 veces.','Invalid scenario. Check amounts, total funding up to 100%, rates up to 100%, terms from 1 to 40 years and coverage from 1 to 5 times.')}</p><div class="table"><table><thead><tr><th>${t('Resultado del escenario','Scenario output')}</th><th class="numeric">${t('Valor','Value')}</th></tr></thead><tbody>${[['equity',t('Efectivo inicial','Initial buyer cash')],['totalDebt',t('Servicio anual de toda la deuda','Total annual debt service')],['debtCapacity',t('Techo calculado para deuda bancaria','Calculated bank-debt ceiling')],['coverage',t('Cobertura de toda la deuda','Total debt-service coverage')],['monthlyCash',t('Flujo mensual después de deuda','Monthly cash after debt service')],['cashOnCash',t('Flujo anual / efectivo aportado','Annual cash / buyer cash')],['payback',t('Recuperación simple','Simple payback')],['stressCoverage',t('Cobertura con ganancia −20%','Coverage with earnings −20%')]].map(([k,label])=>`<tr><td>${label}</td><td class="numeric" data-result="${k}">—</td></tr>`).join('')}</tbody></table></div></div><p class="risk-note">${t('La capacidad es un techo matemático sobre la ganancia publicada después de los ajustes; no es aprobación de crédito. Faltan caja conciliada, garantías, comprador y condiciones del prestamista.','Capacity is a mathematical ceiling using reported earnings after adjustments, not credit approval. Reconciled cash flow, collateral, buyer eligibility and lender terms remain unverified.')}</p><p class="note">${t('El estrés reduce la ganancia de partida 20% manteniendo ajustes y deuda. La capacidad bancaria descuenta servicio existente y del vendedor. Recuperación simple sin valor terminal ni descuento.','The stress case reduces starting earnings by 20% while holding adjustments and debt constant. Bank capacity deducts existing and seller debt service. Simple payback excludes terminal value and discounting.')}</p>`;
  let s5=`<p class="lead">${p.sba_advertised?t('El anuncio menciona financiación SBA. La etiqueta no acredita aprobación del comprador.','The listing mentions SBA financing. That label does not establish buyer approval.'):t('El anuncio no publica una aprobación SBA.','The listing does not disclose an SBA approval.')}</p><p>${t('La agencia estadounidense Small Business Administration garantiza créditos de prestamistas para empresas elegibles. La política efectiva desde marzo de 2026 restringe 7(a) y 504 por ciudadanía y propiedad; revisar la estructura de compradores extranjeros antes de incorporar SBA.','The U.S. Small Business Administration guarantees lender loans for eligible businesses. Policy effective from March 2026 restricts 7(a) and 504 eligibility based on citizenship and ownership. Review any foreign-buyer structure before assuming SBA financing.')} ${cite(4)}</p>${list(t(['Confirmar ciudadanía y propiedad directa e indirecta, garantías y capacidad de operar.','Verificar tamaño por NAICS, actividad permitida, uso de fondos y requisitos del prestamista.','Si SBA no aplica, contrastar banco convencional, pagaré del vendedor y capital propio.','Separar propiedad del negocio de permiso migratorio para operar o trabajar.'],['Confirm citizenship, direct and indirect ownership, guarantees and operating capacity.','Check NAICS size standards, eligible activity, use of proceeds and lender requirements.','If SBA is unavailable, compare conventional lending, seller notes and buyer equity.','Separate business ownership from immigration permission to operate or work.']))}<p class="note">${t('El simulador utiliza banco convencional y vendedor; no presupone crédito SBA.','The simulator uses conventional bank and seller financing; it does not assume an SBA loan.')}</p>`;
  let s6=`<p class="lead">${esc(lang==='es'?r.tax.summary:(taxEN[r.state]||'A state-specific rate has not been verified for this entity type. Consult the state tax authority before estimating transaction costs or after-tax cash flow.'))} ${cite(2)}</p><p class="note">${r.tax.reviewed_at?t('Referencia consultada el ','Reference reviewed on ')+esc(r.tax.reviewed_at):t('Tasa específica pendiente.','Specific tax rate pending.')} ${t('Las tasas normativas no son tasas efectivas y no se aplican automáticamente a SDE o flujo del broker.','Statutory rates are not effective rates and must not be applied automatically to SDE or broker cash flow.')}</p>${list(t(['Definir compra de activos o participaciones, entidad adquirente y asignación del precio.','Revisar sales/use tax, nómina, propiedad, franchise/gross receipts, nexus multiestado y gravámenes locales.','Confirmar pasivos fiscales heredados, certificados de cumplimiento y retenciones.','En compras de activos cubiertas por §1060, coordinar precio asignado y Form 8594 entre las partes.'],['Determine asset versus equity purchase, acquiring entity and purchase-price allocation.','Review sales/use, payroll, property, franchise/gross-receipts taxes, multistate nexus and local charges.','Confirm inherited tax liabilities, clearance certificates and withholding requirements.','For asset acquisitions covered by §1060, coordinate purchase-price allocation and Form 8594 between the parties.']))}<p>${t('El impuesto efectivo requiere entidad, bases fiscales y perímetro del acuerdo. El simulador recibe un importe anual explícito.','Effective tax requires entity type, tax bases and transaction perimeter. The simulator accepts an explicit annual cash-tax amount.')} ${cite(5)}</p>`;
  let s7=`<p class="lead">${t('La tecnología crea valor cuando mejora contribución o caja y conserva la calidad del servicio. Las siguientes son hipótesis para probar en esta operación.','Technology creates value when it improves contribution or cash while preserving service quality. The following are hypotheses to test in this operation.')}</p><div class="table"><table><thead><tr><th>${t('Palanca','Value lever')}</th><th>${t('Experimento propuesto','Proposed experiment')}</th><th>${t('Cómo medir','Measurement')}</th></tr></thead><tbody><tr><th>${t('Ingresos','Revenue')}</th><td>${esc(sector.pilots[0])}</td><td>${t('Leads, contacto, conversión, ticket y margen incremental.','Leads, contact rate, conversion, order value and incremental margin.')}</td></tr><tr><th>${t('Costos y gastos','Costs & expenses')}</th><td>${esc(sector.pilots[1])}</td><td>${t('Horas netas, errores, retrabajo y desembolso evitado; descontar herramientas y supervisión.','Net hours, errors, rework and avoided cash spend; deduct tools and supervision.')}</td></tr></tbody></table></div><h3>${t('Plan de 90 días','90-day plan')}</h3><ol class="timeline"><li><strong>01–30</strong><span>${t('Medir línea base y documentar un proceso con responsable.','Measure the baseline and document one process with an accountable owner.')}</span></li><li><strong>31–60</strong><span>${t('Probar un flujo acotado con revisión humana y control.','Pilot a bounded workflow with human review and a control comparison.')}</span></li><li><strong>61–90</strong><span>${t('Ampliar solo con mejora neta y calidad, privacidad y continuidad conservadas.','Expand only after net improvement while preserving quality, privacy and continuity.')}</span></li></ol>${r.digital?`<details><summary>${t('Auditoría digital · observaciones y límites','Digital review · observations and limitations')}</summary><p class="note">${t('Extractos originales del análisis observado; no es una auditoría de tráfico o conversión.','Original review excerpts; this is not a traffic or conversion audit.')}</p>${list(r.digital.observations.map(o=>o.name+': '+o.status))}${list(r.digital.limitations)}</details>`:''}<details><summary>${t('Cuantificar una hipótesis · escenario','Quantify a hypothesis · scenario')}</summary><div class="input-grid">${[['uplift',t('Aumento de ingresos (%)','Revenue increase (%)'),0],['contribution',t('Margen de contribución incremental (%)','Incremental contribution margin (%)'),0],['savings',t('Ahorro efectivo anual (USD)','Annual cash savings (USD)'),0],['tech',t('Implementación y operación anual (USD)','Annual implementation and operation (USD)'),0]].map(x=>input(...x)).join('')}</div><div class="inline-metric"><span>${t('Contribución adicional antes de impuestos','Additional pre-tax contribution')}</span><strong data-result="aiBenefit">—</strong></div><p class="note">${t('Hipótesis editable; no es un ahorro demostrado.','Editable hypothesis, not demonstrated savings.')}</p></details>`;
  let s8=`<p class="lead">${t('La siguiente decisión es obtener evidencia y acordar condiciones de investigación, antes de comprometer capital.','The next decision is to obtain evidence and agree investigation conditions before committing capital.')}</p>${list(t(['Conciliar ganancias con P&G, balance, declaraciones, bancos y caja.','Validar concentración, clientes perdidos, pipeline y transferencia de relaciones.','Revisar contratos, change-of-control, licencias, litigios, seguros y obligaciones laborales.','Acordar transición del dueño, permanencia del equipo y términos completos del pagaré.','Medir una palanca comercial y una operativa antes de proyectar mejoras.'],['Reconcile earnings with P&L, balance sheet, tax returns, bank statements and cash.','Validate concentration, lost accounts, pipeline and relationship transferability.','Review contracts, change-of-control clauses, licenses, litigation, insurance and employment obligations.','Agree owner transition, team retention and full seller-note terms.','Measure one commercial and one operating lever before forecasting improvements.']))}<p class="thesis-note">${t('Generar el informe conserva las notas y etapas. Avanzar en el pipeline requiere una decisión del equipo.','Generating a report preserves notes and stages. Moving forward in the pipeline requires a team decision.')}</p>`;
  const sourceNames=t(['Anuncio del negocio','Autoridad fiscal estatal','BLS · indicadores por industria','SBA · propiedad y ciudadanía','IRS · compra de activos / Form 8594'],['Business listing','State tax authority','BLS · industry indicators','SBA · ownership and citizenship','IRS · asset acquisitions / Form 8594']);
  let s9=`<p>${t('Fotografía de datos publicados y cálculos reproducibles. La presencia del anuncio no prueba disponibilidad para negociar. No incluye notas privadas ni presume auditoría de balances o identidad legal.','Snapshot of published data and reproducible calculations. A published listing does not establish negotiation availability. Private CRM notes are excluded; financial statements and legal identity are not presumed audited.')}</p><div class="table"><table class="sources"><thead><tr><th>#</th><th>${t('Fuente primaria','Primary source')}</th><th>${t('Fecha de referencia','Reference date')}</th><th>${t('Alcance','Scope')}</th></tr></thead><tbody>${r.sources.map((s,i)=>`<tr id="${lang}-source-${i+1}"><td>${String(i+1).padStart(2,'0')}</td><td><a href="${safe(s.url)}" target="_blank" rel="noopener">${esc(sourceNames[i]||s.title)} ↗</a></td><td>${esc(s.as_of?.slice(0,10)||'—')}</td><td>${i===0?t('Cifras y afirmaciones del anunciante.','Listing figures and statements.'):i===2?t('Recurso oficial; serie numérica aún no extraída.','Official resource; a numeric series has not been extracted.'):t('Contexto normativo; aplicación específica por validar.','Regulatory context; specific application requires validation.')}</td></tr>`).join('')}</tbody></table></div><dl class="provenance"><div><dt>${t('Generado','Generated')}</dt><dd>${esc(r.generated_at)}</dd></div><div><dt>${t('Anuncio comprobado','Listing checked')}</dt><dd>${esc(r.source_checked_at||'—')}</dd></div><div><dt>${t('Publicación original','Original publication')}</dt><dd>${esc(r.published_at||'—')}</dd></div></dl>`;
  return `<div class="language-view" data-lang="${lang}" ${lang==='en'?'hidden':''}><div class="layout"><aside class="contents" aria-label="${t('Índice del informe','Report contents')}"><span class="eyebrow">${t('Contenido','Contents')}</span>${headings.map((h,i)=>`<a href="#${lang}-s${i}"><span>${String(i+1).padStart(2,'0')}</span>${h}</a>`).join('')}</aside><main id="${lang}-report"><header class="cover"><div class="cover-top"><span class="eyebrow">BIZACQ / ${t('ESTUDIOS DE ADQUISICIÓN','ACQUISITION RESEARCH')}</span><span class="edition">${t('Informe','Memorandum')} ${String(r.version).padStart(2,'0')} · ${esc(r.generated_at.slice(0,10))}</span></div><p class="cover-label">${t('Memorando de inversión','Investment memorandum')}</p><h1>${esc(r.title)}</h1><div class="cover-bottom"><span>${esc(r.industry)}<br>${esc([r.city,r.state,t('Estados Unidos','United States')].filter(Boolean).join(' · '))}</span><span>${t('Información pública · preliminar','Public-source research · preliminary')}<br><a href="${safe(r.source_url)}" target="_blank" rel="noopener">${t('Anuncio original','Original listing')} ↗</a></span></div></header>${changed?`<p class="risk-note">${t('Existe información posterior. Este informe conserva su fotografía original.','Newer information is available. This report preserves its original snapshot.')}</p>`:''}${current&&['DESCARTADO','CIERRE'].includes(current.pipeline_status)?`<p class="risk-note">${t('Estado actual','Current stage')}: ${esc(current.pipeline_status)}. ${t('Informe histórico.','Historical report.')}</p>`:''}${section(0,t('Decisión preliminar','Preliminary decision'),t('La tesis, en sus números','The thesis in numbers'),s0)}${section(1,t('El activo','The asset'),t('Qué se compra y dónde opera','What is being acquired'),s1)}${section(2,t('Contexto competitivo','Competitive context'),esc(sector.name),s2)}${section(3,t('Calidad de ganancias','Quality of earnings'),t('Cifras publicadas y calidad de caja','Reported financials & cash quality'),s3)}${section(4,t('Estructura de compra','Acquisition structure'),t('Deuda, efectivo y retorno del escenario','Debt, equity & scenario returns'),s4)}${section(5,t('Financiación','Financing'),t('Small business y comprador elegible','Small business & buyer eligibility'),s5)}${section(6,t('Estructura fiscal','Tax structure'),t('Impuestos y perímetro de la operación','Tax context & transaction perimeter'),s6)}${section(7,t('Creación de valor','Value creation'),t('IA, automatización y tecnología','AI, automation & technology'),s7)}${section(8,t('Condiciones para avanzar','Conditions to proceed'),t('De la hipótesis a la evidencia','From hypothesis to evidence'),s8)}${section(9,t('Registro de evidencia','Evidence ledger'),t('Fuentes, límites y fecha de corte','Sources, scope & cut-off date'),s9)}<footer>BIZACQ INTELLIGENCE<span>${t('USD · análisis para socios','USD · research for partners')} / ${esc(r.generated_at.slice(0,10))}</span></footer></main></div></div>`;
 }
 const data=JSON.stringify(f).replace(/</g,'\\u003c');
 const css=`:root{color-scheme:light;--canvas:#e9ece7;--paper:#faf9f5;--ink:#18382e;--text:#293b34;--muted:#596b62;--line:#d4dcd4;--soft:#edf0e9;--accent:#28624d;--peer:#a6b7a8;--warn:#6f4c16;--warn-bg:#f4ead7;--equity:#899a8b;--seller:#b19d74;--bank:#2e6c56;--focus:#1b6b55}html[data-theme=dark]{color-scheme:dark;--canvas:#101b17;--paper:#16241e;--ink:#edf1e7;--text:#d7dfd3;--muted:#a8b9ab;--line:#3b5144;--soft:#20382c;--accent:#9bd0b3;--peer:#63806c;--warn:#f0d29a;--warn-bg:#362e20;--equity:#91a694;--seller:#c1a875;--bank:#4e9d79;--focus:#b6e2cb}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:96px}body{margin:0;background:var(--canvas);color:var(--text);font:16px/1.75 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}button,select,input{font:inherit}a{color:var(--accent);text-underline-offset:4px;overflow-wrap:anywhere}a:hover{color:var(--ink)}button,select{min-height:44px;border:1px solid var(--line);border-radius:3px;background:var(--paper);color:var(--ink);padding:7px 11px;cursor:pointer;font-size:13px}button:hover,select:hover{background:var(--soft)}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}button:disabled{opacity:.55;cursor:wait}.reader-bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px max(20px,calc((100vw - 1200px)/2));border-bottom:1px solid var(--line);background:var(--paper)}.reader-brand{font-size:12px;letter-spacing:2px;font-weight:650;color:var(--ink);margin-right:auto}.reader-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.control-label{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px}.reader-bar select{font-size:14px}.mobile-jump{display:none}.layout{max-width:1220px;margin:auto;display:grid;grid-template-columns:156px minmax(0,940px);gap:40px;padding:48px 28px 0}.contents{position:sticky;top:110px;align-self:start;font-size:12px;padding-top:12px}.contents .eyebrow{display:block;margin-bottom:16px}.contents a{display:flex;gap:10px;align-items:baseline;padding:8px 0;text-decoration:none;line-height:1.5;color:var(--muted)}.contents a:hover,.contents a:focus-visible{color:var(--ink)}.contents a span{font-variant-numeric:tabular-nums;font-size:10px;opacity:.75}main{min-width:0;background:var(--paper);padding:0 42px;box-shadow:0 1px 0 var(--line)}h1,h2,h3,p,figure{margin:0}h1{font-size:clamp(32px,4.4vw,54px);font-weight:450;letter-spacing:-.045em;line-height:1.12;color:var(--ink);overflow-wrap:anywhere;max-width:20ch}h2{font-size:clamp(26px,3vw,35px);font-weight:480;letter-spacing:-.03em;line-height:1.2;color:var(--ink)}h3{font-size:18px;font-weight:600;line-height:1.4;color:var(--ink);margin:28px 0 12px}p{margin:16px 0;max-width:73ch}.eyebrow{font-size:10px;letter-spacing:1.8px;text-transform:uppercase;color:var(--muted);line-height:1.5;font-weight:650}.cover{padding:35px 0 38px;border-bottom:2px solid var(--ink)}.cover-top,.cover-bottom{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.cover-top{padding-bottom:48px;align-items:baseline}.edition{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.cover-label{font-size:13px;margin:0 0 17px;color:var(--muted)}.cover-bottom{padding-top:28px;color:var(--muted);font-size:12px;line-height:1.8}.cover-bottom>span:last-child{text-align:right}.cover-bottom a{color:var(--muted)}section{padding:48px 0;border-bottom:1px solid var(--line);scroll-margin-top:92px}.section-heading{display:flex;gap:20px;align-items:baseline;margin-bottom:30px}.section-heading .eyebrow{margin:0 0 9px}.section-number{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}.lead{font-size:19px;line-height:1.7;color:var(--ink);max-width:65ch;letter-spacing:-.015em}.decision{font-size:12px;letter-spacing:.5px;color:var(--accent);font-weight:650;margin:0 0 26px}.headline-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-block:1px solid var(--line);margin:0 0 26px}.headline-metrics>div{padding:18px 10px 18px 0;min-width:0}.headline-metrics span{display:block;color:var(--muted);font-size:11px;line-height:1.5}.headline-metrics strong{display:block;font-size:clamp(25px,3vw,36px);color:var(--ink);font-weight:450;letter-spacing:-1px;font-variant-numeric:tabular-nums;white-space:nowrap}.thesis-note{border-left:2px solid var(--accent);padding:1px 20px;margin:24px 0;background:var(--soft)}.thesis-note .eyebrow{padding-top:14px}.risk-note{border-left:2px solid var(--warn);background:var(--warn-bg);color:var(--warn);padding:14px 18px;margin:24px 0;font-size:14px}.risk-note h3{color:var(--warn);margin-top:0}.note,.source-note{font-size:12px;line-height:1.7;color:var(--muted)}.source-note{margin:14px 0 0}.cite{font-size:11px;vertical-align:super;text-decoration:none;font-variant-numeric:tabular-nums}.table{overflow-x:auto;max-width:100%;margin:20px 0}.fact-table{margin:22px 0}table{width:100%;border-collapse:collapse;line-height:1.5;font-size:13px}th,td{padding:13px 8px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{font-weight:600;color:var(--ink)}thead th{border-top:1px solid var(--ink);border-bottom:1px solid var(--ink);font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)}.numeric{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.fact-table th{width:38%;font-weight:450;color:var(--muted)}.exhibit{margin:32px 0;padding:24px 0;border-block:1px solid var(--line)}.exhibit h3{margin:7px 0 25px;font-size:20px;letter-spacing:-.02em}.exhibit .table{margin-bottom:0}.bar-label{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--muted);margin-bottom:6px}.bar-label strong{font-weight:500;color:var(--ink);font-variant-numeric:tabular-nums}.bar-track{background:var(--soft);height:12px;margin-bottom:20px;border-left:1px solid var(--muted)}.bar{height:100%;background:var(--accent)}.bar.peer{background:var(--peer)}.axis{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}.inline-metric{display:flex;gap:20px;align-items:baseline;justify-content:space-between;border-block:1px solid var(--line);padding:16px 0;margin:24px 0}.inline-metric span{font-size:12px;color:var(--muted)}.inline-metric strong{font-size:30px;font-weight:450;color:var(--ink);font-variant-numeric:tabular-nums}ul{padding-left:20px;margin:20px 0}li{padding-left:4px;margin:12px 0}blockquote{margin:26px 0;padding:12px 20px;border-left:1px solid var(--line);font-size:16px;font-style:italic}blockquote span{display:block;font:10px system-ui;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px}details{border-top:1px solid var(--line);padding-top:16px;margin:24px 0}summary{cursor:pointer;font-size:13px;font-weight:550;color:var(--ink);min-height:44px;padding:8px 0}.description{font-size:13px;line-height:1.8;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;padding-top:12px}.scenario-panel{padding:24px;background:var(--soft);margin:24px -8px}.scenario-panel h3:first-child{margin-top:0}.input-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px;margin:22px 0}label{display:block;font-size:11px;color:var(--muted);line-height:1.5}input{display:block;width:100%;min-width:0;margin-top:7px;min-height:44px;border:1px solid var(--line);border-radius:2px;background:var(--paper);color:var(--ink);padding:9px 10px;font-size:16px;font-variant-numeric:tabular-nums}.funding-figure{margin:26px 0}.funding-figure figcaption{font-size:12px;color:var(--muted);margin-bottom:12px}.funding-bar{display:flex;height:20px;background:var(--line)}.funding-bar i{display:block;min-width:0}.funding-bar [data-funding=equity],.equity-key{background:var(--equity)}.funding-bar [data-funding=seller],.seller-key{background:var(--seller)}.funding-bar [data-funding=bank],.bank-key{background:var(--bank)}.funding-legend{display:flex;gap:18px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-top:10px}.funding-legend span{display:flex;align-items:center;gap:7px}.funding-legend i{width:9px;height:9px;display:inline-block}.timeline{list-style:none;padding:0;margin:24px 0}.timeline li{display:grid;grid-template-columns:62px minmax(0,1fr);gap:20px;border-top:1px solid var(--line);margin:0;padding:15px 0}.timeline strong{font-size:13px;font-weight:550;color:var(--ink);font-variant-numeric:tabular-nums}.timeline span{font-size:14px}.sources{font-size:12px}.sources td{overflow-wrap:anywhere}.sources td:first-child{font-size:10px;color:var(--muted)}.provenance{font-size:11px;color:var(--muted);margin:24px 0}.provenance>div{display:flex;justify-content:space-between;gap:15px;border-bottom:1px solid var(--line);padding:9px 0}.provenance dd{margin:0;overflow-wrap:anywhere}footer{display:flex;justify-content:space-between;gap:20px;padding:28px 0;font-size:9px;color:var(--muted);letter-spacing:1px}footer span{letter-spacing:0}[hidden],.language-view[hidden]{display:none!important}.skip{position:absolute;left:12px;top:-80px;background:var(--paper);padding:12px;z-index:50}.skip:focus{top:8px}@media(min-width:1400px){.headline-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:1100px){.layout{display:block;padding:28px 24px 0;max-width:980px}.contents{display:none}.mobile-jump{display:block;max-width:210px}.reader-brand{font-size:10px}.reader-bar{padding:10px 20px}main{padding:0 30px}.cover-top{padding-bottom:34px}}@media(max-width:600px){body{font-size:15px;line-height:1.8}.reader-bar{gap:8px;padding:8px 14px}.reader-brand{width:100%;margin:0;letter-spacing:1.5px}.reader-controls{width:100%;gap:6px;justify-content:space-between}.control-label{display:block}.control-label>span{display:none}.reader-bar select{font-size:16px;padding:7px 8px}.reader-bar button{padding:7px 9px;font-size:12px}.mobile-jump{max-width:100%;width:100%;min-height:38px;font-size:14px!important}.layout{padding:12px 0 0}main{padding:0 20px}.cover{padding:24px 0 26px}.cover-top{gap:8px;padding-bottom:30px}.cover-top .eyebrow{font-size:9px}.cover-label{font-size:12px}h1{font-size:36px;max-width:100%}.cover-bottom{padding-top:22px;gap:14px}.cover-bottom>span:last-child{text-align:left}.section-heading{gap:13px;margin-bottom:24px}section{padding:34px 0;scroll-margin-top:172px}.section-number{font-size:10px}.lead{font-size:17px;line-height:1.75}.headline-metrics strong{font-size:28px}.headline-metrics span{font-size:10px}.thesis-note{padding-inline:14px}.input-grid{grid-template-columns:1fr;gap:16px}.scenario-panel{padding:18px 12px;margin-inline:-8px}.table table{font-size:12px}.table td,.table th{padding:11px 5px}.table td.note{font-size:10px}.inline-metric{gap:10px}.inline-metric strong{font-size:25px}.sources{min-width:530px}footer{flex-direction:column;gap:5px}.provenance>div{display:block}.provenance dd{padding-top:3px}.print-button{font-size:11px!important}.timeline li{gap:12px;grid-template-columns:54px minmax(0,1fr)}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{html[data-theme],:root{color-scheme:light;--canvas:white;--paper:white;--ink:#102f24;--text:#243a2e;--muted:#4b6256;--line:#ccd6cc;--soft:#f1f4ee;--accent:#28624d;--warn:#6f4c16;--warn-bg:#fff4df}body{font-size:11px;background:white}.reader-bar,.contents,.skip{display:none!important}.layout{display:block;padding:0;max-width:none}main{padding:0;box-shadow:none}.cover{padding-top:0}.cover-top{padding-bottom:24px}h1{font-size:34px}h2{font-size:24px}section{padding:26px 0}h2,h3{break-after:avoid}tr,.headline-metrics,.exhibit{break-inside:avoid}.input-grid{grid-template-columns:1fr 1fr}.headline-metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.headline-metrics strong{font-size:22px}input{min-height:0;border:0;padding:0;font-size:12px}details>div,details>p{display:block!important}.table{overflow:visible}.sources{min-width:0}button{display:none}}`;
 return `<!doctype html><html lang="es" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>BizAcq · ${esc(r.title)}</title><style>${css}</style></head><body><a class="skip" href="#es-report" id="skip-link">Saltar al informe / Skip to report</a><div class="reader-bar" role="region" aria-label="Report reading controls"><span class="reader-brand">BIZACQ / RESEARCH</span><div class="reader-controls"><label class="control-label"><span>Idioma / Language</span><select id="reportLanguage" aria-label="Idioma / Language"><option value="es">Español</option><option value="en">English</option></select></label><label class="control-label"><span>Tema / Theme</span><select id="reportTheme" aria-label="Tema / Theme"><option value="light">Claro / Light</option><option value="dark">Oscuro / Dark</option></select></label><button class="print-button" id="reportPrint">Imprimir / PDF</button></div><select id="sectionJump" class="mobile-jump" aria-label="Ir a sección / Jump to section"></select></div>${view('es')}${view('en')}<script>const __name=(fn)=>fn;const facts=${data};const calculate=${reportScenario.toString()};let scenarioState={};let language='es';const names={es:['Tesis','Compañía','Industria','Financials','Compra y deuda','Small business','Impuestos','IA y tecnología','Diligencia','Fuentes'],en:['Investment thesis','Company','Industry','Financials','Acquisition & debt','Small business','Tax context','AI & technology','Due diligence','Sources']};function refresh(){const r=calculate(facts,scenarioState);document.querySelectorAll('[data-error]').forEach(e=>e.hidden=r.valid);document.querySelectorAll('[data-result]').forEach(e=>{const en=e.closest('[data-lang]').dataset.lang==='en',k=e.dataset.result,v=r[k];e.textContent=!r.valid?(en?'Invalid scenario':'Escenario inválido'):v===null||v===undefined?'—':k==='coverage'||k==='stressCoverage'?v.toFixed(2)+'×':k==='payback'?v.toFixed(1)+(en?' years':' años'):k==='cashOnCash'?v.toFixed(1)+'%':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v)});const v=r.values;document.querySelectorAll('[data-funding]').forEach(e=>{const k=e.dataset.funding;e.style.width=(r.valid?(k==='bank'?v.bankPct:k==='seller'?v.sellerPct:100-v.bankPct-v.sellerPct):0)+'%'});}function preferences(){try{const u=new URL(location.href);u.searchParams.set('lang',language);u.searchParams.set('theme',document.documentElement.dataset.theme);history.replaceState(null,'',u);localStorage.setItem('bizacq_report_language',language);localStorage.setItem('bizacq_report_theme',document.documentElement.dataset.theme);}catch{}}function chooseLanguage(value){language=value==='en'?'en':'es';document.documentElement.lang=language;document.querySelectorAll('[data-lang]').forEach(e=>e.hidden=e.dataset.lang!==language);document.getElementById('reportLanguage').value=language;document.getElementById('reportPrint').textContent=language==='en'?'Print / PDF':'Imprimir / PDF';document.getElementById('skip-link').href='#'+language+'-report';const jump=document.getElementById('sectionJump');jump.replaceChildren();let first=document.createElement('option');first.value='';first.textContent=language==='en'?'Navigate the memorandum':'Explorar el informe';jump.append(first);names[language].forEach((name,i)=>{const o=document.createElement('option');o.value=language+'-s'+i;o.textContent=String(i+1).padStart(2,'0')+' · '+name;jump.append(o)});preferences();}function chooseTheme(value){document.documentElement.dataset.theme=value==='dark'?'dark':'light';document.getElementById('reportTheme').value=document.documentElement.dataset.theme;preferences();}document.querySelectorAll('[data-scenario]').forEach(e=>e.addEventListener('input',()=>{scenarioState[e.dataset.scenario]=e.value;document.querySelectorAll('[data-scenario="'+e.dataset.scenario+'"]').forEach(other=>other.value=e.value);refresh()}));document.getElementById('reportLanguage').addEventListener('change',e=>chooseLanguage(e.target.value));document.getElementById('reportTheme').addEventListener('change',e=>chooseTheme(e.target.value));document.getElementById('sectionJump').addEventListener('change',e=>{if(e.target.value)document.getElementById(e.target.value).scrollIntoView({block:'start'})});document.getElementById('reportPrint').addEventListener('click',()=>window.print());let initialLang='es',initialTheme='light';try{const q=new URLSearchParams(location.search);initialLang=q.get('lang')||localStorage.getItem('bizacq_report_language')||'es';initialTheme=q.get('theme')||localStorage.getItem('bizacq_report_theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}catch{}chooseLanguage(initialLang);chooseTheme(initialTheme);refresh();</script></body></html>`;
}
