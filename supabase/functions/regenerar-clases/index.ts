// S4.3 — Edge Function: regenerar-clases
// ----------------------------------------------------------------------------
// Mantiene 60 días de lookhead de clases. Itera los tenants activos y llama a
// la función SQL idempotente generar_clases_recurrentes(tenant_id, 60).
//
// Pensada para correr cada noche vía pg_cron (ver migración
// 20260520120000_schedule_regenerar_clases.sql) y también invocable a mano
// para testing (ver README.md de esta carpeta).
//
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase automáticamente
// en el runtime de Edge Functions deployadas.
// ----------------------------------------------------------------------------

import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const startTime = Date.now();
  const resultado = {
    tenants_procesados: 0,
    total_clases_creadas: 0,
    errores: [] as Array<{ tenant: string; error: string }>
  };

  try {
    // Tenants activos. La tabla `tenants` usa la columna `status`, no `activo`.
    const { data: tenants, error: tenantsError } = await supabase
      .from('tenants')
      .select('id, slug, nombre')
      .eq('status', 'activo');

    if (tenantsError) throw tenantsError;

    for (const tenant of tenants ?? []) {
      try {
        // El parámetro de la función SQL es p_dias_forward (default 60).
        const { data, error } = await supabase.rpc('generar_clases_recurrentes', {
          p_tenant_id: tenant.id,
          p_dias_forward: 60
        });

        if (error) {
          resultado.errores.push({ tenant: tenant.slug, error: error.message });
          continue;
        }

        const stats = data as { clases_creadas: number };
        resultado.tenants_procesados++;
        resultado.total_clases_creadas += stats?.clases_creadas ?? 0;

        console.log(`[${tenant.slug}] ${stats?.clases_creadas ?? 0} clases creadas`);
      } catch (err) {
        resultado.errores.push({
          tenant: tenant.slug,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const duracionMs = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        ...resultado,
        duracion_ms: duracionMs,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        // 207 = éxito parcial (algún tenant falló pero otros siguieron).
        status: resultado.errores.length > 0 ? 207 : 200
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString()
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
