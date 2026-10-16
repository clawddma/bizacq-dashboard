import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../cloudflare/worker.js',import.meta.url),'utf8');
const {acquisitionSignals,scoreAllDeals,screenDeal}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const deal=text=>({id:'x',title:'Established HVAC',public_facts:{description:text,asking_price:1000000,reported_revenue:2000000,reported_cash_flow:300000},notes:[{text:'Keep'}],pipeline_status:'EN_ANALISIS'});
let p=acquisitionSignals(deal('Reason for Selling: Retirement. Seller financing: 30%. SBA pre-approved.'));
assert(p.retirement);assert(!p.succession_gap);assert.equal(p.seller_percent,30);assert(p.sba_advertised);assert(p.financials_usable);
p=acquisitionSignals(deal('Owner is retiring. No family successor. Seller financing available.'));
assert(p.retirement&&p.succession_gap);assert.equal(p.seller_percent,null);
p=acquisitionSignals(deal('No seller financing. SBA not available.'));
assert.equal(p.seller_financing,'not_offered');assert(!p.sba_advertised);
p=acquisitionSignals(deal('Financial advisory and retirement planning services. Seller financing available. 25% down payment.'));
assert(!p.retirement);assert.equal(p.seller_percent,null);
assert.equal(acquisitionSignals(deal('Seller financing: up to 40%.')).seller_percent,40);
assert.equal(acquisitionSignals(deal('20% seller financing.')).seller_percent,20);
p=acquisitionSignals({...deal('Reason for Selling: Other interests'),financial:{owner_retiring:true},seller_financing:true});assert(!p.retirement);assert.equal(p.seller_financing,'unknown');
const data={deals:[deal('Reason for Selling: Retirement')],manual_orders:{EN_ANALISIS:['x']}};const before=structuredClone(data);scoreAllDeals(data);for(const key of ['notes','pipeline_status'])assert.deepEqual(data.deals[0][key],before.deals[0][key]);assert.deepEqual(data.manual_orders,before.manual_orders);
console.log('PASS: retirement/succession, exact seller terms, negative claims, public-only data, SBA and CRM preservation');

assert(!acquisitionSignals(deal('The owner is not retiring.')).retirement);

assert.equal(screenDeal(deal('No seller financing.')).components.find(c=>c.name==='Facilidad de estructuración').known,false);
