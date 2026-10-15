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
