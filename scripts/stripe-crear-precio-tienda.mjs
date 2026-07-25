// ════════════════════════════════════════════════════════════════════════════
// Crea en Stripe el Price del complemento TIENDA (POS + inventario).
// ----------------------------------------------------------------------------
// El complemento se cobra POR SUCURSAL: es un Price de $690/mes por UNIDAD, y en
// la suscripción del gym va con `quantity = número de sucursales activas`. Un
// gym de una sede paga 1×$690; una cadena de 3, 3×$690. Stripe prorratea solo
// cuando el gym abre o cierra una sede.
//
// Mismo patrón que los precios base: lookup_key estable para que el código de la
// app resuelva el price igual en test y en live. El del add-on es
// `sala_tienda_<moneda>` (sin ciclo: por ahora solo mensual).
//
// EL DESCUENTO NO VA ACÁ. numa (y cualquier trato) paga menos con un CUPÓN sobre
// este renglón, igual que su plan base. El precio de lista es uno solo: $690.
//
// USO:
//   STRIPE_SECRET_KEY=sk_test_xxx node scripts/stripe-crear-precio-tienda.mjs
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-crear-precio-tienda.mjs
//
// Idempotente: si el lookup_key ya existe, lo salta.
// ════════════════════════════════════════════════════════════════════════════
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Falta STRIPE_SECRET_KEY. Uso: STRIPE_SECRET_KEY=sk_... node scripts/stripe-crear-precio-tienda.mjs');
  process.exit(1);
}
const stripe = new Stripe(key);
const MODO = key.startsWith('sk_live') ? 'LIVE' : 'TEST';

// Precio de lista del complemento, por sucursal, en unidades enteras de cada
// moneda. numa arranca en MXN; USD/EUR quedan listos para cuando un gym de otro
// mercado lo active. Si cambian, re-correr crea solo los que falten (Stripe no
// edita el monto de un Price vivo: se crea uno nuevo y se mueve el lookup_key).
const PRECIOS = { mxn: 690, usd: 49, eur: 45 };

async function getOrCreateProduct() {
  const found = await stripe.products.search({
    query: `metadata['app']:'sala' AND metadata['addon']:'tienda'`,
    limit: 1
  });
  if (found.data[0]) return found.data[0];
  return stripe.products.create({
    name: 'SALA · Complemento Tienda',
    metadata: { app: 'sala', addon: 'tienda' }
  });
}

async function main() {
  console.log(`\n▸ Precio del complemento Tienda en Stripe (${MODO})…\n`);
  const product = await getOrCreateProduct();
  let creados = 0, saltados = 0;

  for (const moneda of Object.keys(PRECIOS)) {
    const lookupKey = `sala_tienda_${moneda}`;
    const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    if (existing.data[0]) {
      console.log(`  · ${lookupKey.padEnd(20)} ya existe (${existing.data[0].id})`);
      saltados++;
      continue;
    }
    const price = await stripe.prices.create({
      product: product.id,
      currency: moneda,
      unit_amount: PRECIOS[moneda] * 100, // unidades → centavos
      recurring: { interval: 'month' },
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      // El add-on se cobra por sucursal: la cantidad la pone la suscripción.
      metadata: { app: 'sala', addon: 'tienda', moneda, por: 'sucursal' }
    });
    console.log(`  ✓ ${lookupKey.padEnd(20)} creado (${price.id}) — ${PRECIOS[moneda]} ${moneda.toUpperCase()}/sucursal`);
    creados++;
  }

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`  creados: ${creados} · ya estaban: ${saltados}`);
  console.log(`  El código resuelve el add-on por lookup_key sala_tienda_<moneda>.`);
  console.log(`─────────────────────────────────────────────\n`);
}

main().catch((e) => {
  console.error('\n✖', e.message, '\n');
  process.exit(1);
});