"""Daily bounded open-data import. No LLM, scraping, broker contact, or pipeline moves."""
import argparse
from collections import Counter
import hashlib
import html
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]
RUNTIME=ROOT/'.nightly'
FEED='https://raw.githubusercontent.com/jeffsosville/dealledger/main/data/public/listings.json'
META='https://raw.githubusercontent.com/jeffsosville/dealledger/main/data/public/meta.json'
API='https://bizacq-api.clawddma.workers.dev'
MAX_NEW=150
STATES=set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())
CATEGORIES={'hvac':'HVAC','plumbing':'Plumbing','landscaping':'Landscaping','cleaning':'Cleaning Services','restaurant':'Restaurant','ecommerce':'E-commerce','saas':'SaaS','auto_repair':'Auto Repair','dental':'Dental Practice','med_spa':'Med Spa','insurance':'Insurance Agency','accounting':'Accounting','manufacturing':'Manufacturing','retail':'Retail','home_services':'Home Services'}

def request_json(url, payload=None, token=None):
    import subprocess
    settings=['url = '+json.dumps(url),'header = "Accept: application/json"']
    if payload is not None:settings+=['header = "Content-Type: application/json"','data = '+json.dumps(json.dumps(payload))]
    if token:settings+=['header = '+json.dumps('Authorization: Bearer '+token)]
    for attempt in range(3):
        result=subprocess.run(['/usr/bin/curl','--silent','--show-error','--max-time','45','--config','-','--write-out','\n%{http_code}'],input='\n'.join(settings),capture_output=True,text=True,timeout=55)
        body,_,status=result.stdout.rpartition('\n')
        if not result.returncode and status.isdigit() and 200<=int(status)<300:
            if len(body)>30_000_000:raise ValueError('fuente excede 30 MB')
            return json.loads(body)
        if status not in ('502','503','504') or attempt==2:raise RuntimeError('HTTP '+(status or 'sin respuesta')+' · curl '+str(result.returncode))
        time.sleep(2**attempt)

def get_json(url):return request_json(url)

def bogota_day(value):
    try:
        parsed=datetime.fromisoformat(str(value).replace('Z','+00:00'))
        if parsed.tzinfo is None:return None
        return int((parsed.timestamp()-5*3600)//86400)
    except (ValueError,TypeError):return None

def current_receipt(receipt,day):
    run=receipt.get('run',{})
    return receipt.get('bogota_day')==day and run.get('status')=='success' and bogota_day(run.get('started_at'))==day


def canonical(url):
    from urllib.parse import urlsplit,urlunsplit
    p=urlsplit(str(url or ''))
    if p.scheme!='https' or not p.netloc or p.username or p.password:return None
    return urlunsplit(('https',p.netloc.lower(),p.path.rstrip('/'),p.query,''))

def amount(value):
    if value is None or value=='':return None
    if isinstance(value,bool):return None
    try:
        v=float(value)
        return v if 0<=v<1e12 else None
    except (ValueError,TypeError):return None

def normalize(row):
    url=canonical(row.get('url')); title=html.unescape(re.sub('<[^>]+>',' ',str(row.get('title') or ''))).strip()
    # Explicit directory pages cannot become individual acquisition targets.
    if not url or not title or not row.get('id') or re.search(r'^(businesses for sale|florida businesses for sale|our listings|search results)(?:\s|$)',title,re.I):return None
    raw_state=str(row.get('state') or '').strip()
    code=raw_state if raw_state in STATES else ''
    if not code:
        found=re.findall(r'\b[A-Z]{2}\b',raw_state)
        code=next((v for v in reversed(found) if v in STATES),'')
    return dict(external_id=str(row['id']),title=title[:500],source_url=url,state=code,city=str(row.get('city') or '')[:100],business_type=CATEGORIES.get(row.get('vertical'),str(row.get('vertical') or 'Sin categoría').replace('_',' ').title()),asking_price=amount(row.get('asking_price')),reported_revenue=amount(row.get('revenue')),reported_cash_flow=amount(row.get('cash_flow')),raw_description=html.unescape(re.sub('<[^>]+>',' ',str(row.get('description') or '')))[:2000],first_seen_at=row.get('first_seen'),last_seen_at=row.get('last_seen'),broker=row.get('broker_name') or '')

def build_batch(rows,current):
    existing={canonical(d.get('source_url')) for d in current.get('deals',[])}
    own={d.get('external_id') for d in current.get('deals',[]) if d.get('source')=='dealledger'}
    items={}
    quarantine=Counter()
    title_counts=Counter(str(r.get('title') or '').strip().casefold() for r in {canonical(v.get('url')):v for v in rows}.values())
    for raw in rows:
        title=str(raw.get('title') or '').strip()
        url=str(raw.get('url') or '')
        if title_counts[title.casefold()]>1:
            quarantine['duplicate_title']+=1;continue
        if re.search(r'^(what |how |why |tips |guide |available for acquisition|commercial routes for sale)|\b(sold|closing table|blog|news|businesses for sale -)\b',title,re.I):
            quarantine['editorial_or_generic']+=1;continue
        if not re.search(r'/(?:listing|listings|business-for-sale|businesses-for-sale|business-opportunity|businesses|our-listings|business-details|opportunity|opportunities|buy-a-business)/[^/?]+',url,re.I) and not re.search(r'[-/]\d{4,}(?:/|$)|[?&](?:id|listing)=',url,re.I):
            quarantine['listing_url_structure']+=1;continue
        row=normalize(raw)
        if row and row['state']:
            if row['source_url'] in items:quarantine['duplicate_url']+=1
            else:items[row['source_url']]=row
        else:quarantine['invalid_or_unknown_state']+=1
    observed=list(items.values())
    updates=[r for r in observed if r['external_id'] in own]
    # A batch has 250 records maximum. Rotate checks by oldest import; new intake
    # is capped at 150 per day, with no budget exclusion. Scope is explicit in UI.
    old_import={d.get('external_id'):d.get('source_imported_at','') for d in current.get('deals',[]) if d.get('source')=='dealledger'}
    updates.sort(key=lambda r:old_import.get(r['external_id'],''))
    new=[r for r in observed if r['source_url'] not in existing and r['external_id'] not in own]
    new.sort(key=lambda r:(str(r['first_seen_at'] or ''),str(r['last_seen_at'] or '')),reverse=True)
    selected_new=new[:MAX_NEW]
    batch=updates[:250-len(selected_new)]+selected_new
    return batch,dict(feed_rows=len(rows),normalized_rows=len(observed),new_candidates=len(new),new_selected=len(selected_new),existing_checked=len(updates[:250-len(selected_new)]),not_in_batch=max(0,len(observed)-len(batch)),coverage='partial',daily_new_limit=MAX_NEW,batch_limit=250,quarantined=sum(quarantine.values()),quarantine_reasons=dict(quarantine))

def fetch_empire():
    envelope=get_json('https://api.empireflippers.com/api/v1/listings/list?page=1&listing_status=For%20Sale')
    data=envelope.get('data',{})
    if envelope.get('errors') or not isinstance(data.get('listings'),list):raise ValueError('respuesta Empire Flippers inválida')
    pages=min(int(data.get('pages') or 1),10)
    all_rows=list(data['listings'])
    for page in range(2,pages+1):
        time.sleep(1.1)
        extra=get_json('https://api.empireflippers.com/api/v1/listings/list?page='+str(page)+'&listing_status=For%20Sale')
        if extra.get('errors') or not isinstance(extra.get('data',{}).get('listings'),list):raise ValueError('página incompleta de Empire Flippers')
        all_rows.extend(extra['data']['listings'])
    listings=[]
    for r in all_rows:
        if r.get('country')!='US' or r.get('listing_status')!='For Sale':continue
        number=r.get('listing_number')
        if not isinstance(number,int):continue
        monetizations=r.get('monetizations') or []
        text=json.dumps(monetizations).lower()
        category='SaaS' if 'saas' in text else 'E-commerce' if any(k in text for k in ['amazon','ecommerce','e-commerce','shopify']) else 'Digital Business'
        listings.append(dict(source='empire_flippers',external_id=str(r['id']),source_url=f'https://empireflippers.com/listing/{number}/',title=str(r.get('public_title') or 'Negocio digital')[:500],state='',city='',business_type=category,asking_price=amount(r.get('listing_price')),reported_revenue=amount(r.get('average_annual_gross_revenue')),reported_net_profit=amount(r.get('average_annual_net_profit')),reported_cash_flow=None,raw_description=str(r.get('summary') or '')[:2000],first_seen_at=None,last_seen_at=None,published_at=r.get('first_listed_at'),operating_metrics={k:r.get(k) for k in ['first_made_money_at','hours_worked_per_week','net_profit_trend_percent','net_profit_trend_percent_months','mrr','churn_percent','gross_revenue_trend_percent'] if r.get(k) is not None},broker='Empire Flippers'))
    return listings,dict(source='empire_flippers',status='success',page=pages,pages=data.get('pages'),catalog_count=data.get('count'),us_records=len(listings),coverage='complete' if pages==int(data.get('pages') or 1) else 'partial')

def main():
    args=argparse.ArgumentParser();args.add_argument('--apply',action='store_true');args.add_argument('--force',action='store_true');args.add_argument('--fixture',type=Path);args.add_argument('--empire-only',action='store_true');opt=args.parse_args()
    if opt.fixture and opt.apply:raise ValueError('Las fixtures solo admiten dry-run')
    RUNTIME.mkdir(exist_ok=True,mode=0o700)
    import fcntl
    with open(RUNTIME/'refresh.lock','w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:print('skip: ejecución en curso');return 0
        now=datetime.now(timezone.utc);stamp=now.isoformat();day=(now.timestamp()-5*3600)//86400
        receipt=RUNTIME/'last_success.json'
        if not opt.force and receipt.exists() and current_receipt(json.loads(receipt.read_text()),day):print('skip: corte del día ya publicado');return 0
        run=dict(id=str(uuid.uuid4()),source='dealledger',started_at=stamp,finished_at=stamp,status='success',source_url=FEED)
        try:
            current=get_json(API+'/deals')
            prior_path=RUNTIME/'last_attempt.json'
            if not opt.force and prior_path.exists():
                prior=json.loads(prior_path.read_text()).get('run',{})
                if prior.get('status')=='success' and bogota_day(prior.get('started_at'))==day and current.get('refresh',{}).get('last_run',{}).get('id')==prior.get('id'):
                    receipt.write_text(json.dumps(dict(bogota_day=day,run=prior,total_verified=len(current['deals']),recovered=True)))
                    print(json.dumps({'status':'recovered','total_verified':len(current['deals']),'run_id':prior['id']}));return 0

            rows=json.loads(opt.fixture.read_text()) if opt.fixture else get_json(FEED)
            if not isinstance(rows,list) or len(rows)<10:raise ValueError('fuente vacía o incompleta')
            normalized,coverage=build_batch(rows,current)
            raw_ids={str(r.get('id')) for r in rows}
            run['absent_from_feed']=sum(1 for d in current['deals'] if d.get('source')=='dealledger' and d.get('external_id') not in raw_ids)
            run.update(coverage)
            latest_seen=max((str(r.get('last_seen') or '') for r in rows),default='')
            latest_date=datetime.fromisoformat(latest_seen.replace('Z','+00:00')) if latest_seen else None
            source_stale=not latest_date or (now-latest_date).total_seconds()>72*3600
            run['sources']=[dict(source='dealledger',status='stale' if source_stale else 'success',last_observed_at=latest_seen,feed_rows=len(rows),normalized_rows=coverage['normalized_rows'],error='Exportación con más de 72 horas: nuevas incorporaciones suspendidas.' if source_stale else '')]
            if source_stale and not opt.fixture:normalized=[]
            if not opt.fixture:
                try:
                    official,health=fetch_empire()
                    if health.get('coverage')=='complete':run['primary_listing_urls']=[r['source_url'] for r in official]
                    run['sources'].append(health)
                    current_urls={canonical(d.get('source_url')) for d in current['deals']}
                    official_new=[r for r in official if canonical(r['source_url']) not in current_urls]
                    official_existing=[r for r in official if canonical(r['source_url']) in current_urls]
                    dl_new=[r for r in normalized if canonical(r['source_url']) not in current_urls]
                    dl_existing=[r for r in normalized if canonical(r['source_url']) in current_urls]
                    new_rows=(official_new+([] if opt.empire_only else dl_new))[:MAX_NEW]
                    old_rows=(official_existing+([] if opt.empire_only else dl_existing))[:250-len(new_rows)]
                    normalized=old_rows+new_rows
                    run.update(source='empire_flippers' if opt.empire_only else 'open_sources',new_selected=len(new_rows),existing_checked=len(old_rows))
                except Exception as exc:
                    run['sources'].append(dict(source='empire_flippers',status='error',error=type(exc).__name__+': '+str(exc)[:120]))
                    if opt.empire_only:raise
            if not any(h.get('status')=='success' for h in run['sources']):raise ValueError('Ninguna fuente actual disponible; se conserva el inventario')
            if not normalized and not any(d.get('source') in ('dealledger','empire_flippers') for d in current['deals']):raise ValueError('sin anuncios válidos')
        except Exception as exc:
            normalized=[];run.update(status='error',error=type(exc).__name__+': '+str(exc)[:180],coverage='none')
        run['finished_at']=datetime.now(timezone.utc).isoformat()
        payload={'run':run,'listings':normalized}
        (RUNTIME/'last_attempt.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2))
        if not opt.apply:print(json.dumps({'dry_run':True,'run':run,'batch_count':len(normalized)},ensure_ascii=False));return 0 if run['status']=='success' else 1
        env_path=ROOT/'.nightly.env.local'
        token=json.loads(env_path.read_text())['SOURCE_SYNC_TOKEN']
        ack=request_json(API+'/source-sync',payload,token)
        if not ack.get('ok') or ack.get('run_id')!=run['id']:raise ValueError('Worker no confirmó el lote')
        # Verify persisted run, identifiers and counts independently from the POST.
        persisted=get_json(API+'/deals')
        if persisted.get('refresh',{}).get('last_run',{}).get('id')!=run['id']:raise ValueError('lectura posterior no coincide')
        out=dict(bogota_day=day,run=run,ack=ack,total_verified=len(persisted['deals']))
        (RUNTIME/'last_result.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
        if run['status']=='success':receipt.write_text(json.dumps(out,ensure_ascii=False,indent=2))
        if run['status']=='success' and not opt.empire_only:
            import subprocess
            try:
                result=subprocess.run([sys.executable,str(ROOT/'cli/portal_refresh.py'),'--apply'],timeout=600,capture_output=True,text=True)
                print(result.stdout.strip() if result.returncode==0 else 'portal_refresh: comprobar registro de intento; se conservó la actualización oficial')
            except subprocess.TimeoutExpired:
                (RUNTIME/'portal_error.json').write_text(json.dumps({'status':'timeout','checked_at':datetime.now(timezone.utc).isoformat()}))
                print('portal_refresh: tiempo agotado; actualización oficial conservada')
        print(json.dumps({'status':run['status'],'added':ack.get('added'),'updated':ack.get('updated'),'total_verified':len(persisted['deals']),'run_id':run['id']},ensure_ascii=False))
        return 0 if run['status']=='success' else 1
if __name__=='__main__':sys.exit(main())
