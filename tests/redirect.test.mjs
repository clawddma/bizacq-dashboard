import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
for(const [search,hash]of [['',''],['','#deal=34712d1a-da24-4651-823f-11fa85b1300d'],['?release=old','#deal=570f0ced-c7a0-4247-82c5-e41e865e00d6']]){
 let result;new Function('window','URL',script)({location:{search,hash,replace:url=>result=url}},URL);
 assert.equal(result,'https://bizacq-radar.danielmesar959464.chatgpt.site/'+search+hash);
}
assert.ok(!html.includes('Alpine'));console.log('PASS: one destination, replace semantics, preserved query and every business fragment');
