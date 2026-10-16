"""Free public broker intake + bounded direct revalidation. Explicitly reports blocked portals."""
import json,sys,uuid,re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urljoin,urlparse
from bs4 import BeautifulSoup
from revalidate_portals import fetch,parse_offer,check,ROOT
from nightly_refresh import get_json,request_json,API
CATALOGS=['https://www.bizbuysell.com/businesses-for-sale/','https://www.bizquest.com/businesses-for-sale/','https://www.baystatebusinessbrokers.com/businesses-for-sale-in-ma-nh-ct-ri/','https://advancedbb.com/listings/']
def discover(url,cap=12):
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

def main():
 current=get_json(API+'/deals');health=[];rows=[]
 for url in CATALOGS:
  try:found,h=discover(url);rows+=found;health.append(h)
  except Exception as e:health.append({'url':url,'status':'unavailable','error':str(e)[:100]})
 # Review every active individual listing nightly; blocked domains stop for the run.
 candidates=[d for d in current['deals'] if (d.get('source')!='empire_flippers' or d.get('listing_evidence',{}).get('status')=='not_in_current_catalog') and d.get('source_url_kind')=='listing' and d.get('pipeline_status') not in ('CIERRE','DESCARTADO')]
 candidates.sort(key=lambda d:d.get('revalidation',{}).get('checked_at',''))
 with ThreadPoolExecutor(max_workers=6) as pool:
  observations=list(pool.map(check,candidates[:200]))
 for d,r in zip(candidates[:200],observations):
  rows.append({'deal_id':d['id'],'source_url':d['source_url'],'status':r['status'],'http_status':r.get('http_status'),'checked_at':r['checked_at'],'reason':r.get('reason',''),'fields':r.get('fields',{}),'description':' '.join(r.get('text','').split()[:130]) if r.get('match') else '', 'content_hash':r.get('content_hash'),'availability_confirmed':r.get('availability_confirmed',False),'status_evidence':r.get('status_evidence',[])})
 payload={'records':rows,'sources':health,'checked_at':datetime.now(timezone.utc).isoformat()};(ROOT/'.nightly/portal_last_attempt.json').write_text(json.dumps(payload))
 if '--apply' not in sys.argv:print(json.dumps({'dry_run':True,'records':len(rows),'sources':health}));return
 token=json.loads((ROOT/'.nightly.env.local').read_text())['SOURCE_SYNC_TOKEN'];ack=request_json(API+'/portal-sync',payload,token);print(json.dumps(ack))
if __name__=='__main__':main()
