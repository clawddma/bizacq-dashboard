"""Bounded primary-source observations. Never mutates CRM decisions or treats blocks as sales."""
import concurrent.futures,hashlib,json,re,subprocess,threading,time,html
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlparse,urljoin
from bs4 import BeautifulSoup
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.nightly/revalidation'
LOCKS={};LAST={};BLOCKED=set();GUARD=threading.Lock()
STOP=set('the a an and or for sale business businesses with in of to on by for is this established profitable turnkey company llc inc'.split())
def tokens(s):return set(re.findall(r'[a-z0-9]+',s.lower()))-STOP

def fetch(url):
 host=urlparse(url).hostname
 if not host or urlparse(url).scheme!='https' or host in ('localhost','127.0.0.1'):raise ValueError('public https required')
 with GUARD:lock=LOCKS.setdefault(host,threading.Lock())
 with lock:
  if host in BLOCKED:return {'status':'blocked_source','http_status':None,'url':url}
  time.sleep(max(0,2-(time.monotonic()-LAST.get(host,0))))
  r=subprocess.run(['curl','-L','--silent','--show-error','--max-time','18','--max-redirs','4','--max-filesize','3000000','--write-out','\n%{http_code}\n%{url_effective}',url],capture_output=True,text=True,timeout=23)
  LAST[host]=time.monotonic();body,_,tail=r.stdout.rpartition('\n');body,_,status=body.rpartition('\n')
  code=int(status) if status.isdigit() else 0
  if code in (403,429):BLOCKED.add(host)
  return {'status':'fetched' if code==200 and not r.returncode else 'blocked' if code in (403,429) else 'not_found' if code in (404,410) else 'unavailable','http_status':code,'url':tail or url,'body':body}

def parse_offer(body,url,title=''):
 soup=BeautifulSoup(body,'html.parser')
 for x in soup(['script','style','nav','footer','header']):x.decompose()
 headings=[x.get_text(' ',strip=True) for x in (soup.select('h1') or soup.select('h2'))][:6]
 text=soup.get_text(' ',strip=True);text=re.sub(r'\s+',' ',text)
 if headings and headings[0] in text:text=text[text.index(headings[0]):]
 canonical=soup.find('link',rel='canonical');canon=urljoin(url,canonical.get('href','')) if canonical else url
 target=tokens(title);overlap=max([len(target&tokens(h))/max(1,len(target)) for h in headings]+[0])
 strong=bool(target and overlap>=0.50)
 # Related listings and navigation cannot establish availability of this business.
 listing_text=re.split(r'you may also be interested|related listings|similar businesses|other listings|listings you may be interested|listing broker|contact listing owner',text,flags=re.I)[0]
 markers=re.findall(r'(?:listing status\s*:?\s*(?:sold|withdrawn|off.market|no longer available)|(?:business|company) (?:has been |was |is )?(?:sold|no longer available)|this (?:listing|business) is no longer available|status\s*:?\s*(?:sold|withdrawn|off.market|no longer available))',listing_text,re.I)
 withdrawn=strong and bool(markers)
 availability='sold' if withdrawn and any(re.search(r'\bsold\b',v,re.I) for v in markers) else 'withdrawn' if withdrawn else None
 pending=strong and bool(re.search(r'\b(?:under contract|under (?:an? )?LOI|sale pending|status\s*:\s*pending)\b',listing_text[:1500],re.I))
 fields={}
 patterns={'asking_price':r'(?:asking price|sale price|business price|\bprice)\s*:?\s*\$\s*([0-9]+(?:,\s*[0-9]{3})*(?:\.[0-9]+)?)(?:\s*([MK])\b)?','reported_revenue':r'(?:gross revenue|annual revenue|annual sales|gross sales)\s*:?\s*\$\s*([0-9]+(?:,\s*[0-9]{3})*(?:\.[0-9]+)?)(?:\s*([MK])\b)?','reported_cash_flow':r'(?:(?:net\s+)?cash\s*flow(?:\s*\(SDE\))?|seller.s discretionary earnings|SDE)\s*:?\s*\$\s*([0-9]+(?:,\s*[0-9]{3})*(?:\.[0-9]+)?)(?:\s*([MK])\b)?'}
 for k,p in patterns.items():
  m=re.search(p,listing_text,re.I)
  if m:fields[k]=float(m[1].replace(',','').replace(' ',''))*({'M':1e6,'K':1e3}.get((m[2] or '').upper(),1))
 return {'match':strong,'title_overlap':round(overlap,3),'headings':headings[:4],'canonical':canon,'text':listing_text[:30000],'fields':fields,'withdrawn':withdrawn,'pending':pending,'availability':availability,'status_evidence':markers[:3]}

def check(d):
 now=datetime.now(timezone.utc).isoformat();base={'deal_id':d['id'],'source_url':d.get('source_url'),'checked_at':now}
 if d.get('source')=='empire_flippers' and d.get('listing_evidence',{}).get('status')!='not_in_current_catalog':return {**base,'status':'official_catalog_pending'}
 if d.get('revalidation',{}).get('status')=='non_operating_asset':return {**base,'status':'non_operating_asset','reason':d['revalidation'].get('reason','Ficha de inmueble, sin empresa operativa identificada.')}
 if d.get('source_url_kind')!='listing':return {**base,'status':'identity_unresolved','reason':'El enlace original es de categoría, no identifica una oferta. No se sustituye por otro negocio de nombre parecido.'}
 try:
  r=fetch(d['source_url']);body=r.pop('body','');base.update(r)
  if r['status']!='fetched':return base
  h=hashlib.sha256(body.encode()).hexdigest();OUT.mkdir(parents=True,exist_ok=True);(OUT/(h+'.html')).write_text(body)
  p=parse_offer(body,r['url'],d['title']);base.update(p);base['content_hash']=h
  base['availability_confirmed']=bool(p['match'] and p['withdrawn']);base['status']=p['availability'] if p['withdrawn'] else 'unavailable' if p['pending'] else 'published' if p['match'] and (p['fields'] or re.search(r'(?:asking|price|inquire|request information|financial information)',p['text'],re.I)) else 'identity_unresolved'
  return base
 except Exception as e:return {**base,'status':'unavailable','reason':type(e).__name__+': '+str(e)[:120]}

def main():
 import argparse
 ap=argparse.ArgumentParser();ap.add_argument('--input',type=Path,default=ROOT/'data/deals.json');args=ap.parse_args();data=json.loads(args.input.read_text());pending=[d for d in data['deals'] if d.get('screening',{}).get('disposition')=='revalidate'];OUT.mkdir(parents=True,exist_ok=True)
 results=[]
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
  for result in pool.map(check,pending):results.append(result)
 report={'checked_at':datetime.now(timezone.utc).isoformat(),'requested':len(pending),'summary':dict(Counter(r['status'] for r in results)),'results':results}
 (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='results'}))
if __name__=='__main__':main()
