import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'cli'))
from revalidate_portals import parse_offer
class PortalTests(unittest.TestCase):
 def test_numbers_and_identity(self):
  p=parse_offer('<h1>HVAC Services Houston</h1><p>Asking Price: $300,000 Gross Revenue: $1, 379, 642 Cash Flow: $207, 482</p>','https://example.com/listing/1','HVAC Services Houston')
  self.assertTrue(p['match']);self.assertEqual(p['fields']['reported_revenue'],1379642);self.assertEqual(p['fields']['reported_cash_flow'],207482)
 def test_related_does_not_verify(self):
  p=parse_offer('<h1>Other Store</h1><h2>HVAC Services Houston</h2><p>Asking Price: $300,000</p>','https://example.com/listing/1','HVAC Services Houston');self.assertFalse(p['match'])
 def test_sold_not_navigation(self):
  p=parse_offer('<nav>Sold businesses</nav><h1>HVAC Services Houston</h1><p>For sale</p>','https://example.com/listing/1','HVAC Services Houston');self.assertFalse(p['withdrawn'])
 def test_sold_status_is_explicit(self):
  p=parse_offer('<h1>Vehicle Wrapping Business</h1><p>Status: Sold</p>','https://example.com/listing/1','Vehicle Wrapping Business');self.assertTrue(p['withdrawn']);self.assertEqual(p['availability'],'sold')
 def test_related_sold_is_not_subject(self):
  p=parse_offer('<h1>Vehicle Wrapping Business</h1><p>Asking price: $100,000</p><h2>You may also be interested</h2><p>Status: Sold</p>','https://example.com/listing/1','Vehicle Wrapping Business');self.assertFalse(p['withdrawn'])
if __name__=='__main__':unittest.main()
