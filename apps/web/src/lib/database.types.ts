
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "app": {
          Tables: {
            "item_balances": {
                  Row: {
                    "avg_cost": number,"has_uncovered_deficit": boolean,"item_id": string,"last_occurred_at": string | null,"on_hand_qty": number,"on_hand_value": number
                  }
                  ComputedFields: never
                  Insert: {
                    "avg_cost"?: number,"has_uncovered_deficit"?: boolean,"item_id": string,"last_occurred_at"?: string | null,"on_hand_qty"?: number,"on_hand_value"?: number
                  }
                  Update: {
                    "avg_cost"?: number,"has_uncovered_deficit"?: boolean,"item_id"?: string,"last_occurred_at"?: string | null,"on_hand_qty"?: number,"on_hand_value"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "item_balances_item_id_fkey"
      columns: ["item_id"]
isOneToOne: true
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                },"item_unit_conversions": {
                  Row: {
                    "factor_to_base": number,"item_id": string,"unit": string
                  }
                  ComputedFields: never
                  Insert: {
                    "factor_to_base": number,"item_id": string,"unit": string
                  }
                  Update: {
                    "factor_to_base"?: number,"item_id"?: string,"unit"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "item_unit_conversions_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                },"owner": {
                  Row: {
                    "created_at": string,"id": boolean,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: boolean,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: boolean,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"pos_order_lines": {
                  Row: {
                    "item_id": string,"item_name": string | null,"line_id": string,"line_total": number,"options": NonNullable<Json>,"order_id": string,"price_per_kg": number | null,"quantity": number,"size_name": string | null,"unit_price": number | null,"weighted_qty": number | null,"weighted_unit": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "item_id": string,"item_name"?: string | null,"line_id": string,"line_total": number,"options"?: NonNullable<Json>,"order_id": string,"price_per_kg"?: number | null,"quantity": number,"size_name"?: string | null,"unit_price"?: number | null,"weighted_qty"?: number | null,"weighted_unit"?: string | null
                  }
                  Update: {
                    "item_id"?: string,"item_name"?: string | null,"line_id"?: string,"line_total"?: number,"options"?: NonNullable<Json>,"order_id"?: string,"price_per_kg"?: number | null,"quantity"?: number,"size_name"?: string | null,"unit_price"?: number | null,"weighted_qty"?: number | null,"weighted_unit"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_order_lines_order_id_fkey"
      columns: ["order_id"]
isOneToOne: false
      referencedRelation: "pos_orders"
      referencedColumns: ["id"]
    }
                  ]
                },"pos_orders": {
                  Row: {
                    "content_hash": string,"delivery_fee": number,"discount": number,"financial_revision": number | null,"first_synced_at": string,"id": string,"last_financial_operation_key": string | null,"last_synced_at": string,"missing_from_pos": boolean,"order_number": number | null,"order_type": string | null,"ordered_at": string,"payment_type": string | null,"pos_update_time": string,"service_tax": number,"shift_id": string,"status": string,"subtotal": number,"tax": number,"total": number,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "content_hash": string,"delivery_fee": number,"discount": number,"financial_revision"?: number | null,"first_synced_at"?: string,"id": string,"last_financial_operation_key"?: string | null,"last_synced_at"?: string,"missing_from_pos"?: boolean,"order_number"?: number | null,"order_type"?: string | null,"ordered_at": string,"payment_type"?: string | null,"pos_update_time": string,"service_tax": number,"shift_id": string,"status": string,"subtotal": number,"tax": number,"total": number,"version"?: number
                  }
                  Update: {
                    "content_hash"?: string,"delivery_fee"?: number,"discount"?: number,"financial_revision"?: number | null,"first_synced_at"?: string,"id"?: string,"last_financial_operation_key"?: string | null,"last_synced_at"?: string,"missing_from_pos"?: boolean,"order_number"?: number | null,"order_type"?: string | null,"ordered_at"?: string,"payment_type"?: string | null,"pos_update_time"?: string,"service_tax"?: number,"shift_id"?: string,"status"?: string,"subtotal"?: number,"tax"?: number,"total"?: number,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"pos_shift_transactions": {
                  Row: {
                    "amount": number,"occurred_at": string,"order_id": string | null,"shift_id": string,"tx_id": string,"tx_type": number
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"occurred_at": string,"order_id"?: string | null,"shift_id": string,"tx_id": string,"tx_type": number
                  }
                  Update: {
                    "amount"?: number,"occurred_at"?: string,"order_id"?: string | null,"shift_id"?: string,"tx_id"?: string,"tx_type"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_shift_transactions_shift_id_fkey"
      columns: ["shift_id"]
isOneToOne: false
      referencedRelation: "pos_shift_summaries"
      referencedColumns: ["shift_id"]
    },{
      foreignKeyName: "pos_shift_transactions_shift_id_fkey"
      columns: ["shift_id"]
isOneToOne: false
      referencedRelation: "pos_shifts"
      referencedColumns: ["id"]
    }
                  ]
                },"pos_shifts": {
                  Row: {
                    "closed_at": string | null,"drawer_cash_net": number | null,"drawer_credit": number | null,"id": string,"is_active": boolean,"opened_at": string,"pos_update_time": string,"synced_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "closed_at"?: string | null,"drawer_cash_net"?: number | null,"drawer_credit"?: number | null,"id": string,"is_active": boolean,"opened_at": string,"pos_update_time": string,"synced_at"?: string
                  }
                  Update: {
                    "closed_at"?: string | null,"drawer_cash_net"?: number | null,"drawer_credit"?: number | null,"id"?: string,"is_active"?: boolean,"opened_at"?: string,"pos_update_time"?: string,"synced_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"pos_sync_run_orders": {
                  Row: {
                    "order_id": string,"run_id": number
                  }
                  ComputedFields: never
                  Insert: {
                    "order_id": string,"run_id": number
                  }
                  Update: {
                    "order_id"?: string,"run_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_sync_run_orders_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "pos_sync_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"pos_sync_runs": {
                  Row: {
                    "counts": Json | null,"error": string | null,"finished_at": string | null,"id": number,"mode": string,"scope_applied": boolean,"started_at": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "counts"?: Json | null,"error"?: string | null,"finished_at"?: string | null,"id"?: never,"mode": string,"scope_applied"?: boolean,"started_at"?: string,"status"?: string
                  }
                  Update: {
                    "counts"?: Json | null,"error"?: string | null,"finished_at"?: string | null,"id"?: never,"mode"?: string,"scope_applied"?: boolean,"started_at"?: string,"status"?: string
                  }
                  Relationships: [
                    
                  ]
                },"provisional_deficits": {
                  Row: {
                    "item_id": string,"movement_id": number,"provisional_unit_cost": number,"qty_uncovered": number,"value_uncovered": number
                  }
                  ComputedFields: never
                  Insert: {
                    "item_id": string,"movement_id": number,"provisional_unit_cost": number,"qty_uncovered": number,"value_uncovered": number
                  }
                  Update: {
                    "item_id"?: string,"movement_id"?: number,"provisional_unit_cost"?: number,"qty_uncovered"?: number,"value_uncovered"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "provisional_deficits_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "provisional_deficits_movement_id_fkey"
      columns: ["movement_id"]
isOneToOne: true
      referencedRelation: "stock_movements"
      referencedColumns: ["id"]
    }
                  ]
                },"purchase_lines": {
                  Row: {
                    "amount_paid": number,"base_quantity": number,"item_id": string,"line_no": number,"movement_id": number,"purchase_id": string,"quantity": number,"unit": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_paid": number,"base_quantity": number,"item_id": string,"line_no": number,"movement_id": number,"purchase_id": string,"quantity": number,"unit": string
                  }
                  Update: {
                    "amount_paid"?: number,"base_quantity"?: number,"item_id"?: string,"line_no"?: number,"movement_id"?: number,"purchase_id"?: string,"quantity"?: number,"unit"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchase_lines_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "purchase_lines_movement_id_fkey"
      columns: ["movement_id"]
isOneToOne: true
      referencedRelation: "stock_movements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "purchase_lines_purchase_id_fkey"
      columns: ["purchase_id"]
isOneToOne: false
      referencedRelation: "purchases"
      referencedColumns: ["id"]
    }
                  ]
                },"purchases": {
                  Row: {
                    "batch_id": string,"created_at": string,"created_by": string | null,"id": string,"invoice_no": string | null,"note": string | null,"purchased_at": string,"supplier": string | null,"total_paid": number
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"invoice_no"?: string | null,"note"?: string | null,"purchased_at": string,"supplier"?: string | null,"total_paid": number
                  }
                  Update: {
                    "batch_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"invoice_no"?: string | null,"note"?: string | null,"purchased_at"?: string,"supplier"?: string | null,"total_paid"?: number
                  }
                  Relationships: [
                    
                  ]
                },"stock_items": {
                  Row: {
                    "active": boolean,"base_unit": string,"count_frequency": string,"created_at": string,"id": string,"kind": string,"loss_pct": number,"name": string,"parent_item_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"base_unit": string,"count_frequency": string,"created_at"?: string,"id"?: string,"kind": string,"loss_pct"?: number,"name": string,"parent_item_id"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"base_unit"?: string,"count_frequency"?: string,"created_at"?: string,"id"?: string,"kind"?: string,"loss_pct"?: number,"name"?: string,"parent_item_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_items_parent_item_id_fkey"
      columns: ["parent_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                },"stock_movements": {
                  Row: {
                    "adjusts_movement_id": number | null,"batch_id": string,"created_at": string,"created_by": string | null,"id": number,"is_provisional": boolean,"item_id": string,"movement_type": Database["app"]['Enums']["movement_type"],"note": string | null,"occurred_at": string,"quantity": number,"shift_id": string | null,"source_id": string | null,"source_type": string | null,"total_cost": number,"unit_cost": number
                  }
                  ComputedFields: never
                  Insert: {
                    "adjusts_movement_id"?: number | null,"batch_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: never,"is_provisional"?: boolean,"item_id": string,"movement_type": Database["app"]['Enums']["movement_type"],"note"?: string | null,"occurred_at": string,"quantity": number,"shift_id"?: string | null,"source_id"?: string | null,"source_type"?: string | null,"total_cost": number,"unit_cost": number
                  }
                  Update: {
                    "adjusts_movement_id"?: number | null,"batch_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: never,"is_provisional"?: boolean,"item_id"?: string,"movement_type"?: Database["app"]['Enums']["movement_type"],"note"?: string | null,"occurred_at"?: string,"quantity"?: number,"shift_id"?: string | null,"source_id"?: string | null,"source_type"?: string | null,"total_cost"?: number,"unit_cost"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_movements_adjusts_movement_id_fkey"
      columns: ["adjusts_movement_id"]
isOneToOne: false
      referencedRelation: "stock_movements"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_movements_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "pos_shift_summaries": {
                  Row: {
                    "closed_at": string | null,"drawer_difference": number | null,"drawer_total": number | null,"gross_sales": number | null,"is_active": boolean | null,"net_sales": number | null,"opened_at": string | null,"orders_canceled": number | null,"orders_complete": number | null,"orders_missing": number | null,"orders_open": number | null,"refunds": number | null,"shift_id": string | null,"unknown_tx": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "add_unit_conversion":
{ Args: { "p_expected_base_unit": string,"p_factor": number,"p_item_id": string,"p_unit": string }; Returns: undefined
                           },
"apply_inflow_movement":
{ Args: { "p_batch_id": string,"p_in_qty": number,"p_in_total_cost"?: number,"p_in_unit_cost": number,"p_item_id": string,"p_movement_type": Database["app"]['Enums']["movement_type"],"p_note": string,"p_occurred_at": string,"p_shift_id": string,"p_source_id": string,"p_source_type": string }; Returns: undefined
                           },
"apply_outflow_movement":
{ Args: { "p_batch_id": string,"p_item_id": string,"p_movement_type": Database["app"]['Enums']["movement_type"],"p_note": string,"p_occurred_at": string,"p_out_qty": number,"p_override_total_cost"?: number,"p_shift_id": string,"p_source_id": string,"p_source_type": string }; Returns: undefined
                           },
"assert_ledger_write_allowed":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"assert_pos_write_allowed":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"delete_unit_conversion":
{ Args: { "p_expected_base_unit": string,"p_expected_factor": number,"p_item_id": string,"p_unit": string }; Returns: undefined
                           },
"finish_pos_sync_run":
{ Args: { "p_counts": Json,"p_error": string,"p_run_id": number,"p_status": string }; Returns: undefined
                           },
"ingest_pos_batch":
{ Args: { "p_orders": Json,"p_run_id": number,"p_scope": Json,"p_shifts": Json }; Returns: Json
                           },
"is_owner":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"lock_and_validate_item_balance":
{ Args: { "p_item_id": string,"p_occurred_at": string }; Returns: {
              "avg_cost": number,
"has_uncovered_deficit": boolean,
"item_id": string,
"last_occurred_at": string | null,
"on_hand_qty": number,
"on_hand_value": number
            }
                          SetofOptions: {
        from: "*"
        to: "item_balances"
        isOneToOne: true
        isSetofReturn: false
      } },
"pos_money":
{ Args: { "p_value": number }; Returns: number
                           },
"pos_qty":
{ Args: { "p_value": number }; Returns: number
                           },
"post_movements":
{ Args: { "p_movements": Json }; Returns: string
                           },
"post_sort":
{ Args: { "p_mixed_item": string,"p_occurred_at": string,"p_qty_taken": number,"p_shift_id"?: string,"p_sizes": Json }; Returns: string
                           },
"record_opening_stock":
{ Args: { "p_lines": Json,"p_occurred_at": string }; Returns: string
                           },
"record_purchase":
{ Args: { "p_purchase": Json }; Returns: string
                           },
"replace_pos_order_lines":
{ Args: { "p_lines": Json,"p_order_id": string }; Returns: undefined
                           },
"start_pos_sync_run":
{ Args: { "p_mode": string }; Returns: number
                           },
"update_unit_conversion":
{ Args: { "p_expected_base_unit": string,"p_expected_factor": number,"p_factor": number,"p_item_id": string,"p_unit": string }; Returns: undefined
                           }
          }
          Enums: {
            "movement_type": "opening"|"purchase"|"sort_out"|"sort_in"|"sort_loss"|"sale"|"sale_reversal"|"waste"|"count_adjustment"|"cost_adjustment"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            [_ in never]: never
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "app": {
          Enums: {
            "movement_type": ["opening", "purchase", "sort_out", "sort_in", "sort_loss", "sale", "sale_reversal", "waste", "count_adjustment", "cost_adjustment"]
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
