import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../cloudflare/worker.js',import.meta.url),'utf8');
const {mergeSourceBatch,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const old={id:'old',source:'manual',source_url:'https://broker.example/old',pipeline_status:'EN_NEGOCIACION',notes:[{text:'Keep'}],review:{rating:5},financial:{historical:true}};
const data={deals:[structuredClone(old)],manual_orders:{RADAR:['old']}};
const row={external_id:'new',source_url:'https://broker.example/new',title:'Example',asking_price:100000,reported_revenue:null,reported_cash_flow:20000};
const payload={run:{id:'run1',source:'dealledger',finished_at:'2026-10-15T20:00:00Z',status:'success'},listings:[row,row]};
assert.equal(mergeSourceBatch(data,payload).added,1);assert.equal(data.deals.length,2);assert.deepEqual(data.deals[0],old);assert.deepEqual(data.manual_orders,{RADAR:['old']});
const fresh=data.deals[1];fresh.pipeline_status='EN_NEGOCIACION';fresh.review={rating:4};fresh.notes.push({text:'Team note'});const id=fresh.id;
const again={run:{...payload.run,id:'run2'},listings:[{...row,asking_price:90000}]};assert.equal(mergeSourceBatch(data,again).updated,1);assert.equal(fresh.id,id);assert.equal(fresh.review.rating,4);assert.equal(fresh.pipeline_status,'EN_NEGOCIACION');assert.equal(fresh.notes[0].text,'Team note');assert.equal(fresh.source_changes[0].fields.asking_price.before,100000);assert.equal(fresh.reported_sde,null);
assert.equal(mergeSourceBatch(data,again).noop,true);assert.throws(()=>mergeSourceBatch(data,{run:{...payload.run,id:'bad'},listings:[{...row,asking_price:-1}]}));
const unauthorized=await worker.fetch(new Request('https://example.com/source-sync',{method:'POST',body:'{}'}),{});assert.equal(unauthorized.status,401);
const malformed=await worker.fetch(new Request('https://example.com/source-sync',{method:'POST',headers:{Authorization:'Bearer fixture'},body:'{}'}),{SOURCE_SYNC_TOKEN:'fixture'});assert.equal(malformed.status,400);
console.log('PASS: merge/dedupe/idempotence/preservation/changes/invalid input/auth');
// Exercise the shared-review HTTP contract and resulting persisted document.
const originalFetch=globalThis.fetch;let stored;
globalThis.fetch=async (url,options={})=>{
 if(options.method==='PUT'){const body=JSON.parse(options.body);stored=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));return Response.json({commit:{sha:'fixture'}});}
 return Response.json({sha:'fixture',content:Buffer.from(JSON.stringify({deals:[structuredClone(old)],manual_orders:{RADAR:['old']}})).toString('base64')});
};
const reviewResponse=await worker.fetch(new Request('https://example.com/update-deal',{method:'POST',headers:{Origin:'https://clawddma.github.io','Content-Type':'application/json'},body:JSON.stringify({dealId:'old',review:{rating:4,decision:'finalista',automation_thesis:'Measure workflow',next_action:'Request current information'},author:'QA'})}),{GITHUB_TOKEN:'fixture'});
assert.equal(reviewResponse.status,200);assert.equal(stored.deals[0].review.rating,4);assert.deepEqual(stored.deals[0].notes,old.notes);assert.equal(stored.deals[0].pipeline_status,'EN_NEGOCIACION');assert.deepEqual(stored.manual_orders,{RADAR:['old']});globalThis.fetch=originalFetch;
console.log('PASS: HTTP review contract persists rating while preserving CRM facts');

// Official email alerts cannot overwrite CRM or fresh direct evidence.
globalThis.fetch=async (url,options={})=>{
 if(options.method==='PUT'){stored=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString('utf8'));return Response.json({commit:{sha:'fixture'}});}
 return Response.json({sha:'fixture',content:Buffer.from(JSON.stringify({deals:[{...structuredClone(old),revalidation:{status:'non_operating_asset'},listing_evidence:{status:'published',checked_at:new Date().toISOString()}}],manual_orders:{RADAR:['old']}})).toString('base64')});
};
const alerts=await worker.fetch(new Request('https://example.com/portal-sync',{method:'POST',headers:{Authorization:'Bearer fixture'},body:JSON.stringify({records:[{source_url:old.source_url,title:'Do not replace',status:'email_alert',checked_at:new Date().toISOString()},{source_url:'https://www.bizquest.com/business-for-sale/example/BW1234567/',title:'Official new alert',status:'email_alert',checked_at:new Date().toISOString()}]})}),{GITHUB_TOKEN:'fixture',SOURCE_SYNC_TOKEN:'fixture'});
assert.equal(alerts.status,200);assert.equal(stored.deals.length,2);assert.deepEqual(stored.deals[0].notes,old.notes);assert.deepEqual(stored.deals[0].review,old.review);assert.equal(stored.deals[0].pipeline_status,old.pipeline_status);assert.equal(stored.deals[0].revalidation.status,'non_operating_asset');assert.equal(stored.deals[0].listing_evidence.status,'published');assert.equal(stored.deals[1].screening.disposition,'revalidate');assert.equal(stored.deals[1].pipeline_status,'RADAR');assert.deepEqual(stored.manual_orders,{RADAR:['old']});globalThis.fetch=originalFetch;
console.log('PASS: email discovery preserves CRM, source evidence and asset exclusions');

// Legacy category URLs can repeat: an explicit deal ID must win over URL matching.
globalThis.fetch=async (url,options={})=>{
 if(options.method==='PUT'){stored=JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64').toString('utf8'));return Response.json({commit:{sha:'fixture'}});}
 return Response.json({sha:'fixture',content:Buffer.from(JSON.stringify({deals:[structuredClone(old),{...structuredClone(old),id:'second'}]})).toString('base64')});
};
const exact=await worker.fetch(new Request('https://example.com/portal-sync',{method:'POST',headers:{Authorization:'Bearer fixture'},body:JSON.stringify({records:[{deal_id:'second',source_url:old.source_url,status:'identity_unresolved',checked_at:new Date().toISOString()}]})}),{GITHUB_TOKEN:'fixture',SOURCE_SYNC_TOKEN:'fixture'});
assert.equal(exact.status,200);assert.equal(stored.deals[0].revalidation,undefined);assert.equal(stored.deals[1].revalidation.status,'identity_unresolved');globalThis.fetch=originalFetch;
console.log('PASS: explicit deal ID wins for repeated legacy source URLs');
