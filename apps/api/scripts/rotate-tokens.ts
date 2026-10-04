/**
 * Re-encrypts every stored provider token under the active key.
 * Usage: add the new key as the first entry of TOKEN_ENCRYPTION_KEYS (keep the old one after it),
 * deploy, then run `node apps/api/scripts/rotate-tokens.ts`. Once it reports 0 stale tokens,
 * the old key can be removed.
 */
import { config } from '../src/config.ts';
import { decrypt, encrypt, isStale } from '../src/crypto.ts';
import { Store } from '../src/store.ts';

const store = new Store(config.dataFile);
let rotated = 0;
let failed = 0;
for (const c of store.data.connections) {
  if (!c.sealedToken || !isStale(c.sealedToken)) continue;
  try {
    c.sealedToken = encrypt(decrypt(c.sealedToken));
    rotated++;
  } catch (err) {
    failed++;
    console.error(`connection ${c.id}: ${(err as Error).message}`);
  }
}
store.flush();
const stale = store.data.connections.filter((c) => c.sealedToken && isStale(c.sealedToken)).length;
console.log(`rotated ${rotated}, failed ${failed}, still stale ${stale}`);
process.exit(failed ? 1 : 0);
