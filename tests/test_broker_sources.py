import sys,unittest,tempfile,json
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'cli'))
from broker_sources import us_location,category,offer,catalog_refs,STATES
from revalidate_portals import parse_offer
import portal_refresh
class BrokerSourceTests(unittest.TestCase):
 def test_us_not_foreign_or_broker_headquarters(self):
  self.assertEqual(len(STATES),51);self.assertEqual(us_location('Los Angeles County, CA, USA'),'CA');self.assertEqual(us_location('Arizona'),'AZ');self.assertEqual(us_location('Dallas, Texas'),'TX');self.assertIsNone(us_location('Singapore, Asia'));self.assertIsNone(us_location('Remote worldwide'));self.assertEqual(us_location('United States'),'')
 def test_money_does_not_read_manufacturing_as_millions(self):
  p=parse_offer('<h1>Precision Machine Shop</h1>Price: $14,900,000 Annual Revenue: $7,500,000 Net Cash Flow: $2,300,000 Manufacturing Arizona<h2>Listings You May Be Interested In</h2>Asking Price: $8,000,000','https://synergybb.com/listings/x/','Precision Machine Shop')
  self.assertEqual(p['fields']['asking_price'],14900000);self.assertEqual(p['fields']['reported_cash_flow'],2300000)
 def test_primary_location_and_publication_not_featured(self):
  html='<div><h1>Full-Service HVAC Company</h1><div>Los Angeles, CA, USA</div></div><p>Listing ID: 1 Listed On June 8, 2026 Status: ACTIVE Listing Type: Business For Sale Building &amp; Construction HVAC Businesses Price: $1,000,000 Gross Revenue: $1,273,079 Cash Flow: $219,001</p><h2>Contact Listing Owner</h2><a href="/search-results/location/FL/">Florida, USA</a>'
  with patch('broker_sources.OUT',Path(tempfile.gettempdir())):
   row,reason=offer(html,'https://www.biztrader.com/listing/x/',{'title':'Full-Service HVAC Company'})
  self.assertIsNone(reason);self.assertEqual(row['state'],'CA');self.assertEqual(row['business_type'],'HVAC');self.assertEqual(row['published_at'],'2026-06-08');self.assertEqual(row['fields']['reported_cash_flow'],219001)
 def test_pending_cards_never_discovered(self):
  card='<div itemtype="https://schema.org/ListItem"><meta itemprop="url" content="https://www.biztrader.com/listing/x/"><meta itemprop="name" content="HVAC Business">PENDING $300,000</div>'
  self.assertEqual(catalog_refs(card,'https://www.biztrader.com/listings/businesses-for-sale/service/'),[])
 def test_real_business_category(self):
  self.assertEqual(category('Precision Machine Shop','Manufacturing'),'Manufacturing');self.assertEqual(category('Industrial Air Cleaning','Building & Construction HVAC Businesses'),'HVAC');self.assertEqual(category('Dental Products Manufacturer','Manufacturing'),'Manufacturing');self.assertEqual(category('Accounting Firm','Services'),'Accounting')
 def test_ingestion_batches_250(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'.nightly.env.local').write_text('{"SOURCE_SYNC_TOKEN":"fixture"}');calls=[]
   def mocked(url,payload,token):calls.append(payload);return {'ok':True,'added':len(payload['records'])}
   with patch.object(portal_refresh,'ROOT',root),patch.object(portal_refresh,'request_json',mocked):acks=portal_refresh.publish([{'source_url':str(i)} for i in range(310)],[])
   self.assertEqual([len(x['records']) for x in calls],[250,60]);self.assertEqual(sum(a['added'] for a in acks),310)
if __name__=='__main__':unittest.main()
