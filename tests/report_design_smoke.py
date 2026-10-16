from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:8789/.nightly/report-design-preview.html');page.get_by_label('Idioma / Language',exact=True).select_option('es');page.get_by_label('Tema / Theme',exact=True).select_option('light')
 assert page.get_by_role('heading',name='La tesis, en sus números',exact=True).is_visible()
 assert page.locator('[data-lang="es"] .exhibit .bar.company').count()==1
 for lang in ['es','en']:
  page.get_by_label('Idioma / Language',exact=True).select_option(lang)
  for theme in ['light','dark']:
   page.get_by_label('Tema / Theme',exact=True).select_option(theme)
   for width in [320,390,768,1440]:
    page.set_viewport_size({'width':width,'height':1000});page.wait_for_timeout(80)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(lang,theme,width)
    assert page.locator('[data-lang="'+lang+'"] h1').is_visible()
    if width<600:assert page.locator('[data-lang="'+lang+'"] input').first.evaluate('(e)=>parseFloat(getComputedStyle(e).fontSize)>=16')
 page.set_viewport_size({'width':390,'height':1000});page.get_by_label('Idioma / Language',exact=True).select_option('en');page.get_by_label('Conventional bank (%)',exact=True).fill('50')
 assert page.locator('[data-lang="en"] [data-result="equity"]').inner_text()=='$750,000'
 page.get_by_label('Idioma / Language',exact=True).select_option('es');assert page.get_by_label('Banco convencional (%)',exact=True).input_value()=='50';assert page.locator('[data-lang="es"] [data-result="equity"]').inner_text()=='$750,000'
 page.get_by_label('Vendedor (%)',exact=True).fill('60');assert page.locator('[data-lang="es"] [data-error]').is_visible();page.get_by_label('Vendedor (%)',exact=True).fill('20');assert not page.locator('[data-lang="es"] [data-error]').is_visible()
 page.get_by_label('Idioma / Language',exact=True).select_option('en');page.get_by_label('Tema / Theme',exact=True).select_option('dark');page.reload();assert page.locator('html').get_attribute('lang')=='en';assert page.locator('html').get_attribute('data-theme')=='dark'
 page.get_by_role('heading',name='Reported financials & cash quality',exact=True).wait_for()
 # Keyboard focus, reduced motion and 200% text enlargement with narrow reflow.
 page.keyboard.press('Tab');assert page.evaluate("getComputedStyle(document.activeElement).outlineStyle!=='none'")
 page.emulate_media(reduced_motion='reduce');assert page.locator('html').evaluate('(e)=>getComputedStyle(e).scrollBehavior')=='auto'
 page.add_style_tag(content='body{font-size:200%}');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
 # Theme token contrast, measured with WCAG relative luminance.
 contrast=page.evaluate('''()=>{let s=getComputedStyle(document.documentElement);const lum=h=>{let a=h.trim().replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*a[0]+.7152*a[1]+.0722*a[2]};let a=lum(s.getPropertyValue('--paper')),v=lum(s.getPropertyValue('--muted'));return (Math.max(a,v)+.05)/(Math.min(a,v)+.05)}''');assert contrast>=4.5,contrast
 assert not errors,errors
 print(json.dumps({'status':'PASS','languages':['es','en'],'themes':['light','dark'],'widths':[320,390,768,1440],'scenario_synced':True,'preferences_persist':True,'focus':True,'reduced_motion':True,'text_200_percent':True,'muted_dark_contrast':round(contrast,2),'js_errors':errors}));b.close()
