import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../cloudflare/worker.js',import.meta.url),'utf8');
const {applyAvailabilityObservation}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const now='2026-10-15T23:00:00Z';
const base=()=>({id:'x',source_url:'https://broker.example/listing/x',source_url_kind:'listing',pipeline_status:'EN_NEGOCIACION',notes:[{text:'Conservar nota'}],review:{rating:5},documents:[{name:'NDA'}],events:[]});
const obs=(d,status,extra={})=>({source_url:d.source_url,status,checked_at:now,...extra});
let d=base(),data={deals:[d],manual_orders:{EN_NEGOCIACION:['x'],DESCARTADO:[]}};
assert.equal(applyAvailabilityObservation(data,d,obs(d,'sold'),now),false);
assert.equal(applyAvailabilityObservation(data,d,obs(d,'sold',{availability_confirmed:true,status_evidence:['Listing status: Sold']}),now),true);
assert.equal(d.pipeline_status,'DESCARTADO');assert.match(d.discard_reason,/Vendido/);assert.equal(d.events.length,1);assert.equal(d.notes[0].text,'Conservar nota');assert.equal(d.review.rating,5);assert.equal(d.documents[0].name,'NDA');assert.deepEqual(data.manual_orders,{EN_NEGOCIACION:[],DESCARTADO:['x']});
assert.equal(applyAvailabilityObservation(data,d,obs(d,'sold',{availability_confirmed:true,status_evidence:['Listing status: Sold']}),now),false);assert.equal(d.events.length,1);
for(const status of ['blocked','blocked_source','identity_unresolved','unavailable','not_in_current_catalog']){d=base();assert.equal(applyAvailabilityObservation({deals:[d]},d,obs(d,status),now),false);assert.equal(d.pipeline_status,'EN_NEGOCIACION');}
d=base();data={deals:[d]};
for(const day of [13,13,14,15]){const time=`2026-10-${day}T20:00:00Z`;applyAvailabilityObservation(data,d,obs(d,'not_found',{checked_at:time}),time);if(day<15)assert.equal(d.pipeline_status,'EN_NEGOCIACION');}
assert.equal(d.retirement_checks.count,3);assert.match(d.discard_reason,/404\/410/);
d=base();data={deals:[d]};applyAvailabilityObservation(data,d,obs(d,'not_found'),now);applyAvailabilityObservation(data,d,obs(d,'published'),now);assert.equal(d.retirement_checks,undefined);
d=base();d.pipeline_status='CIERRE';assert.equal(applyAvailabilityObservation({deals:[d]},d,obs(d,'sold',{availability_confirmed:true,status_evidence:['Sold']}),now),false);
console.log('PASS: confirmed sale/withdrawal, three daily 404s, no block/age inference, CRM preservation, idempotence and closure protection');
