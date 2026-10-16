"""Anonymous primary listings: Synergy + BizTrader; no accounts, NDA or paid API."""
import re,threading,hashlib
from datetime import datetime,timezone
from urllib.parse import urljoin,urlsplit
from bs4 import BeautifulSoup
from revalidate_portals import fetch,parse_offer,OUT
STATE_CODES='AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split()
STATE_NAMES='Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming'.split('|')
assert len(STATE_CODES)==len(STATE_NAMES)==51
STATES=dict(zip(STATE_CODES,STATE_NAMES));SEEN=set();LOCK=threading.Lock()
EXTRA_CATALOGS=['https://synergybb.com/search-results/','https://www.biztrader.com/listings/businesses-for-sale/building-construction/','https://www.biztrader.com/listings/businesses-for-sale/service/','https://www.biztrader.com/listings/businesses-for-sale/manufacturing/','https://www.biztrader.com/listings/businesses-for-sale/medical-health-fitness/','https://www.biztrader.com/listings/businesses-for-sale/online-technology/','https://www.biztrader.com/listings/businesses-for-sale/wholesale-distributor/']

def us_location(text):
 if re.search(r'\b(Canada|Europe|Asia|Africa|Singapore|Philippines|Turkey|Hong Kong|United Kingdom|Australia|New Zealand)\b',text,re.I):return None
 for code,name in sorted(STATES.items(),key=lambda x:-len(x[1])):
  if re.search(r'\b'+re.escape(name)+r'\b',text,re.I) or re.search(r'\b'+code+r'\b',text):return code
 if re.search(r'\b(USA|United States|U\.S\.|New England|Midwest|Northeast|Mid Atlantic)\b',text,re.I):return ''
 return None

def category(title,source_category):
 t=title.lower()
 for label,pattern in [('HVAC',r'\bhvac\b'),('Plumbing',r'plumbing'),('Accounting',r'accounting'),('Cleaning Services',r'cleaning services'),('Laundromat',r'laundromat'),('Dental Practice',r'dental practices?')]:
  if re.search(pattern,source_category,re.I):return label
 for label in ['Manufacturing','Distribution','Transportation']:
  if re.search(r'\b'+label+r'\b',source_category,re.I):return label
 rules=[('HVAC',r'hvac|heating|air.condition|radiant|hydronic'),('Plumbing',r'plumb'),('Electrical',r'electrical|electrician'),('Cleaning Services',r'cleaning|janitorial|remediation|abatement|restoration'),('Landscaping',r'landscap|lawn care'),('Pest Control',r'pest control'),('Pool Service',r'pool service'),('Accounting',r'accounting|bookkeeping|cpa firm|tax practice'),('Insurance Agency',r'insurance agency|insurance brokerage'),('Staffing',r'staffing|recruit'),('Dental Practice',r'dental|dentist'),('Veterinary',r'veterinary|veterinarian'),('Home Healthcare',r'home.health|home care'),('Med Spa',r'med.?spa|medical spa'),('Medical Practice',r'clinic|medical practice|physician|orthopedic|pain management|health practice'),('Auto Repair',r'auto repair|automotive repair|collision|body shop'),('Laundromat',r'laundromat|laundry|wash.and.fold'),('Restaurant',r'restaurant|cafe|bakery|pizzeria|bar and grill'),('Salon',r'salon|barber|beauty'),('Digital Marketing Agency',r'digital marketing|seo |advertising agency'),('SaaS',r'\bsaas\b|software platform|software.as.a.service'),('E-commerce',r'e.?commerce|amazon fba|\bd2c\b|\bdtc\b'),('Manufacturing',r'manufactur|machine shop|machining|fabricat'),('Construction',r'construction|contractor|renovation|roofing|solar installation'),('Transportation',r'trucking|transportation|freight|logistics'),('Consulting',r'consulting')]
 for label,pattern in rules:
  if re.search(pattern,t):return label
 lookup={'Health Care':'Medical Practice','Manufacturing':'Manufacturing','Distribution':'Distribution','Construction':'Construction','Transportation':'Transportation','Technology':'Technology','Services':'Business Services','Medical, Health, & Fitness':'Healthcare','Online & Technology':'Technology','Wholesale & Distributor':'Distribution','Service Businesses':'Business Services','Building & Construction':'Construction'}
 return next((v for k,v in lookup.items() if k.lower() in source_category.lower()),'Sin categoría')

def catalog_refs(body,url):
 soup=BeautifulSoup(body,'html.parser');refs={}
 if urlsplit(url).hostname=='synergybb.com':
  for a in soup.select('a[href]'):
   link=urljoin(url,a['href']);title=a.get_text(' ',strip=True)
   if re.fullmatch(r'https://synergybb.com/listings/[^/?]+/?',link) and len(title)>12:refs[link]={'title':title,'source_url':link}
 else:
  for card in soup.select('div[itemtype="https://schema.org/ListItem"]'):
   meta=card.select_one('meta[itemprop="url"]');name=card.select_one('meta[itemprop="name"]')
   if not meta or not name:continue
   link=meta.get('content','');title=name.get('content','')
   if not re.fullmatch(r'https://www.biztrader.com/listing/[^/?]+/?',link):continue
   text=card.get_text(' ',strip=True)
   if not re.match(r'ACTIVE\b',text):continue
   location=card.select_one('a[href*="/search-results/location/"]')
   refs[link]={'title':title,'source_url':link,'location':location.get_text(' ',strip=True) if location else ''}
 return list(refs.values())

def offer(body,url,reference):
 parsed=parse_offer(body,url,reference['title'])
 if not parsed['match'] or parsed['withdrawn'] or re.search(r'\b(?:under contract|under loi|sale pending)\b',parsed['text'][:700],re.I):return None,'identity_or_unavailable'
 soup=BeautifulSoup(body,'html.parser');h=soup.select_one('h1');title=h.get_text(' ',strip=True) if h else reference['title']
 if urlsplit(url).hostname=='synergybb.com':
  location=soup.select_one('i.icon-location-pin');location=location.parent.get_text(' ',strip=True) if location else ''
  tags=soup.select_one('.sale-list-category');source_category=tags.get_text(' ',strip=True) if tags else ''
 else:
  location=h.find_next_sibling('div') if h else None
  location=location.get_text(' ',strip=True) if location else reference.get('location','')
  category_match=re.search(r'Listing Type\s*:\s*Business For Sale\s*(.*?)\s+Price\s*:',parsed['text'],re.I)
  source_category=category_match[1] if category_match else ''
  # Require the primary listing's status, not a featured sidebar's ACTIVE badge.
  if not re.search(r'Status\s*:\s*ACTIVE\b',parsed['text'],re.I):return None,'not_active'
  if not re.search(r'Listing Type\s*:\s*Business For Sale',parsed['text'],re.I):return None,'non_business'
 state=us_location(location)
 if state is None:return None,'outside_us_or_unknown_location'
 fields=parsed['fields'];text=parsed['text'];year=re.search(r'(?:Year Established\s*:?\s*|Established\s*:?\s*)((?:19|20)\d{2})\b',text,re.I)
 if year:fields['years_operation']=max(0,datetime.now(timezone.utc).year-int(year[1]))
 if re.search(r'(?:seller|owner) financ',text,re.I) and not re.search(r'(?:no|not offering) (?:seller|owner) financ',text,re.I):fields['seller_financing']=True
 kind=category(title,source_category);stamp=datetime.now(timezone.utc).isoformat();row={'source_url':url,'title':title,'status':'published','checked_at':stamp,'http_status':200,'fields':fields,'description':text[:2800],'business_type':kind,'source_category':source_category[:300],'category_method':'categoría del portal y reglas explícitas sobre el título','state':state,'city':'','location_label':location[:160],'method':'ficha individual pública '+urlsplit(url).hostname,'evidence':'Ficha individual coincidente publicada en el portal; cifras declaradas y alcance preliminar.'}
 published=re.search(r'Listed On\s+([A-Z][a-z]+ \d{1,2}, \d{4})',text)
 if published:
  try:row.update(published_at=datetime.strptime(published[1],'%B %d, %Y').date().isoformat(),publication_evidence='Ficha del portal: Listed On '+published[1])
  except ValueError:pass
 OUT.mkdir(parents=True,exist_ok=True);digest=hashlib.sha256(body.encode()).hexdigest();(OUT/(digest+'.html')).write_text(body);row['content_hash']=digest
 return row,None

def discover(url,cap=16):
 now=datetime.now(timezone.utc).isoformat();r=fetch(url);body=r.pop('body','');health={'url':url,'checked_at':now,'status':r['status'],'http_status':r.get('http_status'),'coverage':'partial','daily_detail_limit':cap}
 if r['status']!='fetched':return [],health
 refs=catalog_refs(body,url);health['discovered']=len(refs);rows=[];rejected={}
 if refs:
  day=int((datetime.now(timezone.utc).timestamp()-5*3600)//86400);offset=(day*cap)%len(refs);refs=(refs[offset:]+refs[:offset])[:cap]
 for ref in refs:
  with LOCK:
   if ref['source_url'] in SEEN:continue
   SEEN.add(ref['source_url'])
  r=fetch(ref['source_url']);body=r.pop('body','')
  if r['status']!='fetched':rejected[r['status']]=rejected.get(r['status'],0)+1;continue
  row,reason=offer(body,ref['source_url'],ref)
  if row:rows.append(row)
  else:rejected[reason]=rejected.get(reason,0)+1
 health.update(observed=len(rows),rejected=rejected);return rows,health
