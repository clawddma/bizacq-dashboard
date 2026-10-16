"""Copy only the canonical UI into the existing Sites deployment checkout."""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
site=root/'.sites/bizacq'
manifest=json.loads((site/'.openai/hosting.json').read_text())
if manifest.get('project_id')!='appgprj_6ad1171d12448191b52a7a3eec965ddd':raise SystemExit('Identidad de Sites no coincide; no se preparó el paquete.')
(site/'dist').mkdir(exist_ok=True)
for name in ('index.html','economics.js'):
    (site/'dist'/name).write_bytes((root/'web'/name).read_bytes())
print('Interfaz única web/ preparada; fuente de datos y credenciales no se copian.')
