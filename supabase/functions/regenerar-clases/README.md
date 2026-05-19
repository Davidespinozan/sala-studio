# Edge Function: regenerar-clases

Mantiene 60 días de lookhead de clases. Itera los tenants activos y llama a la
función SQL idempotente `generar_clases_recurrentes(tenant_id, 60)` para cada uno.

Corre automáticamente cada noche a las **03:00 UTC** vía `pg_cron` (ver la
migración `supabase/migrations/20260520120000_schedule_regenerar_clases.sql`).

## Respuesta

```json
{
  "tenants_procesados": 1,
  "total_clases_creadas": 34,
  "errores": [],
  "duracion_ms": 412,
  "timestamp": "2026-05-21T03:00:01.123Z"
}
```

- `200` — todos los tenants OK.
- `207` — éxito parcial (algún tenant falló, los demás siguieron; ver `errores`).
- `500` — fallo total (ej. no se pudo leer la lista de tenants).

## Deploy (lo corre David desde la CLI de Supabase)

```bash
# 1. Login + link al proyecto (una sola vez)
supabase login
supabase link --project-ref omrlbvhbggnrwwzlgxji

# 2. Deployar la function
supabase functions deploy regenerar-clases

# 3. Aplicar la migración del cron
supabase db push
#   — o pegar el contenido de 20260520120000_schedule_regenerar_clases.sql
#     en el SQL Editor del dashboard.
```

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase automáticamente
en las Edge Functions deployadas — no hay que configurarlos a mano.

## Vault: secret para el cron (una sola vez)

El cron job arma el header `Authorization` leyendo el service_role_key desde
Supabase Vault. Agregalo una vez (SQL Editor del dashboard):

```sql
select vault.create_secret(
  'EL-SERVICE-ROLE-KEY-DEL-PROYECTO',
  'service_role_key',
  'Service role key usada por el cron regenerar-clases'
);
```

El service_role_key está en Dashboard → Project Settings → API → `service_role`.
Sin este secret, las corridas del cron devolverán 401 (la function igual se
puede invocar a mano con la key en el header — ver abajo).

## Trigger manual (testing)

```bash
curl -X POST \
  https://omrlbvhbggnrwwzlgxji.supabase.co/functions/v1/regenerar-clases \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Debería responder el JSON con `tenants_procesados`, `total_clases_creadas`, etc.
La función es idempotente (`generar_clases_recurrentes` usa `ON CONFLICT DO
NOTHING`), así que invocarla N veces no duplica clases — en una segunda corrida
seguida `total_clases_creadas` será 0.

## Logs

Dashboard → Edge Functions → `regenerar-clases` → Logs. Cada tenant procesado
emite un `console.log` con el conteo de clases creadas.

## Verificar / desprogramar el cron

```sql
-- Ver el job registrado
select jobname, schedule, active from cron.job where jobname = 'regenerar-clases-nightly';

-- Ver historial de corridas
select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'regenerar-clases-nightly')
order by start_time desc limit 10;

-- Desprogramar (si hiciera falta)
select cron.unschedule('regenerar-clases-nightly');
```
