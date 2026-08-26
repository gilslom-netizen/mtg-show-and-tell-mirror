import { oracleByName } from '../src/engine/oracle.js';
const names = ['Chrome Mox','Cavern of Souls','Birds of Paradise','Mox Emerald','Watery Grave','Island','Mistrise Village','Narset, Parter of Veils','Tamiyo, Inquisitive Student'];
for (const n of names) {
  const c = oracleByName(n);
  console.log(n.padEnd(28), ('produced=['+c.producedMana.join(',')+']').padEnd(24), 'loyalty='+(c.loyalty??'-'), c.faces ? 'faces='+c.faces.map(f=>f.loyalty??'-').join('/') : '');
}
