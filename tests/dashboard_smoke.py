"""Read-only UI checks; review writes are intercepted, never sent to production."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
def main():
 with sync_playwright() as p:
  browser=p.chromium.launch();page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('http://127.0.0.1:8789/');page.wait_for_function("window.Alpine && Alpine.$data(document.body).deals.length>40")
  assert page.get_by_role('heading',name='El próximo negocio comienza aquí').is_visible()
  assert page.locator('.discovery-table tbody tr').count()<=25
  result=page.evaluate('''()=>{const a=Alpine.$data(document.body);const missing={asking_price:null,reported_sde:null,pipeline_status:'RADAR',pending_analysis:true};a.filters.priceBuckets=['p1'];const excludesMissing=!a.matchFilters(missing);a.resetFilters();a.compareIds=[];for(const d of a.deals.slice(0,5))a.toggleCompare(d.id);return {excludesMissing,compareLimit:a.compareIds.length};}''')
  assert result=={'excludesMissing':True,'compareLimit':4}
  page.get_by_role('searchbox',name='Buscar negocios').fill('no-such-target-99999');page.wait_for_timeout(250)
  assert page.get_by_text('Sin coincidencias con estos filtros').is_visible()
  page.get_by_role('button',name='Limpiar filtros',exact=True).click()
  page.get_by_role('textbox',name='Nombre de búsqueda').fill('QA temporal')
  page.get_by_role('button',name='Guardar filtros en este navegador').click()
  assert page.get_by_role('button',name='QA temporal',exact=True).is_visible()
  page.get_by_role('button',name='Eliminar búsqueda QA temporal').click()
  # Persisting a human score uses the existing Worker; intercept to avoid test writes.
  posts=[]
  page.route('**/update-deal',lambda route:(posts.append(route.request.post_data_json),route.fulfill(status=200,content_type='application/json',body='{"ok":true}'))[-1])
  page.get_by_role('button',name='Evaluar y definir acción',exact=True).first.click()
  assert page.get_by_role('button',name='Guardar evaluación compartida').is_visible()
  page.locator('.review-form select').first.select_option('4')
  page.locator('.review-form select').nth(1).select_option('finalista')
  page.locator('.review-form textarea').first.fill('QA: medir proceso antes de automatizar')
  page.get_by_role('button',name='Guardar evaluación compartida').click()
  page.wait_for_function("Alpine.$data(document.body).selectedDeal.review?.rating===4")
  assert posts[0]['review']['rating']==4 and posts[0]['review']['decision']=='finalista'
  page.evaluate('Alpine.$data(document.body).closeDeal()')
  # Responsive surfaces and one direct-source/detail record when present.
  for width in [390,768,1440]:
   page.set_viewport_size({'width':width,'height':1000})
   for view in ['discover','pipeline','category','compare','sources','glossary']:
    page.evaluate('(v)=>Alpine.$data(document.body).view=v',view);page.wait_for_timeout(80)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(width,view,'page overflow')
  page.evaluate("Alpine.$data(document.body).view='discover'")
  page.screenshot(path=str(ROOT/'.nightly/dashboard-desktop.png'))
  page.evaluate("()=>{const a=Alpine.$data(document.body);a.view='sources';}")
  assert page.get_by_role('heading',name='Un corte diario, con evidencia').is_visible()
  assert page.locator('a').filter(has_text='BizBuySell ↗').count()==1
  page.screenshot(path=str(ROOT/'.nightly/dashboard-sources.png'))
  assert not errors,sorted(set(errors))
  print(json.dumps({'status':'PASS','widths':[390,768,1440],'views':6,'missing_is_not_zero':True,'comparison_limit':4,'saved_searches':True,'shared_review_payload':True,'new_js_errors':errors}))
  browser.close()
if __name__=='__main__':main()
