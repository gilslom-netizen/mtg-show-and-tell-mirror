import { DRAFT_POOL } from '../src/engine/draft-pool.js';
import { oracleByName } from '../src/engine/oracle.js';
import { getScript } from '../src/engine/cards/index.js';
for (const name of DRAFT_POOL) {
  const c = oracleByName(name);
  if (getScript(c.oracleId)) continue;
  console.log(`### ${c.name} | ${c.manaCost ?? '-'} | ${c.typeLine} | ${c.power ?? ''}${c.power ? '/' : ''}${c.toughness ?? ''} | kw=[${c.keywords.join(',')}] | produced=[${c.producedMana.join(',')}]`);
  console.log(c.oracleText.split('\n').map((l) => '    ' + l).join('\n'));
}
