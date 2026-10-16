/* Preliminary purchase math, no forecasts, model calls or lender approvals. */
function buildEconomics(deal={},scenario={}) {
  const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
  const nonnegative=v=>{const x=number(v);return x!==null&&x>=0?x:null;};
  const facts=deal.public_facts||{};
  const financialSource=facts.observed_at?facts:deal;
  const field=k=>nonnegative(financialSource[k]);
  const price=field('asking_price'),revenue=field('reported_revenue');
  const profits=[['reported_sde','SDE declarado'],['reported_net_profit','Beneficio neto declarado'],['reported_cash_flow','Flujo declarado por el broker']];
  const item=profits.find(([key])=>field(key)!==null);
  const profit=item?field(item[0]):null,basis=item?item[1]:'Ganancia anual no publicada';
  const text=String(facts.description||deal.raw_description||'');
  const sellerOffered=facts.seller_financing===true||(/seller financ|owner financ|seller carry/i.test(text)&&!/(?:no|without|not offering) seller financ/i.test(text));
  const percent=nonnegative(facts.seller_financing_percent);
  const sellerPercent=percent!==null&&percent<=100?percent:null;
  const values={sellerPct:0,bankPct:0,sellerRate:8,bankRate:10,sellerYears:5,bankYears:10,closingCosts:0,workingCapital:0,managerMonthly:0,reserveMonthly:0};
  let valid=true;
  for(const key of Object.keys(values)){
    const val=number(scenario[key]??values[key]);
    if(val===null||val<0)valid=false;
    values[key]=val;
  }
  if(values.sellerPct+values.bankPct>100||values.sellerRate>100||values.bankRate>100||values.sellerYears<1||values.sellerYears>40||values.bankYears<1||values.bankYears>40)valid=false;
  const payment=(principal,rate,years)=>{if(principal===0)return 0;const months=years*12,r=rate/1200;return r===0?principal/months:principal*r/(1-Math.pow(1+r,-months));};
  const sellerDebt=valid&&price!==null?price*values.sellerPct/100:null;
  const bankDebt=valid&&price!==null?price*values.bankPct/100:null;
  const purchaseCash=sellerDebt!==null?price-sellerDebt-bankDebt:null;
  const totalCash=purchaseCash!==null?purchaseCash+values.closingCosts+values.workingCapital:null;
  const monthlyDebt=sellerDebt!==null?payment(sellerDebt,values.sellerRate,values.sellerYears)+payment(bankDebt,values.bankRate,values.bankYears):null;
  const adjustedProfit=valid&&profit!==null?profit-12*(values.managerMonthly+values.reserveMonthly):null;
  const annualCash=adjustedProfit!==null&&monthlyDebt!==null?adjustedProfit-12*monthlyDebt:null;
  return {price,revenue,profit,basis,monthlyProfit:profit===null?null:profit/12,multiple:price!==null&&profit>0?price/profit:null,margin:revenue>0&&profit!==null?100*profit/revenue:null,sellerOffered,sellerPercent,sellerLabel:sellerPercent!==null?sellerPercent+'% publicado':sellerOffered?'Anunciada · porcentaje no publicado':'No informada',hasPublicFacts:!!facts.observed_at||deal.source==='empire_flippers',valid,purchaseCash,totalCash,sellerDebt,bankDebt,monthlyDebt,annualCash,monthlyCash:annualCash===null?null:annualCash/12,dscr:monthlyDebt>0&&adjustedProfit!==null?adjustedProfit/(12*monthlyDebt):null,cashOnCash:totalCash>0&&annualCash!==null?100*annualCash/totalCash:null,payback:annualCash>0&&totalCash>0?totalCash/annualCash:null,values};
}
