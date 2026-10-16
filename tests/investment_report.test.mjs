import assert from 'node:assert/strict';import fs from 'node:fs';
const code=fs.readFileSync(new URL('../cloudflare/worker.js',import.meta.url),'utf8');
const {reportFacts,reportScenario,buildInvestmentReport,saveInvestmentReport,renderInvestmentReport,mergeSourceBatch}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const now='2026-10-16T20:00:00Z';
const deal={id:'deal-a',title:'Roofing <script>alert(1)</script>',business_type:'Construction',state:'WV',source:'biztrader.com',source_url:'https://example.com/listing/a',public_facts:{asking_price:300000,reported_revenue:400000,reported_cash_flow:100000,description:'Owner is retiring. Seller financing: 25%.',observed_at:now},screening:{score:80,flags:[],disposition:'eligible'},listing_evidence:{status:'published',checked_at:now},notes:[{text:'PRIVATE_SECRET_NOT_FOR_REPORT'}],review:{rating:4},pipeline_status:'EN_ANALISIS'};
const data={deals:[deal],manual_orders:{EN_ANALISIS:[deal.id]}};const before=structuredClone(data);const r=saveInvestmentReport(data,deal,now);assert.equal(data.investment_reports.length,1);assert.equal(saveInvestmentReport(data,deal,now).id,r.id);assert(!JSON.stringify(r).includes('PRIVATE_SECRET'));assert.deepEqual(data.deals,before.deals);assert.deepEqual(data.manual_orders,before.manual_orders);
const f=reportFacts(deal);assert.equal(f.earnings,100000);assert.equal(f.sde,null);assert.equal(f.multiple,3);assert.equal(f.margin,25);
let s=reportScenario(f,{bankPct:50,bankRate:0,bankYears:10,sellerPct:25,sellerRate:0,sellerYears:5});assert(s.valid);assert.equal(s.equity,75000);assert.equal(s.totalDebt,30000);assert.equal(s.annualCash,70000);assert(Math.abs(s.debtCapacity-(100000/1.5-15000)*10)<.01);assert.equal(s.coverage,100000/30000);
assert(!reportScenario(f,{bankPct:80,sellerPct:30}).valid);assert(!reportScenario(f,{bankYears:0}).valid);assert(!reportScenario(f,{targetCoverage:.8}).valid);assert.equal(reportScenario({...f,conflict:true}).debtCapacity,null);assert.equal(reportScenario({...f,earnings:null}).annualCash,null);assert.equal(reportScenario(f,{uplift:10,contribution:40,savings:10000,tech:6000}).aiBenefit,20000);
const html=renderInvestmentReport(r,deal);assert(html.includes('Investment memorandum'));assert(html.includes('Memorando de inversión'));assert(html.includes('reportLanguage'));assert(html.includes('reportTheme'));assert(!html.includes('<script>alert(1)</script>'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('PRIVATE_SECRET'));assert(html.includes('Form 8594'));assert(html.includes('datos publicados')||html.includes('datos public'));
assert(renderInvestmentReport(r,{...deal,screening:{...deal.screening,disposition:'revalidate'}}).includes('información posterior'));
const changed=structuredClone(deal);changed.public_facts.asking_price=350000;assert(renderInvestmentReport(r,changed).includes('información posterior'));const r2=saveInvestmentReport(data,changed,now);assert.equal(r2.version,2);assert.equal(r.financials.price,300000);
// Small and mixed-basis cohorts cannot produce misleading industry medians.
assert.equal(buildInvestmentReport(deal,{deals:[deal]},now).peers.median_multiple,null);
for(let i=0;i<5;i++)data.deals.push({...structuredClone(deal),id:'peer-'+i});assert.equal(buildInvestmentReport(deal,data,now).peers.median_multiple,3);
console.log('PASS: immutable reports, no CRM leakage, exact amortization, debt capacity, stress, unknown/conflict gates, escaped HTML, versioning and peer minimum');
// Build real local fixture for responsive and full-flow UI QA.
if(fs.existsSync('.nightly/reports-before.json')) {const live=JSON.parse(fs.readFileSync('.nightly/reports-before.json'));const real=live.deals.find(d=>d.id==='977454ed-5ea1-4568-ac9d-300b4af6b5bc');const sample=buildInvestmentReport(real,live);fs.writeFileSync('.nightly/report-test.html',renderInvestmentReport(sample,real));fs.writeFileSync('.nightly/report-fixture.json',JSON.stringify(sample));

}
// Wrangler preserves function names using __name; serialized calculators must work after bundling.
const bundlePath=new URL('../cloudflare/.nightly/worker-report-build/worker.js',import.meta.url);
if(fs.existsSync(bundlePath)){
 const bundled=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(bundlePath,'utf8')).toString('base64'));
 const rendered=bundled.renderInvestmentReport(r,deal),script=rendered.match(/<script>([\s\S]*)<\/script>/)[1];
 const vm=await import('node:vm');
 const calculator=script.match(/const calculate=([\s\S]*?);let scenarioState/)[1];
 const result=vm.runInNewContext('const __name=(fn)=>fn;const calculate='+calculator+';calculate(facts,{bankPct:50})',{facts:r.financials});assert.equal(result.equity,150000);
 console.log('PASS: production-bundled standalone HTML calculator executes with Wrangler name helpers');
}
