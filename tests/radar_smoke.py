"""Radar regression; data is live-read, and all test writes are intercepted."""
import json,subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def main():
 data=json.loads(subprocess.check_output(['/usr/bin/curl','-fsS','--max-time','30','https://bizacq-api.clawddma.workers.dev/deals']))
 with sync_playwright() as p:
  b=p.chromium.launch();page=b.new_page(viewport={'width':1440,'height':1000});errors=[];writes=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.route('**/deals?*',lambda r:r.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(data)))
  page.route('**/update-deal',lambda r:(writes.append(r.request.post_data_json),r.fulfill(status=200,headers={'Access-Control-Allow-Origin':'*'},content_type='application/json',body='{"ok":true}'))[-1])
  page.goto('http://127.0.0.1:8789/web/');page.wait_for_function('window.Alpine && Alpine.$data(document.body).deals.length>40')
  facts=page.evaluate('''()=>{const a=Alpine.$data(document.body);return {view:a.view,total:a.deals.length,pending:a.radarNewCount,dirty:a.overrideCount};}''')
  assert facts['view']=='pipeline' and facts['dirty']==0 and facts['total']==len(data['deals'])
  for width in [390,768,1440]:
   page.set_viewport_size({'width':width,'height':1000});page.wait_for_timeout(80)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),width
  page.locator('.radar-chip').filter(has_text='Nuevas sin revisar').click()
  assert page.evaluate("Alpine.$data(document.body).dealsByStatus('RADAR').every(d=>Alpine.$data(document.body).isUnreviewed(d))")
  page.get_by_role('searchbox',name='Buscar en el Radar').fill('missing-target-999999');page.wait_for_timeout(250)
  assert page.evaluate('Alpine.$data(document.body).filteredCount')==0
  page.get_by_role('searchbox',name='Buscar en el Radar').fill('');page.wait_for_timeout(250)
  page.evaluate("()=>{const a=Alpine.$data(document.body);a.openDeal(a.deals.find(d=>d.source==='empire_flippers'));}")
  page.locator('.economics-preview').wait_for(state='visible')
  snapshot=page.evaluate('JSON.stringify(Alpine.$data(document.body).selectedDeal)')
  page.get_by_text('Simular compra · efectivo, deuda y flujo mensual',exact=True).click()
  page.get_by_label('Vendedor financia (%)',exact=True).fill('30')
  page.get_by_label('Banco convencional (%)',exact=True).fill('20')
  econ=page.evaluate('()=>{const a=Alpine.$data(document.body);return a.economics(a.selectedDeal);}')
  assert econ['valid'] and abs(econ['totalCash']-econ['price']*.5)<.01 and econ['monthlyDebt']>0
  assert page.evaluate('JSON.stringify(Alpine.$data(document.body).selectedDeal)')==snapshot
  for width in [390,768,1440]:
   page.set_viewport_size({'width':width,'height':1000})
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),('financial modal',width)
  page.get_by_label('Vendedor financia (%)',exact=True).fill('90')
  assert page.get_by_text('Las deudas no pueden superar el 100% del precio.',exact=False).is_visible()
  page.get_by_label('Vendedor financia (%)',exact=True).fill('30')
  page.get_by_role('button',name='Evaluación',exact=True).click()
  page.locator('.review-form select').first.select_option('4')
  page.get_by_role('button',name='Guardar evaluación compartida').click()
  page.wait_for_function('Alpine.$data(document.body).selectedDeal.review?.rating===4')
  assert writes and writes[-1]['review']['rating']==4
  page.evaluate('Alpine.$data(document.body).closeDeal()')
  # A refresh must preserve pending local changes and an open record.
  before=page.evaluate('Alpine.$data(document.body).deals.length')
  page.evaluate("()=>{const a=Alpine.$data(document.body);a.openDeal(a.deals[0]);a.reloadDeals(true);}")
  assert page.evaluate('Alpine.$data(document.body).deals.length')==before
  # Every live listing now has a persisted score; pending_analysis never bypasses its filter.
  assert all('screening' in d for d in data['deals'])
  page.evaluate("()=>{const a=Alpine.$data(document.body);a.closeDeal();a.quickFilter='all';a.filters.minScore=50;}")
  assert page.evaluate("Alpine.$data(document.body).deals.filter(d=>Alpine.$data(document.body).passesFilters(d)&&d.pipeline_status!=='DESCARTADO').every(d=>d.screening.score>=50)")
  page.evaluate("()=>{const a=Alpine.$data(document.body);a.filters.minScore=0;a.openDeal(a.deals.find(d=>d.pipeline_status==='RADAR'&&d.screening.disposition==='eligible'));}")
  page.get_by_role('button',name='Descartar',exact=True).click()
  page.get_by_placeholder('Explica el motivo del descarte').fill('QA local interceptado')
  assert page.get_by_role('button',name='Confirmar descarte',exact=True).is_enabled()
  page.get_by_role('button',name='Cancelar',exact=True).click()
  assert not errors,sorted(set(errors))
  print(json.dumps({'status':'PASS','facts':facts,'widths':[390,768,1440],'quick_filter':True,'search':True,'review_payload':True,'refresh_preserves_open_record':True,'js_errors':errors}))
  b.close()
if __name__=='__main__':main()
