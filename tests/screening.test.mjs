import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../cloudflare/worker.js',import.meta.url),'utf8');
const {screenDeal,scoreAllDeals,mergeSourceBatch}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const now='2026-10-15T20:00:00Z';
const unknown=screenDeal({overall_score:99},now);assert.equal(unknown.score,0);assert.equal(unknown.coverage,0);assert.equal(unknown.disposition,'revalidate');
const fresh={id:'x',source:'empire_flippers',source_url_kind:'listing',source_url:'https://empireflippers.com/listing/1/',asking_price:300000,reported_net_profit:100000,listing_evidence:{checked_at:now,status:'published',published_at:'2026-09-01',publication_source:'portal'},pipeline_status:'EN_ANALISIS',notes:[{text:'Keep'}],review:{rating:5},operating_metrics:{hours_worked_per_week:5,first_made_money_at:'2020-01-01',net_profit_trend_percent:12}};
let s=screenDeal(fresh,now);assert.equal(s.score,46);assert.equal(s.coverage,50);assert.equal(s.disposition,'eligible');assert.equal(s.earnings_basis,'Beneficio neto anual publicado');
assert.equal(screenDeal({...fresh,listing_evidence:{...fresh.listing_evidence,published_at:'2025-07-17'}},now).disposition,'revalidate');
assert.equal(screenDeal({...fresh,source_url_kind:'category'},now).disposition,'revalidate');
const data={deals:[structuredClone(fresh)],manual_orders:{EN_ANALISIS:['x']}};const before=structuredClone(data);scoreAllDeals(data,now);
for(const field of ['notes','review','pipeline_status'])assert.deepEqual(data.deals[0][field],before.deals[0][field]);assert.deepEqual(data.manual_orders,before.manual_orders);
assert(s.components.every(c=>c.points<=c.coverage));assert(s.questions.length>=5);
console.log('PASS screening: missing≠good, oldscore ignored, provenance, age gate, preserved CRM, bounded weights');

const gone={deals:[structuredClone(fresh)]};mergeSourceBatch(gone,{run:{id:'gone',finished_at:now,status:'success',source:'empire_flippers',primary_listing_urls:[],sources:[{source:'empire_flippers',status:'success',coverage:'complete'}]},listings:[]});scoreAllDeals(gone,now);assert.equal(gone.deals[0].screening.disposition,'revalidate');assert.equal(gone.deals[0].pipeline_status,'EN_ANALISIS');assert.equal(gone.deals[0].notes[0].text,'Keep');console.log('PASS absent complete catalog quarantines, never discards');
