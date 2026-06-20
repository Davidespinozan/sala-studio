// ════════════════════════════════════════════════════════════════════════════
// Crea en Stripe los 9 Prices del SaaS (3 tiers × 3 monedas), mensuales, con sus
// lookup_keys estables (sala_<tier>_<moneda>_mensual). Idempotente: si el
// lookup_key ya existe, lo salta. Un Product por tier; 3 Prices por Product.
//
// USO (modo test):
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-crear-precios-saas.mjs
//
// Para LIVE: misma corrida con sk_live_xxx (los lookup_keys son los mismos →
// el código de la app no cambia entre test y live).
//
// ⚠️ Espejo de src/shared/lib/planesSaas.ts (precios en unidades enteras de cada
//    moneda). Si cambian los precios allá, re-correr crea SOLO los que falten;
//    para CAMBIAR un precio existente hay que crear un Price nuevo y mover el
//    lookup_key (Stripe no edita el monto de un Price vivo).
// ════════════════════════════════════════════════════════════════════════════
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Falta STRIPE_SECRET_KEY. Uso: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-crear-precios-saas.mjs');
  process.exit(1);
}
const stripe = new Stripe(key);

const MODO = key.startsWith('sk_live') ? 'LIVE' : 'TEST';

// Espejo de planesSaas.ts — precios MENSUALES en unidades enteras.
const PLANES = {
  starter:  { nombre: 'SALA Starter',  precios: { mxn: 1900, usd: 129, eur: 119 } },
  pro:      { nombre: 'SALA Pro',      precios: { mxn: 3900, usd: 279, eur: 269 } },
  business: { nombre: 'SALA Business', precios: { mxn: 7900, usd: 549, eur: 499 } }
};
const MONEDAS = ['mxn', 'usd', 'eur'];

// Get-or-create del Product por metadata estable { app:'sala', tier }.
async function getOrCreateProduct(tier, nombre) {
  const found = await stripe.products.search({ query: `metadata['app']:'sala' AND metadata['tier']:'${tier}'`, limit: 1 });
  if (found.data[0]) return found.data[0];
  return stripe.products.create({ name: nombre, metadata: { app: 'sala', tier } });
}

async function main() {
  console.log(`\n▸ Creando precios del SaaS en Stripe (${MODO})…\n`);
  let creados = 0, saltados = 0;

  for (const [tier, plan] of Object.entries(PLANES)) {
    const product = await getOrCreateProduct(tier, plan.nombre);
    for (const moneda of MONEDAS) {
      const lookupKey = `sala_${tier}_${moneda}_mensual`;
      const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      if (existing.data[0]) {
        console.log(`  · ${lookupKey.padEnd(28)} ya existe (${existing.data[0].id})`);
        saltados++;
        continue;
      }
      const price = await stripe.prices.create({
        product: product.id,
        currency: moneda,
        unit_amount: plan.precios[moneda] * 100, // unidades → centavos
        recurring: { interval: 'month' },
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        metadata: { app: 'sala', tier, moneda, ciclo: 'mensual' }
      });
      console.log(`  ✓ ${lookupKey.padEnd(28)} creado (${price.id}) — ${plan.precios[moneda]} ${moneda.toUpperCase()}`);
      creados++;
    }
  }

  console.log(`\n✓ Listo (${MODO}): ${creados} creados, ${saltados} ya existían.\n`);
}

main().catch((e) => {
  console.error('\n✗ Error:', e.message, '\n');
  process.exit(1);
});
