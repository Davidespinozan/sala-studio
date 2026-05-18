export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      membresias: {
        Row: {
          cancelada_at: string | null
          cancelada_efectiva_at: string | null
          commitment_ends_at: string | null
          created_at: string
          id: string
          periodo_actual_fin: string | null
          periodo_actual_inicio: string | null
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          tenant_id: string
          tier_id: string
          trial_ends_at: string | null
          trial_starts_at: string | null
          updated_at: string
          usuario_id: string
        }
        Insert: {
          cancelada_at?: string | null
          cancelada_efectiva_at?: string | null
          commitment_ends_at?: string | null
          created_at?: string
          id?: string
          periodo_actual_fin?: string | null
          periodo_actual_inicio?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id: string
          tier_id: string
          trial_ends_at?: string | null
          trial_starts_at?: string | null
          updated_at?: string
          usuario_id: string
        }
        Update: {
          cancelada_at?: string | null
          cancelada_efectiva_at?: string | null
          commitment_ends_at?: string | null
          created_at?: string
          id?: string
          periodo_actual_fin?: string | null
          periodo_actual_inicio?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string
          tier_id?: string
          trial_ends_at?: string | null
          trial_starts_at?: string | null
          updated_at?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "membresias_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membresias_tier_id_fkey"
            columns: ["tier_id"]
            isOneToOne: false
            referencedRelation: "tiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "membresias_usuario_id_fkey"
            columns: ["usuario_id"]
            isOneToOne: false
            referencedRelation: "usuarios"
            referencedColumns: ["id"]
          },
        ]
      }
      notificaciones: {
        Row: {
          creada_at: string
          id: string
          leida: boolean
          leida_at: string | null
          mensaje: string
          metadata: Json | null
          tenant_id: string
          tipo: string
          titulo: string
          usuario_id: string
        }
        Insert: {
          creada_at?: string
          id?: string
          leida?: boolean
          leida_at?: string | null
          mensaje: string
          metadata?: Json | null
          tenant_id: string
          tipo: string
          titulo: string
          usuario_id: string
        }
        Update: {
          creada_at?: string
          id?: string
          leida?: boolean
          leida_at?: string | null
          mensaje?: string
          metadata?: Json | null
          tenant_id?: string
          tipo?: string
          titulo?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notificaciones_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notificaciones_usuario_id_fkey"
            columns: ["usuario_id"]
            isOneToOne: false
            referencedRelation: "usuarios"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_events: {
        Row: {
          created_at: string
          id: string
          membresia_id: string | null
          moneda: string | null
          monto_centavos: number | null
          processed_at: string | null
          processing_error: string | null
          raw_payload: Json
          status: string | null
          stripe_customer_id: string | null
          stripe_event_id: string
          stripe_event_type: string
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          stripe_subscription_id: string | null
          tenant_id: string | null
          usuario_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          membresia_id?: string | null
          moneda?: string | null
          monto_centavos?: number | null
          processed_at?: string | null
          processing_error?: string | null
          raw_payload: Json
          status?: string | null
          stripe_customer_id?: string | null
          stripe_event_id: string
          stripe_event_type: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string | null
          usuario_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          membresia_id?: string | null
          moneda?: string | null
          monto_centavos?: number | null
          processed_at?: string | null
          processing_error?: string | null
          raw_payload?: Json
          status?: string | null
          stripe_customer_id?: string | null
          stripe_event_id?: string
          stripe_event_type?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string | null
          usuario_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_events_membresia_id_fkey"
            columns: ["membresia_id"]
            isOneToOne: false
            referencedRelation: "membresias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_events_usuario_id_fkey"
            columns: ["usuario_id"]
            isOneToOne: false
            referencedRelation: "usuarios"
            referencedColumns: ["id"]
          },
        ]
      }
      recursos: {
        Row: {
          activo: boolean
          capacidad_personas: number | null
          created_at: string
          cupos: number
          descripcion: string | null
          equipo_incluido: string[] | null
          estilo_visual: string | null
          foto_url: string | null
          fotos_urls: string[]
          horarios: Json
          id: string
          nombre: string
          orden: number
          slug: string
          tenant_id: string
          tiers_permitidos: string[]
          tipo: string
          tipo_contenido: string[] | null
          updated_at: string
          video_url: string | null
        }
        Insert: {
          activo?: boolean
          capacidad_personas?: number | null
          created_at?: string
          cupos?: number
          descripcion?: string | null
          equipo_incluido?: string[] | null
          estilo_visual?: string | null
          foto_url?: string | null
          fotos_urls?: string[]
          horarios?: Json
          id?: string
          nombre: string
          orden?: number
          slug: string
          tenant_id: string
          tiers_permitidos?: string[]
          tipo?: string
          tipo_contenido?: string[] | null
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          activo?: boolean
          capacidad_personas?: number | null
          created_at?: string
          cupos?: number
          descripcion?: string | null
          equipo_incluido?: string[] | null
          estilo_visual?: string | null
          foto_url?: string | null
          fotos_urls?: string[]
          horarios?: Json
          id?: string
          nombre?: string
          orden?: number
          slug?: string
          tenant_id?: string
          tiers_permitidos?: string[]
          tipo?: string
          tipo_contenido?: string[] | null
          updated_at?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recursos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      reservas: {
        Row: {
          cancelacion_notificada_at: string | null
          cancelada_at: string | null
          cancelada_motivo: string | null
          cancelada_por: string | null
          check_in_at: string | null
          check_in_by: string | null
          check_in_method: string | null
          created_at: string
          duracion_min: number
          folio: string
          id: string
          invitados_count: number
          notas: string | null
          qr_token_hash: string | null
          recurso_id: string
          slot_fin: string
          slot_inicio: string
          status: string
          tenant_id: string
          updated_at: string
          usuario_id: string
        }
        Insert: {
          cancelacion_notificada_at?: string | null
          cancelada_at?: string | null
          cancelada_motivo?: string | null
          cancelada_por?: string | null
          check_in_at?: string | null
          check_in_by?: string | null
          check_in_method?: string | null
          created_at?: string
          duracion_min: number
          folio: string
          id?: string
          invitados_count?: number
          notas?: string | null
          qr_token_hash?: string | null
          recurso_id: string
          slot_fin: string
          slot_inicio: string
          status?: string
          tenant_id: string
          updated_at?: string
          usuario_id: string
        }
        Update: {
          cancelacion_notificada_at?: string | null
          cancelada_at?: string | null
          cancelada_motivo?: string | null
          cancelada_por?: string | null
          check_in_at?: string | null
          check_in_by?: string | null
          check_in_method?: string | null
          created_at?: string
          duracion_min?: number
          folio?: string
          id?: string
          invitados_count?: number
          notas?: string | null
          qr_token_hash?: string | null
          recurso_id?: string
          slot_fin?: string
          slot_inicio?: string
          status?: string
          tenant_id?: string
          updated_at?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservas_cancelada_por_fkey"
            columns: ["cancelada_por"]
            isOneToOne: false
            referencedRelation: "usuarios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservas_check_in_by_fkey"
            columns: ["check_in_by"]
            isOneToOne: false
            referencedRelation: "usuarios"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservas_recurso_id_fkey"
            columns: ["recurso_id"]
            isOneToOne: false
            referencedRelation: "recursos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservas_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservas_usuario_id_fkey"
            columns: ["usuario_id"]
            isOneToOne: false
            referencedRelation: "usuarios"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          branding: Json
          config: Json
          created_at: string
          dominio_app: string | null
          dominio_principal: string | null
          id: string
          nombre: string
          slug: string
          status: string
          stripe_account_id: string | null
          stripe_subscription_product_id: string | null
          updated_at: string
          vertical: string
        }
        Insert: {
          branding?: Json
          config?: Json
          created_at?: string
          dominio_app?: string | null
          dominio_principal?: string | null
          id?: string
          nombre: string
          slug: string
          status?: string
          stripe_account_id?: string | null
          stripe_subscription_product_id?: string | null
          updated_at?: string
          vertical?: string
        }
        Update: {
          branding?: Json
          config?: Json
          created_at?: string
          dominio_app?: string | null
          dominio_principal?: string | null
          id?: string
          nombre?: string
          slug?: string
          status?: string
          stripe_account_id?: string | null
          stripe_subscription_product_id?: string | null
          updated_at?: string
          vertical?: string
        }
        Relationships: []
      }
      tiers: {
        Row: {
          activo: boolean
          beneficios: Json
          created_at: string
          descripcion: string | null
          id: string
          moneda: string
          nombre: string
          orden: number
          periodo: string
          precio_centavos: number
          reglas: Json
          slug: string
          stripe_price_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          activo?: boolean
          beneficios?: Json
          created_at?: string
          descripcion?: string | null
          id?: string
          moneda?: string
          nombre: string
          orden?: number
          periodo?: string
          precio_centavos: number
          reglas?: Json
          slug: string
          stripe_price_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          activo?: boolean
          beneficios?: Json
          created_at?: string
          descripcion?: string | null
          id?: string
          moneda?: string
          nombre?: string
          orden?: number
          periodo?: string
          precio_centavos?: number
          reglas?: Json
          slug?: string
          stripe_price_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tiers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      usuarios: {
        Row: {
          auth_id: string | null
          avatar_url: string | null
          bloqueado_hasta: string | null
          commitment_ends_at: string | null
          created_at: string
          email: string
          id: string
          invitado: boolean
          membresia_activa_id: string | null
          membresia_tier: string | null
          no_shows_count: number
          nombre: string | null
          notas_admin: string | null
          ob_data: Json | null
          rol: string
          status: string
          stripe_customer_id: string | null
          telefono: string | null
          tenant_id: string
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          auth_id?: string | null
          avatar_url?: string | null
          bloqueado_hasta?: string | null
          commitment_ends_at?: string | null
          created_at?: string
          email: string
          id?: string
          invitado?: boolean
          membresia_activa_id?: string | null
          membresia_tier?: string | null
          no_shows_count?: number
          nombre?: string | null
          notas_admin?: string | null
          ob_data?: Json | null
          rol?: string
          status?: string
          stripe_customer_id?: string | null
          telefono?: string | null
          tenant_id: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          auth_id?: string | null
          avatar_url?: string | null
          bloqueado_hasta?: string | null
          commitment_ends_at?: string | null
          created_at?: string
          email?: string
          id?: string
          invitado?: boolean
          membresia_activa_id?: string | null
          membresia_tier?: string | null
          no_shows_count?: number
          nombre?: string | null
          notas_admin?: string | null
          ob_data?: Json | null
          rol?: string
          status?: string
          stripe_customer_id?: string | null
          telefono?: string | null
          tenant_id?: string
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "usuarios_membresia_activa_fk"
            columns: ["membresia_activa_id"]
            isOneToOne: false
            referencedRelation: "membresias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usuarios_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancelar_reserva_atomic: {
        Args: { p_motivo?: string; p_reserva_id: string }
        Returns: {
          cancelacion_notificada_at: string | null
          cancelada_at: string | null
          cancelada_motivo: string | null
          cancelada_por: string | null
          check_in_at: string | null
          check_in_by: string | null
          check_in_method: string | null
          created_at: string
          duracion_min: number
          folio: string
          id: string
          invitados_count: number
          notas: string | null
          qr_token_hash: string | null
          recurso_id: string
          slot_fin: string
          slot_inicio: string
          status: string
          tenant_id: string
          updated_at: string
          usuario_id: string
        }
        SetofOptions: {
          from: "*"
          to: "reservas"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      check_in_atomic: { Args: { p_reserva_id: string }; Returns: Json }
      check_in_manual_atomic: {
        Args: { p_motivo?: string; p_reserva_id: string }
        Returns: Json
      }
      count_active_admins: { Args: { p_tenant_id: string }; Returns: number }
      count_admins_activos: { Args: { p_tenant_id: string }; Returns: number }
      count_miembros_tier: { Args: { p_tier_id: string }; Returns: number }
      count_reservas_recurso: {
        Args: { p_recurso_id: string }
        Returns: number
      }
      dev_activar_miembro: {
        Args: { p_email: string; p_tier?: string }
        Returns: {
          auth_id: string | null
          avatar_url: string | null
          bloqueado_hasta: string | null
          commitment_ends_at: string | null
          created_at: string
          email: string
          id: string
          invitado: boolean
          membresia_activa_id: string | null
          membresia_tier: string | null
          no_shows_count: number
          nombre: string | null
          notas_admin: string | null
          ob_data: Json | null
          rol: string
          status: string
          stripe_customer_id: string | null
          telefono: string | null
          tenant_id: string
          trial_ends_at: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "usuarios"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_my_rol: { Args: never; Returns: string }
      get_my_tenant_id: { Args: never; Returns: string }
      get_my_user_id: { Args: never; Returns: string }
      is_admin: { Args: never; Returns: boolean }
      is_recepcionista: { Args: never; Returns: boolean }
      marcar_no_shows: { Args: never; Returns: Json }
      max_invitados_por_tier: { Args: { p_tier: string }; Returns: number }
      reservar_recurso_atomic: {
        Args: {
          p_duracion_min: number
          p_invitados?: number
          p_notas?: string
          p_recurso_id: string
          p_slot_inicio: string
        }
        Returns: Json
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
