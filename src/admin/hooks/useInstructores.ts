import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';

export type Instructor = Database['public']['Tables']['instructores']['Row'];

export interface InstructorFormData {
  nombre: string;
  bio: string | null;
  foto_url: string | null;
  especialidades: string[];
  activo: boolean;
}

/** Lista de instructores del tenant (admin ve activos + inactivos). */
export function useInstructores() {
  const tenant = useTenant();
  const [instructores, setInstructores] = useState<Instructor[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('instructores')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('orden', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[useInstructores]', error);
      setIsLoading(false);
      return;
    }
    setInstructores(data ?? []);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { instructores, isLoading, refetch };
}

export async function crearInstructor(
  tenantId: string,
  data: InstructorFormData
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('instructores')
    .insert({ tenant_id: tenantId, ...data });
  return { error: error?.message ?? null };
}

export async function actualizarInstructor(
  id: string,
  data: Partial<InstructorFormData>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('instructores').update(data).eq('id', id);
  return { error: error?.message ?? null };
}

export async function toggleActivoInstructor(
  id: string,
  activo: boolean
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('instructores').update({ activo }).eq('id', id);
  return { error: error?.message ?? null };
}
