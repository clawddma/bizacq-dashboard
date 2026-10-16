import json
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
data=json.loads((root/'.nightly/reports-before.json').read_text());report=json.loads((root/'.nightly/report-fixture.json').read_text());html=(root/'.nightly/report-test.html').read_text();data['investment_reports']=[]
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page(viewport={'width':1440,'height':1000});errors=[];writes=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.route('**/deals?*',lambda r:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(data)))
 def analyze(r):
  writes.append(r.request.post_data_json);r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'ok':True,'screening':{},'analysis':{},'digital_analysis':{},'report':report}))
 page.route('**/analyze-deal',analyze)
 page.route('**/investment-report?*',lambda r:r.fulfill(status=200,content_type='text/html',body=html))
 page.goto('http://127.0.0.1:8789/web/');page.wait_for_function('window.Alpine && Alpine.$data(document.body).deals.length>400')
 page.get_by_role('button',name='Reportes',exact=True).click();assert page.get_by_text('El primer informe comienza en una oportunidad',exact=True).is_visible()
 page.evaluate("()=>{const a=Alpine.$data(document.body);a.openDeal(a.deals.find(d=>d.id==='977454ed-5ea1-4568-ac9d-300b4af6b5bc'));}")
 page.get_by_role('button',name='Analizar oportunidad',exact=True).first.click()
 page.wait_for_function("Alpine.$data(document.body).view==='reports' && Alpine.$data(document.body).selectedReport")
 assert writes==[{'dealId':report['deal_id']}]
 frame=page.frame_locator('iframe[title="Memorando de inversión"]')
 frame.get_by_label('Idioma / Language',exact=True).select_option('es')
 frame.get_by_role('heading',name='Deuda, efectivo y retorno del escenario',exact=True).wait_for()
 frame.get_by_label('Banco convencional (%)',exact=True).fill('50')
 assert '$750,000' in frame.locator('[data-lang="es"] [data-result="equity"]').inner_text()
 frame.get_by_label('Vendedor (%)',exact=True).fill('60');assert frame.locator('[data-lang="es"] [data-error]').is_visible()
 frame.get_by_label('Vendedor (%)',exact=True).fill('20');assert not frame.locator('[data-lang="es"] [data-error]').is_visible()
 page.get_by_label('Buscar reportes por compañía',exact=True).fill('missing-999');page.wait_for_timeout(80);assert page.evaluate('Alpine.$data(document.body).filteredReports.length')==0
 page.get_by_label('Buscar reportes por compañía',exact=True).fill('');page.get_by_label('Estado de reportes',exact=True).select_option('WV');assert page.evaluate('Alpine.$data(document.body).filteredReports.length')==1
 page.get_by_label('Indicador de reportes',exact=True).select_option('conflict');page.wait_for_timeout(80);assert page.evaluate('Alpine.$data(document.body).filteredReports.length')==0
 page.get_by_label('Indicador de reportes',exact=True).select_option('seller');page.wait_for_timeout(80);assert page.evaluate('Alpine.$data(document.body).filteredReports.length')==1
 for w in [390,768,1440]:
  page.set_viewport_size({'width':w,'height':1000});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),('library',w)
  assert frame.locator('html').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'),('report',w)
 assert not errors,errors
 # Opening the saved link loads a report directly, without the opportunity modal.
 data['investment_reports']=[report];page.reload();page.wait_for_function("Alpine.$data(document.body).selectedReport?.id===location.hash.split('=')[1]")
 assert page.evaluate('Alpine.$data(document.body).selectedDeal') is None
 print(json.dumps({'status':'PASS','analyze_to_report':True,'filters':True,'scenario':True,'deep_link':True,'widths':[390,768,1440],'js_errors':errors}));b.close()
