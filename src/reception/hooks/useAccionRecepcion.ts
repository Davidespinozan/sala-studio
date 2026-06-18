import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { translateActionError } from '../lib/traducirErrorAccion';

interface UseAccionRecepcionOpts {
  rpcName: string;
  onSuccess?: () => Promise<void> | void;
}

/**
 * Llama un RPC de acción de recepción. Si el RPC falla, traduce el código con
 * translateActionError y RE-LANZA un Error con el mensaje en español — así el
 * AccionModal lo catchea y lo muestra inline. Si sale bien, corre onSuccess.
 */
export function useAccionRecepcion<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  opts: UseAccionRecepcionOpts
) {
  const [submitting, setSubmitting] = useState(false);

  async function ejecutar(args: TArgs): Promise<void> {
    setSubmitting(true);
    try {
      // rpcName es dinámico → casteamos para esquivar la unión tipada de rpc().
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        params?: Record<string, unknown>
      ) => Promise<{ error: { message: string } | null }>;

      const { error } = await rpc(opts.rpcName, args);
      if (error) throw new Error(translateActionError(error));
      if (opts.onSuccess) await opts.onSuccess();
    } finally {
      setSubmitting(false);
    }
  }

  return { ejecutar, submitting };
}
