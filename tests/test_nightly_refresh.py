import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('nightly',Path(__file__).parents[1]/'cli/nightly_refresh.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NightlyTests(unittest.TestCase):
 def row(self,i=1):return dict(id=str(i),url=f'https://broker.example/listing/{i}/',title=f'Business {i}',asking_price=100000,cash_flow=30000,revenue=None,state='TX',first_seen='2026-10-15',last_seen='2026-10-15',vertical='hvac')
 def test_dates_and_profit(self):
  x=m.normalize(self.row());self.assertNotIn('published_at',x);self.assertNotIn('reported_sde',x);self.assertEqual(x['reported_cash_flow'],30000);self.assertIsNone(x['reported_revenue'])
 def test_bound_dedupe(self):
  batch,c=m.build_batch([self.row(i) for i in range(400)]+[self.row(1)],{'deals':[]});self.assertEqual(len(batch),150);self.assertEqual(c['normalized_rows'],400);self.assertEqual(c['coverage'],'partial')
 def test_manual_not_reimported(self):
  x=self.row();batch,_=m.build_batch([x],{'deals':[{'source_url':x['url'],'source':'manual'}]});self.assertEqual(batch,[])
 def test_invalid(self):
  x=self.row();x['url']='javascript:alert(1)';self.assertIsNone(m.normalize(x));self.assertIsNone(m.amount(True));self.assertIsNone(m.amount(-1));self.assertIsNone(m.amount('nan'))
 def test_preserves_crm(self):
  import copy
  row=self.row();current={'deals':[{'id':'saved','source':'dealledger','external_id':'1','source_url':row['url'],'pipeline_status':'EN_NEGOCIACION','notes':[{'text':'preserve'}]}]};before=copy.deepcopy(current);batch,c=m.build_batch([row],current);self.assertEqual(current,before);self.assertEqual(c['existing_checked'],1)
if __name__=='__main__':unittest.main()
