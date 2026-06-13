import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isAdminPreview, latchAdminPreview } from '@shared/lib/adminPreview';

/**
 * true si el admin está en modo "VER COMO…" (URL ?demo=admin-preview o sticky de
 * la pestaña). Persiste el flag en cuanto lo ve, así sobrevive a las
 * navegaciones internas que no arrastran el query param. Ver shared/lib/adminPreview.
 */
export function useAdminPreview(): boolean {
  const [searchParams] = useSearchParams();
  useEffect(() => {
    latchAdminPreview(searchParams);
  }, [searchParams]);
  return isAdminPreview(searchParams);
}
