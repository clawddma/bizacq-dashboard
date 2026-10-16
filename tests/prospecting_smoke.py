import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'cli'))
from nightly_refresh import get_json,API
j=get_json(API+'/deals')
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page(viewport={'width':1440,'height':1000});errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/deals?*',lambda r:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(j)))
 page.goto('http://127.0.0.1:8789/web/');page.wait_for_function('window.Alpine && Alpine.$data(document.body).deals.some(d=>d.prospecting)')
 page.get_by_label('Tesis de compra',exact=True).select_option('retirement')
 page.wait_for_function("Alpine.$data(document.body).filteredCount>0")
 facts=page.evaluate("()=>{const a=Alpine.$data(document.body),rows=a.deals.filter(d=>a.passesFilters(d)&&!['CIERRE','DESCARTADO'].includes(d.pipeline_status));return {retirement:rows.length,valid:rows.every(d=>d.prospecting.retirement||d.prospecting.succession_gap)};}")
 assert facts['valid']
 for w in [390,768,1440]:
  page.set_viewport_size({'width':w,'height':1000});page.wait_for_timeout(80);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),w
 page.get_by_label('Tesis de compra',exact=True).select_option('retirement_financing')
 page.wait_for_timeout(80)
 assert page.evaluate("()=>{const a=Alpine.$data(document.body);return a.deals.filter(d=>a.passesFilters(d)).every(d=>d.prospecting.seller_financing==='advertised'&&(d.prospecting.retirement||d.prospecting.succession_gap));}")
 page.get_by_label('Tesis de compra',exact=True).select_option('all')
 page.get_by_label('Seller financing',exact=False).check()
 page.wait_for_timeout(80)
 assert page.evaluate("()=>{const a=Alpine.$data(document.body);return a.deals.filter(d=>a.passesFilters(d)).every(d=>d.prospecting.seller_financing==='advertised');}")
 page.evaluate("()=>{const a=Alpine.$data(document.body);a.openDeal(a.deals.find(d=>d.prospecting.retirement&&d.screening.disposition==='eligible'));}")
 page.get_by_label('Señales de adquisición',exact=True).wait_for(state='visible')
 for w in [390,768,1440]:
  page.set_viewport_size({'width':w,'height':1000});page.wait_for_timeout(80);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),('detail',w)
 assert not errors,errors
 print(json.dumps({'status':'PASS',**facts,'widths':[390,768,1440],'seller_filter':True,'combined_filter':True,'detail':True,'js_errors':errors}));b.close()
