"""Free public broker intake + bounded direct revalidation. Explicitly reports blocked portals."""
import json,sys,uuid,re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urljoin,urlparse
from bs4 import BeautifulSoup
from revalidate_portals import fetch,parse_offer,check,ROOT
from nightly_refresh import get_json,request_json,API
from broker_sources import EXTRA_CATALOGS,discover as discover_specialist
CATALOGS=['https://www.bizbuysell.com/businesses-for-sale/','https://www.bizquest.com/businesses-for-sale/','https://www.baystatebusinessbrokers.com/businesses-for-sale-in-ma-nh-ct-ri/','https://advancedbb.com/listings/']
CATALOGS += EXTRA_CATALOGS
def discover(url,cap=12):
 if url in EXTRA_CATALOGS:return discover_specialist(url,cap=16)
 now=datetime.now(timezone.utc).isoformat();r=fetch(url);body=r.pop('body','');health={'url':url,'checked_at':now,'status':r['status'],'http_status':r['http_status'],'coverage':'partial'}
 if r['status']!='fetched':return [],health
 soup=BeautifulSoup(body,'html.parser');links={}
 for a in soup.select('a[href]'):
  href=urljoin(r['url'],a.get('href',''));title=a.get_text(' ',strip=True)
  if urlparse(href).hostname!=urlparse(r['url']).hostname:continue
  if not re.search(r'/(?:listing|listings|business-opportunity|business-for-sale)/[^/?]+',href):continue
  href=href.split('?')[0].rstrip('/')
  if len(title)>12 and title not in ('View Details','Read More'):links[href]=title[:500]
 rows=[]
 for href,title in list(links.items())[:cap]:
  response=fetch(href)
  if response['status']!='fetched':continue
  p=parse_offer(response.get('body',''),response['url'],title)
  if not p['match'] or p['withdrawn']:continue
  fields=p['fields'];full=p['text'];years=re.search(r'(?:established|founded|since)\s*:?\s*((?:19|20)\d{2})',full,re.I)
  if years:fields['years_operation']=max(0,datetime.now().year-int(years[1]))
  if re.search(r'seller financ|owner financ',full,re.I):fields['seller_financing']=True
  rows.append({'source_url':href,'title':title,'status':'published','checked_at':now,'fields':fields,'description':' '.join(full.split()[:130]),'method':'lectura pública directa del broker','business_type':'Sin categoría'})
 health['discovered']=len(links);health['observed']=len(rows);return rows,health

def publish(rows,health):
 if not rows:return []
 token=json.loads((ROOT/'.nightly.env.local').read_text())['SOURCE_SYNC_TOKEN'];acks=[]
 for start in range(0,len(rows),250):
  payload={'records':rows[start:start+250],'sources':health,'checked_at':datetime.now(timezone.utc).isoformat()}
  ack=request_json(API+'/portal-sync',payload,token)
  if not ack.get('ok'):raise RuntimeError('Sin confirmación de lote')
  acks.append(ack)
 return acks

def main():
 current=get_json(API+'/deals');health=[];rows=[];acks=[]
 def safe_discover(url):
  try:return discover(url)
  except Exception as e:return [],{'url':url,'status':'unavailable','error':type(e).__name__}
 with ThreadPoolExecutor(max_workers=4) as pool:
  for found,h in pool.map(safe_discover,CATALOGS):rows+=found;health.append(h)
 # Persist discovery first: a slow old source cannot erase the new intake.
 if '--apply' in sys.argv:acks+=publish(rows,health)
 observed={r['source_url'] for r in rows};candidates=[]
 if '--discover-only' not in sys.argv:
  candidates=[d for d in current['deals'] if (d.get('source')!='empire_flippers' or d.get('listing_evidence',{}).get('status')=='not_in_current_catalog') and d.get('source_url_kind')=='listing' and d.get('pipeline_status') not in ('CIERRE','DESCARTADO') and d.get('source_url') not in observed]
  candidates.sort(key=lambda d:d.get('revalidation',{}).get('checked_at',''))
 with ThreadPoolExecutor(max_workers=6) as pool:observations=list(pool.map(check,candidates[:200]))
 reviews=[]
 for d,r in zip(candidates[:200],observations):
  reviews.append({'deal_id':d['id'],'source_url':d['source_url'],'status':r['status'],'http_status':r.get('http_status'),'checked_at':r['checked_at'],'reason':r.get('reason',''),'fields':r.get('fields',{}),'description':' '.join(r.get('text','').split()[:130]) if r.get('match') else '', 'content_hash':r.get('content_hash'),'availability_confirmed':r.get('availability_confirmed',False),'status_evidence':r.get('status_evidence',[])})
 payload={'records':rows+reviews,'sources':health,'checked_at':datetime.now(timezone.utc).isoformat()};(ROOT/'.nightly/portal_last_attempt.json').write_text(json.dumps(payload))
 if '--apply' not in sys.argv:print(json.dumps({'dry_run':True,'records':len(rows+reviews),'sources':health}));return
 acks+=publish(reviews,health)
 result={'ok':True,'added':sum(a.get('added',0) for a in acks),'updated':sum(a.get('updated',0) for a in acks),'total':acks[-1].get('total') if acks else len(current['deals']),'records':len(rows+reviews),'batches':len(acks),'sources':health}
 (ROOT/'.nightly/portal_last_result.json').write_text(json.dumps(result));print(json.dumps(result))
if __name__=='__main__':main()
