-- ============================================================================
-- S2.5 — Drop unique slot constraint (modelo gym multi-cupo)
-- ============================================================================
-- El constraint `reservas_unique_slot_per_recurso` venía del modelo EKKO donde
-- recurso.cupos=1 (1 estudio = 1 renta privada por slot). Para SALA gym, una
-- sala puede tener N personas en el mismo slot (clase grupal). Se relaja
-- ahora, como anticipaba el comentario original de la migración 100500.
--
-- TODO S4: cuando se introduzca `clases.cupo_max`, re-agregar un constraint
-- más sofisticado (CHECK count(reservas para esa clase) <= clase.cupo_max)
-- como trigger BEFORE INSERT, no como UNIQUE INDEX.
-- ============================================================================

DROP INDEX IF EXISTS reservas_unique_slot_per_recurso;
