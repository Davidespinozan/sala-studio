#!/usr/bin/env node
/**
 * Auditoría pre-transición: estado real de las membresías "activas" actuales.
 *
 * Pregunta concreta: las 8 filas que la migración 20260524100000 va a SALTEAR
 * por idempotencia ¿están sanas (fechas vigentes + FK denormalizado seteado)
 * o son zombies que la migración debería NORMALIZAR?
 *
 * Reporta para CADA usuario con membresia_tier IS NOT NULL:
 *   - usuario.id, email, tenant_id, membresia_tier slug, membresia_activa_id (FK)
 *   - todas las membresias del usuario: id, status, periodo_inicio, periodo_fin,
 *     creditos_restantes, tier_id, created_at
 *   - el tier que apunta el slug actual (para comparar tier_id si difieren)
 *   - diagnóstico: ¿activa vigente? ¿activa vencida? ¿FK roto? ¿sin membresía?
 *
 * SOLO LECTURA. No muta nada.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const ACTIVAS = new Set(['trialing', 'activa', 'past_due', 'congelada']);
const now = new Date();

// 1) Usuarios con membresia_tier seteado
const { data: usuarios, error: e1 } = await sb
  .from('usuarios')
  .select('id, email, tenant_id, rol, status, membresia_tier, membresia_activa_id, created_at')
  .not('membresia_tier', 'is', null)
  .order('created_at', { ascending: true });
if (e1) { console.error(e1); process.exit(1); }

console.log(`\nUsuarios con membresia_tier IS NOT NULL: ${usuarios.length}\n`);

// 2) Para cada uno: membresías + tier-por-slug
let saneados = 0, vencidos_o_zombie = 0, sin_membresia = 0, huerfanos = 0;
const ajustes = [];

for (const u of usuarios) {
  // tier resuelto por slug
  const { data: tierBySlug } = await sb
    .from('tiers')
    .select('id, slug, tipo, duracion_dias, clases_incluidas')
    .eq('tenant_id', u.tenant_id)
    .eq('slug', u.membresia_tier)
    .maybeSingle();

  // todas las membresías del usuario
  const { data: ms } = await sb
    .from('membresias')
    .select('id, status, periodo_actual_inicio, periodo_actual_fin, creditos_restantes, tier_id, created_at')
    .eq('usuario_id', u.id)
    .order('created_at', { ascending: false });

  const activas = (ms || []).filter((m) => ACTIVAS.has(m.status));
  const activa = activas[0] || null;

  let estado;
  if (!tierBySlug) {
    estado = 'HUÉRFANO (slug no matchea tier del tenant)';
    huerfanos++;
  } else if (!activa) {
    estado = 'SIN_MEMBRESIA → la migración creará una';
    sin_membresia++;
  } else {
    const fin = activa.periodo_actual_fin ? new Date(activa.periodo_actual_fin) : null;
    const fkOk = u.membresia_activa_id === activa.id;
    const vigente = !fin || fin > now;
    const tierMatch = activa.tier_id === tierBySlug.id;

    const problemas = [];
    if (!fkOk) problemas.push(`FK_ROTO (usuarios.membresia_activa_id=${u.membresia_activa_id})`);
    if (!vigente) problemas.push(`VENCIDA (fin=${activa.periodo_actual_fin})`);
    if (!fin) problemas.push('SIN_VENCIMIENTO (periodo_actual_fin=NULL)');
    if (!tierMatch) problemas.push(`TIER_DIFIERE (membresia.tier_id=${activa.tier_id} vs slug.tier_id=${tierBySlug.id})`);

    if (problemas.length === 0) {
      estado = 'SANA';
      saneados++;
    } else {
      estado = 'ZOMBIE: ' + problemas.join(', ');
      vencidos_o_zombie++;
      ajustes.push({ usuario: u.email, membresia_id: activa.id, problemas });
    }
  }

  console.log(`── ${u.email}  (tenant=${u.tenant_id.slice(0, 8)}…  rol=${u.rol}  status=${u.status})`);
  console.log(`   slug=${u.membresia_tier}  membresia_activa_id=${u.membresia_activa_id ?? 'NULL'}`);
  console.log(`   tier por slug: ${tierBySlug ? `${tierBySlug.id.slice(0,8)}… tipo=${tierBySlug.tipo} dur=${tierBySlug.duracion_dias} clases=${tierBySlug.clases_incluidas}` : 'NO EXISTE'}`);
  if ((ms || []).length === 0) {
    console.log(`   membresias: (ninguna)`);
  } else {
    for (const m of ms) {
      console.log(`   m=${m.id.slice(0,8)}…  status=${m.status}  inicio=${m.periodo_actual_inicio}  fin=${m.periodo_actual_fin}  creditos=${m.creditos_restantes}  tier_id=${m.tier_id.slice(0,8)}…  created=${m.created_at}`);
    }
  }
  console.log(`   → ${estado}\n`);
}

console.log('────────────────────────────────────────────────');
console.log(`RESUMEN:`);
console.log(`  sanas (saltear ok):                 ${saneados}`);
console.log(`  zombies (saltear deja al socio roto): ${vencidos_o_zombie}`);
console.log(`  sin membresía (la migración crea):  ${sin_membresia}`);
console.log(`  huérfanos (no migrar, reportar):    ${huerfanos}`);
console.log('────────────────────────────────────────────────');

if (ajustes.length) {
  console.log('\nZombies que la migración NO toca (saltea por status activo):');
  for (const a of ajustes) {
    console.log(`  ${a.usuario}  m=${a.membresia_id.slice(0,8)}…  → ${a.problemas.join(' | ')}`);
  }
}
