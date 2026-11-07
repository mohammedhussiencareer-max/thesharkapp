
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "app": {
          Tables: {
            "costing_changes": {
                  Row: {
                    "actor_id": string | null,"id": number,"kind": string,"payload": NonNullable<Json>,"reason": string | null,"recorded_at": string,"request_id": string,"result": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"id"?: never,"kind": string,"payload": NonNullable<Json>,"reason"?: string | null,"recorded_at"?: string,"request_id": string,"result": NonNullable<Json>
                  }
                  Update: {
                    "actor_id"?: string | null,"id"?: never,"kind"?: string,"payload"?: NonNullable<Json>,"reason"?: string | null,"recorded_at"?: string,"request_id"?: string,"result"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"expense_categories": {
                  Row: {
                    "active": boolean,"created_at": string,"id": string,"kind": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"kind": string,"name": string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"kind"?: string,"name"?: string
                  }
                  Relationships: [
                    
                  ]
                },"expense_entries": {
                  Row: {
                    "amount": number | null,"category_id": string | null,"created_at": string,"created_by": string | null,"driver_label": string | null,"expense_date": string | null,"hourly_rate": number | null,"hours": number | null,"id": string,"is_estimate": boolean | null,"note": string | null,"paid_on": string | null,"period_month": string | null,"request_id": string,"void_reason": string | null,"voids_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount"?: number | null,"category_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"driver_label"?: string | null,"expense_date"?: string | null,"hourly_rate"?: number | null,"hours"?: number | null,"id"?: string,"is_estimate"?: boolean | null,"note"?: string | null,"paid_on"?: string | null,"period_month"?: string | null,"request_id": string,"void_reason"?: string | null,"voids_id"?: string | null
                  }
                  Update: {
                    "amount"?: number | null,"category_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"driver_label"?: string | null,"expense_date"?: string | null,"hourly_rate"?: number | null,"hours"?: number | null,"id"?: string,"is_estimate"?: boolean | null,"note"?: string | null,"paid_on"?: string | null,"period_month"?: string | null,"request_id"?: string,"void_reason"?: string | null,"voids_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "expense_entries_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "expense_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "expense_entries_voids_id_fkey"
      columns: ["voids_id"]
isOneToOne: true
      referencedRelation: "expense_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "expense_entries_voids_id_fkey"
      columns: ["voids_id"]
isOneToOne: true
      referencedRelation: "expense_lines"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "expense_entries_voids_id_fkey"
      columns: ["voids_id"]
isOneToOne: true
      referencedRelation: "expense_lines"
      referencedColumns: ["void_id"]
    }
                  ]
                },"item_balances": {
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
                },"item_conversion_versions": {
                  Row: {
                    "created_change_id": number,"effective_from": string,"effective_to": string | null,"factor_to_base": number,"id": string,"item_id": string,"superseded_change_id": number | null,"unit_code": string,"valid_during": unknown
                  }
                  ComputedFields: never
                  Insert: {
                    "created_change_id": number,"effective_from": string,"effective_to"?: string | null,"factor_to_base": number,"id"?: string,"item_id": string,"superseded_change_id"?: number | null,"unit_code": string,"valid_during"?: never
                  }
                  Update: {
                    "created_change_id"?: number,"effective_from"?: string,"effective_to"?: string | null,"factor_to_base"?: number,"id"?: string,"item_id"?: string,"superseded_change_id"?: number | null,"unit_code"?: string,"valid_during"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "item_conversion_versions_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_conversion_versions_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_conversion_versions_superseded_change_id_fkey"
      columns: ["superseded_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_conversion_versions_unit_code_fkey"
      columns: ["unit_code"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    }
                  ]
                },"item_loss_versions": {
                  Row: {
                    "created_change_id": number,"effective_from": string,"effective_to": string | null,"id": string,"item_id": string,"loss_pct": number,"superseded_change_id": number | null,"valid_during": unknown
                  }
                  ComputedFields: never
                  Insert: {
                    "created_change_id": number,"effective_from": string,"effective_to"?: string | null,"id"?: string,"item_id": string,"loss_pct": number,"superseded_change_id"?: number | null,"valid_during"?: never
                  }
                  Update: {
                    "created_change_id"?: number,"effective_from"?: string,"effective_to"?: string | null,"id"?: string,"item_id"?: string,"loss_pct"?: number,"superseded_change_id"?: number | null,"valid_during"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "item_loss_versions_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_loss_versions_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_loss_versions_superseded_change_id_fkey"
      columns: ["superseded_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    }
                  ]
                },"item_opening_prices": {
                  Row: {
                    "approved_at": string,"approved_by": string | null,"base_unit": string,"created_change_id": number,"id": string,"item_id": string,"superseded_change_id": number | null,"unit_cost": number,"zero_cost_reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string,"approved_by"?: string | null,"base_unit": string,"created_change_id": number,"id"?: string,"item_id": string,"superseded_change_id"?: number | null,"unit_cost": number,"zero_cost_reason"?: string | null
                  }
                  Update: {
                    "approved_at"?: string,"approved_by"?: string | null,"base_unit"?: string,"created_change_id"?: number,"id"?: string,"item_id"?: string,"superseded_change_id"?: number | null,"unit_cost"?: number,"zero_cost_reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "item_opening_prices_base_unit_fkey"
      columns: ["base_unit"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "item_opening_prices_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_opening_prices_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "item_opening_prices_superseded_change_id_fkey"
      columns: ["superseded_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
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
                },"month_expense_status": {
                  Row: {
                    "complete": boolean,"confirmed_at": string | null,"confirmed_by": string | null,"month": string
                  }
                  ComputedFields: never
                  Insert: {
                    "complete": boolean,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"month": string
                  }
                  Update: {
                    "complete"?: boolean,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"month"?: string
                  }
                  Relationships: [
                    
                  ]
                },"movement_attributions": {
                  Row: {
                    "attributed_at": string,"movement_id": number,"shift_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attributed_at"?: string,"movement_id": number,"shift_id"?: string | null
                  }
                  Update: {
                    "attributed_at"?: string,"movement_id"?: number,"shift_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "movement_attributions_movement_id_fkey"
      columns: ["movement_id"]
isOneToOne: true
      referencedRelation: "stock_movements"
      referencedColumns: ["id"]
    }
                  ]
                },"opening_stock_lines": {
                  Row: {
                    "item_id": string,"line_no": number,"opening_id": string,"quantity": number,"unit": string,"unit_cost": number
                  }
                  ComputedFields: never
                  Insert: {
                    "item_id": string,"line_no": number,"opening_id": string,"quantity": number,"unit": string,"unit_cost": number
                  }
                  Update: {
                    "item_id"?: string,"line_no"?: number,"opening_id"?: string,"quantity"?: number,"unit"?: string,"unit_cost"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "opening_stock_lines_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "opening_stock_lines_opening_id_fkey"
      columns: ["opening_id"]
isOneToOne: false
      referencedRelation: "opening_stocks"
      referencedColumns: ["id"]
    }
                  ]
                },"opening_stocks": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"occurred_at": string,"request_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id": string,"occurred_at": string,"request_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"occurred_at"?: string,"request_id"?: string
                  }
                  Relationships: [
                    
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
                },"packaging_lines": {
                  Row: {
                    "capacity_kg": number | null,"id": string,"line_no": number,"quantity": number,"stock_item_id": string,"unit_code": string,"version_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "capacity_kg"?: number | null,"id"?: string,"line_no": number,"quantity": number,"stock_item_id": string,"unit_code": string,"version_id": string
                  }
                  Update: {
                    "capacity_kg"?: number | null,"id"?: string,"line_no"?: number,"quantity"?: number,"stock_item_id"?: string,"unit_code"?: string,"version_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "packaging_lines_stock_item_id_fkey"
      columns: ["stock_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "packaging_lines_unit_code_fkey"
      columns: ["unit_code"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "packaging_lines_version_id_fkey"
      columns: ["version_id"]
isOneToOne: false
      referencedRelation: "packaging_versions"
      referencedColumns: ["id"]
    }
                  ]
                },"packaging_subjects": {
                  Row: {
                    "created_change_id": number,"id": string,"kind": string,"order_type_key": Json | null,"pos_item_id": string | null,"size_key": Json | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_change_id": number,"id"?: string,"kind": string,"order_type_key"?: Json | null,"pos_item_id"?: string | null,"size_key"?: Json | null
                  }
                  Update: {
                    "created_change_id"?: number,"id"?: string,"kind"?: string,"order_type_key"?: Json | null,"pos_item_id"?: string | null,"size_key"?: Json | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "packaging_subjects_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    }
                  ]
                },"packaging_versions": {
                  Row: {
                    "created_change_id": number,"decision": string,"effective_from": string,"effective_to": string | null,"id": string,"subject_id": string,"superseded_change_id": number | null,"valid_during": unknown
                  }
                  ComputedFields: never
                  Insert: {
                    "created_change_id": number,"decision": string,"effective_from": string,"effective_to"?: string | null,"id"?: string,"subject_id": string,"superseded_change_id"?: number | null,"valid_during"?: never
                  }
                  Update: {
                    "created_change_id"?: number,"decision"?: string,"effective_from"?: string,"effective_to"?: string | null,"id"?: string,"subject_id"?: string,"superseded_change_id"?: number | null,"valid_during"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "packaging_versions_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "packaging_versions_subject_id_fkey"
      columns: ["subject_id"]
isOneToOne: false
      referencedRelation: "packaging_subjects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "packaging_versions_superseded_change_id_fkey"
      columns: ["superseded_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    }
                  ]
                },"period_revisions": {
                  Row: {
                    "amount": number,"bucket": string,"cause_batch_id": string,"created_at": string,"id": number,"item_id": string,"shift_id": string | null,"source_movement_id": number
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"bucket": string,"cause_batch_id": string,"created_at"?: string,"id"?: never,"item_id": string,"shift_id"?: string | null,"source_movement_id": number
                  }
                  Update: {
                    "amount"?: number,"bucket"?: string,"cause_batch_id"?: string,"created_at"?: string,"id"?: never,"item_id"?: string,"shift_id"?: string | null,"source_movement_id"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "period_revisions_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "period_revisions_source_movement_id_fkey"
      columns: ["source_movement_id"]
isOneToOne: true
      referencedRelation: "stock_movements"
      referencedColumns: ["id"]
    }
                  ]
                },"pos_map_subjects": {
                  Row: {
                    "created_change_id": number,"id": string,"kind": string,"option_scope": string | null,"option_value": string | null,"pos_item_id": string | null,"size_key": Json | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_change_id": number,"id"?: string,"kind": string,"option_scope"?: string | null,"option_value"?: string | null,"pos_item_id"?: string | null,"size_key"?: Json | null
                  }
                  Update: {
                    "created_change_id"?: number,"id"?: string,"kind"?: string,"option_scope"?: string | null,"option_value"?: string | null,"pos_item_id"?: string | null,"size_key"?: Json | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_map_subjects_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    }
                  ]
                },"pos_map_versions": {
                  Row: {
                    "created_change_id": number,"effective_from": string,"effective_to": string | null,"exception_reason": string | null,"family": string,"id": string,"option_policy": string | null,"quantity_per_basis": number | null,"recipe_id": string | null,"stock_item_id": string | null,"subject_id": string,"superseded_change_id": number | null,"target_kind": string | null,"unit_code": string | null,"valid_during": unknown
                  }
                  ComputedFields: never
                  Insert: {
                    "created_change_id": number,"effective_from": string,"effective_to"?: string | null,"exception_reason"?: string | null,"family": string,"id"?: string,"option_policy"?: string | null,"quantity_per_basis"?: number | null,"recipe_id"?: string | null,"stock_item_id"?: string | null,"subject_id": string,"superseded_change_id"?: number | null,"target_kind"?: string | null,"unit_code"?: string | null,"valid_during"?: never
                  }
                  Update: {
                    "created_change_id"?: number,"effective_from"?: string,"effective_to"?: string | null,"exception_reason"?: string | null,"family"?: string,"id"?: string,"option_policy"?: string | null,"quantity_per_basis"?: number | null,"recipe_id"?: string | null,"stock_item_id"?: string | null,"subject_id"?: string,"superseded_change_id"?: number | null,"target_kind"?: string | null,"unit_code"?: string | null,"valid_during"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "pos_map_versions_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_map_versions_recipe_id_fkey"
      columns: ["recipe_id"]
isOneToOne: false
      referencedRelation: "recipes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_map_versions_stock_item_id_fkey"
      columns: ["stock_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_map_versions_subject_id_fkey"
      columns: ["subject_id"]
isOneToOne: false
      referencedRelation: "pos_map_subjects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_map_versions_superseded_change_id_fkey"
      columns: ["superseded_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "pos_map_versions_unit_code_fkey"
      columns: ["unit_code"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    }
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
                    "close_recorded_at": string | null,"closed_at": string | null,"drawer_cash_net": number | null,"drawer_credit": number | null,"id": string,"is_active": boolean,"opened_at": string,"pos_update_time": string,"synced_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "close_recorded_at"?: string | null,"closed_at"?: string | null,"drawer_cash_net"?: number | null,"drawer_credit"?: number | null,"id": string,"is_active": boolean,"opened_at": string,"pos_update_time": string,"synced_at"?: string
                  }
                  Update: {
                    "close_recorded_at"?: string | null,"closed_at"?: string | null,"drawer_cash_net"?: number | null,"drawer_credit"?: number | null,"id"?: string,"is_active"?: boolean,"opened_at"?: string,"pos_update_time"?: string,"synced_at"?: string
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
                    "batch_id": string,"created_at": string,"created_by": string | null,"id": string,"invoice_no": string | null,"note": string | null,"purchased_at": string,"request_id": string,"supplier": string | null,"total_paid": number
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"invoice_no"?: string | null,"note"?: string | null,"purchased_at": string,"request_id": string,"supplier"?: string | null,"total_paid": number
                  }
                  Update: {
                    "batch_id"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"invoice_no"?: string | null,"note"?: string | null,"purchased_at"?: string,"request_id"?: string,"supplier"?: string | null,"total_paid"?: number
                  }
                  Relationships: [
                    
                  ]
                },"recipe_import_bindings": {
                  Row: {
                    "created_at": string,"id": string,"import_id": string,"is_block": boolean,"recipe_id": string | null,"source_name": string,"stock_item_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"import_id": string,"is_block"?: boolean,"recipe_id"?: string | null,"source_name": string,"stock_item_id"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"import_id"?: string,"is_block"?: boolean,"recipe_id"?: string | null,"source_name"?: string,"stock_item_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "recipe_import_bindings_import_id_fkey"
      columns: ["import_id"]
isOneToOne: false
      referencedRelation: "recipe_imports"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recipe_import_bindings_recipe_id_fkey"
      columns: ["recipe_id"]
isOneToOne: false
      referencedRelation: "recipes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recipe_import_bindings_stock_item_id_fkey"
      columns: ["stock_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                },"recipe_imports": {
                  Row: {
                    "counts": NonNullable<Json>,"created_at": string,"created_change_id": number,"id": string,"request_id": string,"structural_hash": string,"summary": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "counts": NonNullable<Json>,"created_at"?: string,"created_change_id": number,"id"?: string,"request_id": string,"structural_hash": string,"summary": NonNullable<Json>
                  }
                  Update: {
                    "counts"?: NonNullable<Json>,"created_at"?: string,"created_change_id"?: number,"id"?: string,"request_id"?: string,"structural_hash"?: string,"summary"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "recipe_imports_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: true
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    }
                  ]
                },"recipe_lines": {
                  Row: {
                    "child_recipe_id": string | null,"id": string,"line_no": number,"quantity": number,"stock_item_id": string | null,"unit": string,"version_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "child_recipe_id"?: string | null,"id"?: string,"line_no": number,"quantity": number,"stock_item_id"?: string | null,"unit": string,"version_id": string
                  }
                  Update: {
                    "child_recipe_id"?: string | null,"id"?: string,"line_no"?: number,"quantity"?: number,"stock_item_id"?: string | null,"unit"?: string,"version_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "recipe_lines_child_recipe_id_fkey"
      columns: ["child_recipe_id"]
isOneToOne: false
      referencedRelation: "recipes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recipe_lines_stock_item_id_fkey"
      columns: ["stock_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recipe_lines_unit_fkey"
      columns: ["unit"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "recipe_lines_version_id_fkey"
      columns: ["version_id"]
isOneToOne: false
      referencedRelation: "recipe_versions"
      referencedColumns: ["id"]
    }
                  ]
                },"recipe_versions": {
                  Row: {
                    "batch_qty": number | null,"batch_unit": string | null,"created_change_id": number,"effective_from": string,"effective_to": string | null,"id": string,"recipe_id": string,"superseded_change_id": number | null,"valid_during": unknown
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_qty"?: number | null,"batch_unit"?: string | null,"created_change_id": number,"effective_from": string,"effective_to"?: string | null,"id"?: string,"recipe_id": string,"superseded_change_id"?: number | null,"valid_during"?: never
                  }
                  Update: {
                    "batch_qty"?: number | null,"batch_unit"?: string | null,"created_change_id"?: number,"effective_from"?: string,"effective_to"?: string | null,"id"?: string,"recipe_id"?: string,"superseded_change_id"?: number | null,"valid_during"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "recipe_versions_batch_unit_fkey"
      columns: ["batch_unit"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "recipe_versions_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recipe_versions_recipe_id_fkey"
      columns: ["recipe_id"]
isOneToOne: false
      referencedRelation: "recipes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "recipe_versions_superseded_change_id_fkey"
      columns: ["superseded_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    }
                  ]
                },"recipes": {
                  Row: {
                    "active": boolean,"created_change_id": number,"id": string,"kind": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_change_id": number,"id"?: string,"kind": string,"name": string
                  }
                  Update: {
                    "active"?: boolean,"created_change_id"?: number,"id"?: string,"kind"?: string,"name"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "recipes_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    }
                  ]
                },"shift_report_flags": {
                  Row: {
                    "profit_delta": number,"revised_at": string,"shift_id": string,"sort_transfer_delta": number
                  }
                  ComputedFields: never
                  Insert: {
                    "profit_delta": number,"revised_at": string,"shift_id": string,"sort_transfer_delta": number
                  }
                  Update: {
                    "profit_delta"?: number,"revised_at"?: string,"shift_id"?: string,"sort_transfer_delta"?: number
                  }
                  Relationships: [
                    
                  ]
                },"sort_batch_lines": {
                  Row: {
                    "batch_id": string,"line_no": number,"quantity": number,"size_item_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "batch_id": string,"line_no": number,"quantity": number,"size_item_id": string
                  }
                  Update: {
                    "batch_id"?: string,"line_no"?: number,"quantity"?: number,"size_item_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sort_batch_lines_batch_id_fkey"
      columns: ["batch_id"]
isOneToOne: false
      referencedRelation: "sort_batches"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sort_batch_lines_batch_id_fkey"
      columns: ["batch_id"]
isOneToOne: false
      referencedRelation: "sort_history"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sort_batch_lines_size_item_id_fkey"
      columns: ["size_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                },"sort_batches": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"mixed_item_id": string,"note": string | null,"occurred_at": string,"qty_taken": number,"request_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id": string,"mixed_item_id": string,"note"?: string | null,"occurred_at": string,"qty_taken": number,"request_id": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"mixed_item_id"?: string,"note"?: string | null,"occurred_at"?: string,"qty_taken"?: number,"request_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "sort_batches_mixed_item_id_fkey"
      columns: ["mixed_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                },"stock_count_lines": {
                  Row: {
                    "count_id": string,"counted_qty": number,"delta_qty": number,"delta_value": number,"expected_base_unit": string,"expected_qty": number,"item_id": string,"line_no": number,"movement_id": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "count_id": string,"counted_qty": number,"delta_qty": number,"delta_value": number,"expected_base_unit": string,"expected_qty": number,"item_id": string,"line_no": number,"movement_id"?: number | null
                  }
                  Update: {
                    "count_id"?: string,"counted_qty"?: number,"delta_qty"?: number,"delta_value"?: number,"expected_base_unit"?: string,"expected_qty"?: number,"item_id"?: string,"line_no"?: number,"movement_id"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "stock_count_lines_count_id_fkey"
      columns: ["count_id"]
isOneToOne: false
      referencedRelation: "stock_count_history"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_count_lines_count_id_fkey"
      columns: ["count_id"]
isOneToOne: false
      referencedRelation: "stock_counts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_count_lines_item_id_fkey"
      columns: ["item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "stock_count_lines_movement_id_fkey"
      columns: ["movement_id"]
isOneToOne: false
      referencedRelation: "stock_movements"
      referencedColumns: ["id"]
    }
                  ]
                },"stock_count_requests": {
                  Row: {
                    "created_by": string | null,"payload": NonNullable<Json>,"prepared_at": string,"request_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_by"?: string | null,"payload": NonNullable<Json>,"prepared_at": string,"request_id": string
                  }
                  Update: {
                    "created_by"?: string | null,"payload"?: NonNullable<Json>,"prepared_at"?: string,"request_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"stock_counts": {
                  Row: {
                    "counted_at": string,"created_at": string,"created_by": string | null,"frequency": string,"id": string,"note": string | null,"request_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "counted_at": string,"created_at"?: string,"created_by"?: string | null,"frequency": string,"id": string,"note"?: string | null,"request_id": string
                  }
                  Update: {
                    "counted_at"?: string,"created_at"?: string,"created_by"?: string | null,"frequency"?: string,"id"?: string,"note"?: string | null,"request_id"?: string
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
      foreignKeyName: "stock_items_base_unit_fkey"
      columns: ["base_unit"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    },{
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
                },"unit_aliases": {
                  Row: {
                    "alias": string,"created_change_id": number,"unit_code": string
                  }
                  ComputedFields: never
                  Insert: {
                    "alias": string,"created_change_id": number,"unit_code": string
                  }
                  Update: {
                    "alias"?: string,"created_change_id"?: number,"unit_code"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "unit_aliases_created_change_id_fkey"
      columns: ["created_change_id"]
isOneToOne: false
      referencedRelation: "costing_changes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "unit_aliases_unit_code_fkey"
      columns: ["unit_code"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    }
                  ]
                },"units": {
                  Row: {
                    "code": string,"dimension": string,"label_ar": string,"metric_scale": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"dimension": string,"label_ar": string,"metric_scale"?: number | null
                  }
                  Update: {
                    "code"?: string,"dimension"?: string,"label_ar"?: string,"metric_scale"?: number | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "expense_lines": {
                  Row: {
                    "amount": number | null,"category_id": string | null,"category_kind": string | null,"category_name": string | null,"created_at": string | null,"driver_label": string | null,"expense_date": string | null,"hourly_rate": number | null,"hours": number | null,"id": string | null,"is_estimate": boolean | null,"note": string | null,"paid_on": string | null,"period_month": string | null,"void_id": string | null,"void_reason": string | null,"voided_at": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "expense_entries_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "expense_categories"
      referencedColumns: ["id"]
    }
                  ]
                },"item_units_current": {
                  Row: {
                    "effective_from": string | null,"factor_text": string | null,"factor_to_base": number | null,"item_id": string | null,"label_ar": string | null,"source": string | null,"unit_code": string | null,"version_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"packaging_line_rows": {
                  Row: {
                    "capacity_kg": number | null,"id": string | null,"line_no": number | null,"quantity": number | null,"stock_item_id": string | null,"subject_id": string | null,"unit_code": string | null,"version_id": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "packaging_lines_stock_item_id_fkey"
      columns: ["stock_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "packaging_lines_unit_code_fkey"
      columns: ["unit_code"]
isOneToOne: false
      referencedRelation: "units"
      referencedColumns: ["code"]
    },{
      foreignKeyName: "packaging_lines_version_id_fkey"
      columns: ["version_id"]
isOneToOne: false
      referencedRelation: "packaging_versions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "packaging_versions_subject_id_fkey"
      columns: ["subject_id"]
isOneToOne: false
      referencedRelation: "packaging_subjects"
      referencedColumns: ["id"]
    }
                  ]
                },"packaging_observed_order_types": {
                  Row: {
                    "last_ordered_at": string | null,"order_count": number | null,"order_type_key": Json | null,"order_type_key_text": string | null,"order_type_label": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"pos_observed_bases": {
                  Row: {
                    "item_name": string | null,"last_ordered_at": string | null,"latest_line_id": string | null,"latest_order_id": string | null,"map_status": string | null,"pos_item_id": string | null,"sale_count": number | null,"size_key": Json | null,"size_key_text": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"pos_observed_options": {
                  Row: {
                    "option_value": string | null,"pos_item_id": string | null,"seen_count": number | null,"size_key": Json | null,"size_key_text": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"pos_shift_summaries": {
                  Row: {
                    "closed_at": string | null,"drawer_difference": number | null,"drawer_total": number | null,"gross_sales": number | null,"is_active": boolean | null,"net_sales": number | null,"opened_at": string | null,"orders_canceled": number | null,"orders_complete": number | null,"orders_missing": number | null,"orders_open": number | null,"refunds": number | null,"shift_id": string | null,"unknown_tx": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"sort_history": {
                  Row: {
                    "cost_per_kg": number | null,"created_at": string | null,"id": string | null,"loss_qty": number | null,"loss_value": number | null,"mixed_item_id": string | null,"mixed_item_name": string | null,"note": string | null,"occurred_at": string | null,"qty_taken": number | null,"sizes_qty": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "sort_batches_mixed_item_id_fkey"
      columns: ["mixed_item_id"]
isOneToOne: false
      referencedRelation: "stock_items"
      referencedColumns: ["id"]
    }
                  ]
                },"stock_count_history": {
                  Row: {
                    "counted_at": string | null,"created_at": string | null,"frequency": string | null,"has_surplus": boolean | null,"id": string | null,"item_count": number | null,"note": string | null,"shortage_value": number | null,"surplus_value": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"stock_count_pending": {
                  Row: {
                    "counted_at": string | null,"created_by": string | null,"frequency": string | null,"item_count": number | null,"note": string | null,"payload": Json | null,"prepared_at": string | null,"request_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                           "counted_at"?: never,"created_by"?: string | null,"frequency"?: never,"item_count"?: never,"note"?: never,"payload"?: Json | null,"prepared_at"?: string | null,"request_id"?: string | null
                         }
                        Update: {
                           "counted_at"?: never,"created_by"?: string | null,"frequency"?: never,"item_count"?: never,"note"?: never,"payload"?: Json | null,"prepared_at"?: string | null,"request_id"?: string | null
                         }
                        Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "add_custom_unit":
{ Args: { "p_code": string,"p_label_ar": string,"p_request_id": string }; Returns: string
                           },
"add_expense_category":
{ Args: { "p_kind": string,"p_name": string }; Returns: string
                           },
"add_expense_entry":
{ Args: { "p_amount"?: number,"p_category_id": string,"p_driver_label"?: string,"p_expense_date"?: string,"p_hourly_rate"?: number,"p_hours"?: number,"p_is_estimate"?: boolean,"p_note"?: string,"p_paid_on"?: string,"p_period_month"?: string,"p_request_id"?: string }; Returns: string
                           },
"add_unit_conversion":
{ Args: { "p_expected_base_unit": string,"p_factor": number,"p_item_id": string,"p_unit": string }; Returns: undefined
                           },
"apply_inflow_movement":
{ Args: { "p_batch_id": string,"p_in_qty": number,"p_in_total_cost"?: number,"p_in_unit_cost": number,"p_item_id": string,"p_movement_type": Database["app"]['Enums']["movement_type"],"p_note": string,"p_occurred_at": string,"p_shift_id": string,"p_source_id": string,"p_source_type": string }; Returns: undefined
                           },
"apply_outflow_movement":
{ Args: { "p_batch_id": string,"p_item_id": string,"p_movement_type": Database["app"]['Enums']["movement_type"],"p_note": string,"p_occurred_at": string,"p_out_qty": number,"p_override_total_cost"?: number,"p_shift_id": string,"p_source_id": string,"p_source_type": string }; Returns: undefined
                           },
"assert_count_barrier":
{ Args: { "p_item_ids": (string)[],"p_occurred_at": (string)[],"p_set": (string)[] }; Returns: undefined
                           },
"assert_expense_write_allowed":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"assert_ledger_write_allowed":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"assert_no_phone_text":
{ Args: { "p_text": string }; Returns: undefined
                           },
"assert_not_before_opening":
{ Args: { "p_item_ids": (string)[],"p_occurred_at": (string)[],"p_types": (string)[] }; Returns: undefined
                           },
"assert_pos_write_allowed":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"assert_recompute_range":
{ Args: { "p_allow_negative": boolean,"p_scale": number,"p_value": number }; Returns: number
                           },
"backfill_legacy_costing":
{ Args: { "p_at": string }; Returns: Json
                           },
"batch_is_forward":
{ Args: { "p_item_ids": (string)[],"p_occurred_at": (string)[] }; Returns: boolean
                           },
"commit_recipe_import":
{ Args: { "p_payload": Json,"p_request_id": string }; Returns: Json
                           },
"costing_impact":
{ Args: { "p_from": string,"p_item_id"?: string,"p_to": string }; Returns: Json
                           },
"costing_replay_result":
{ Args: { "p_payload": Json,"p_request_id": string }; Returns: Json
                           },
"costing_schedule_line":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_id": string,"p_payload": number }; Returns: string
                           },
"costing_timestamptz_text":
{ Args: { "p_at": string }; Returns: string
                           },
"create_recipe":
{ Args: { "p_kind": string,"p_name": string,"p_request_id": string }; Returns: Json
                           },
"create_stock_item":
{ Args: { "p_active": boolean,"p_base_unit": string,"p_count_frequency": string,"p_kind": string,"p_loss_pct": number,"p_name": string,"p_parent_item_id": string,"p_request_id": string }; Returns: string
                           },
"current_shift_start":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"delete_unit_conversion":
{ Args: { "p_expected_base_unit": string,"p_expected_factor": number,"p_item_id": string,"p_unit": string }; Returns: undefined
                           },
"expand_recipe":
{ Args: { "p_at": string,"p_output_qty": number,"p_output_unit": string,"p_recipe_id": string }; Returns: Json
                           },
"expense_daily":
{ Args: { "p_from": string,"p_to": string }; Returns: {
              "daily_total": number,"date": string,"depreciation": number,"driver_total": number,"fixed_share": number,"interest": number,"total": number
            }[]
                           },
"expense_day_share":
{ Args: { "p_amount": number,"p_day_count": number,"p_day_index": number }; Returns: number
                           },
"expense_effective":
{ Args: Record<PropertyKey, never>; Returns: {
              "amount": number,"category_id": string,"expense_date": string,"id": string,"is_estimate": boolean,"kind": string,"period_month": string
            }[]
                           },
"expense_month_check":
{ Args: { "p_month": string }; Returns: {
              "balanced": boolean,"days_total": number,"entries_total": number
            }[]
                           },
"finish_pos_sync_run":
{ Args: { "p_counts": Json,"p_error": string,"p_run_id": number,"p_status": string }; Returns: undefined
                           },
"import_array":
{ Args: { "p_key": string,"p_max": number,"p_node": Json }; Returns: Json
                           },
"import_assert_keys":
{ Args: { "p_allowed": (string)[],"p_node": Json,"p_what": string }; Returns: undefined
                           },
"import_loss_canonical_to":
{ Args: { "p_at": string,"p_item_id": string }; Returns: string
                           },
"import_normalize_payload":
{ Args: { "p_payload": Json }; Returns: Json
                           },
"import_numeric":
{ Args: { "p_key": string,"p_node": Json,"p_what": string }; Returns: number
                           },
"import_publish_order":
{ Args: { "p_deps": Json }; Returns: (number)[]
                           },
"import_recipe_canonical_to":
{ Args: { "p_at": string,"p_recipe_id": string }; Returns: string
                           },
"import_sub_request_id":
{ Args: { "p_label": string,"p_request_id": string }; Returns: string
                           },
"import_text":
{ Args: { "p_key": string,"p_max": number,"p_min": number,"p_node": Json,"p_required": boolean,"p_what": string }; Returns: string
                           },
"import_uuid":
{ Args: { "p_key": string,"p_node": Json,"p_what": string }; Returns: string
                           },
"import_version_matches":
{ Args: { "p_at": string,"p_batch_qty": number,"p_batch_unit": string,"p_lines": Json,"p_recipe_id": string }; Returns: boolean
                           },
"ingest_pos_batch":
{ Args: { "p_orders": Json,"p_run_id": number,"p_scope": Json,"p_shifts": Json }; Returns: Json
                           },
"insert_import_costing_change":
{ Args: { "p_payload": Json,"p_reason": string,"p_request_id": string,"p_result": Json }; Returns: Json
                           },
"insert_mapping_costing_change":
{ Args: { "p_payload": Json,"p_reason": string,"p_request_id": string,"p_result": Json }; Returns: Json
                           },
"insert_owner_costing_change":
{ Args: { "p_payload": Json,"p_reason": string,"p_request_id": string,"p_result": Json }; Returns: Json
                           },
"is_owner":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"item_costing_schedule":
{ Args: { "p_item_id": string }; Returns: Json
                           },
"item_factor_at":
{ Args: { "p_at": string,"p_item_id": string,"p_unit_code": string }; Returns: number
                           },
"item_loss_at":
{ Args: { "p_at": string,"p_item_id": string }; Returns: number
                           },
"item_units_at":
{ Args: { "p_at": string,"p_item_ids": (string)[] }; Returns: Json
                           },
"legacy_costing_snapshot_work":
{ Args: { "p_at": string,"p_change_id": number }; Returns: Json
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
"note_period_revision":
{ Args: { "p_amount": number,"p_bucket": string,"p_cause": string,"p_item_id": string,"p_shift_id": string,"p_source_id": number }; Returns: undefined
                           },
"packaging_apply":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_fn": string,"p_kind": string,"p_order_type": string,"p_order_type_key": Json,"p_policy": Json,"p_pos_item_id": string,"p_reason": string,"p_request_id": string,"p_size_key": Json }; Returns: Json
                           },
"packaging_assert_keys":
{ Args: { "p_node": Json }; Returns: undefined
                           },
"packaging_base_schedule":
{ Args: { "p_pos_item_id": string,"p_size_key": Json }; Returns: Json
                           },
"packaging_body":
{ Args: { "p_decision": string,"p_lines": Json }; Returns: string
                           },
"packaging_distinct_ids":
{ Args: { "p_ids": Json }; Returns: Json
                           },
"packaging_expand":
{ Args: { "p_at": string,"p_kind": string,"p_line_id": string,"p_order_type_key": Json,"p_pos_item_id": string,"p_scale_den": number,"p_scale_num": number,"p_scale_ok": boolean,"p_size_key": Json,"p_weighted": boolean }; Returns: Json
                           },
"packaging_identity":
{ Args: { "p_kind": string,"p_order_type_key": Json,"p_pos_item_id": string,"p_size_key": Json }; Returns: string
                           },
"packaging_kg_scale":
{ Args: { "p_qty": number,"p_unit": string }; Returns: Json
                           },
"packaging_line_recipe_paths":
{ Args: { "p_line_id": string,"p_order_id": string }; Returns: Json
                           },
"packaging_normalize_policy":
{ Args: { "p_allow_capacity": boolean,"p_policy": Json }; Returns: Json
                           },
"packaging_order_type_key":
{ Args: { "p_order_type": string }; Returns: Json
                           },
"packaging_order_type_schedule":
{ Args: { "p_order_type": string }; Returns: Json
                           },
"packaging_positive_numeric":
{ Args: { "p_value": Json,"p_what": string }; Returns: number
                           },
"packaging_schedule_line":
{ Args: { "p_body": string,"p_effective_from": string,"p_effective_to": string,"p_id": string }; Returns: string
                           },
"packaging_subject_id":
{ Args: { "p_kind": string,"p_order_type_key": Json,"p_pos_item_id": string,"p_size_key": Json }; Returns: string
                           },
"packaging_target_recipe_paths":
{ Args: { "p_at": string,"p_line_id": string,"p_mapping_version_id": string,"p_option_value": string,"p_pos_item_id": string,"p_recipe_id": string,"p_role": string,"p_scale_den": number,"p_scale_num": number,"p_size_key": Json,"p_target_kind": string,"p_weighted": boolean }; Returns: Json
                           },
"packaging_token":
{ Args: { "p_kind": string,"p_order_type_key": Json,"p_pos_item_id": string,"p_size_key": Json }; Returns: string
                           },
"packaging_version_lines_json":
{ Args: { "p_version_id": string }; Returns: Json
                           },
"packaging_versions_json":
{ Args: { "p_subject": string }; Returns: Json
                           },
"packaging_with_subject":
{ Args: { "p_kind": string,"p_order_type_key": Json,"p_pos_item_id": string,"p_result": Json,"p_size_key": Json }; Returns: Json
                           },
"pos_base_schedule":
{ Args: { "p_pos_item_id": string,"p_size_key": Json }; Returns: Json
                           },
"pos_map_apply":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_exception_reason": string,"p_expected_token": string,"p_family": string,"p_fn": string,"p_gap": boolean,"p_kind": string,"p_option_value": string,"p_policy": string,"p_pos_item_id": string,"p_quantity": number,"p_reason": string,"p_recipe_id": string,"p_request_id": string,"p_scope": string,"p_size_key": Json,"p_stock_item_id": string,"p_target": Json,"p_target_kind": string,"p_unit": string }; Returns: Json
                           },
"pos_map_assert_keys":
{ Args: { "p_node": Json }; Returns: undefined
                           },
"pos_map_assert_recipe":
{ Args: { "p_from": string,"p_label": string,"p_recipe_id": string,"p_to": string }; Returns: undefined
                           },
"pos_map_expand_target":
{ Args: { "p_at": string,"p_quantity": number,"p_recipe_id": string,"p_role": string,"p_scale_den": number,"p_scale_num": number,"p_stock_item_id": string,"p_target_kind": string,"p_unit": string,"p_weighted": boolean }; Returns: Json
                           },
"pos_map_identity":
{ Args: { "p_kind": string,"p_option_value": string,"p_pos_item_id": string,"p_scope": string,"p_size_key": Json }; Returns: string
                           },
"pos_map_label":
{ Args: { "p_kind": string,"p_option_value": string,"p_pos_item_id": string,"p_scope": string,"p_size_key": Json }; Returns: string
                           },
"pos_map_merge_req":
{ Args: { "p_dst": Json,"p_src": Json }; Returns: Json
                           },
"pos_map_option_at":
{ Args: { "p_at": string,"p_pos_item_id": string,"p_scale_den": number,"p_scale_num": number,"p_size_key": Json,"p_value": string,"p_weighted": boolean }; Returns: Json
                           },
"pos_map_schedule_line":
{ Args: { "p_body": string,"p_effective_from": string,"p_effective_to": string,"p_family": string,"p_id": string }; Returns: string
                           },
"pos_map_subject_id":
{ Args: { "p_kind": string,"p_option_value": string,"p_pos_item_id": string,"p_scope": string,"p_size_key": Json }; Returns: string
                           },
"pos_map_target_normalize":
{ Args: { "p_allow_disposition": boolean,"p_target": Json }; Returns: Json
                           },
"pos_map_token":
{ Args: { "p_kind": string,"p_option_value": string,"p_pos_item_id": string,"p_scope": string,"p_size_key": Json }; Returns: string
                           },
"pos_map_version_body":
{ Args: { "p_exception_reason": string,"p_family": string,"p_policy": string,"p_quantity": number,"p_recipe_id": string,"p_stock_item_id": string,"p_target_kind": string,"p_unit": string }; Returns: string
                           },
"pos_map_with_subject":
{ Args: { "p_kind": string,"p_option_value": string,"p_pos_item_id": string,"p_result": Json,"p_scope": string,"p_size_key": Json }; Returns: Json
                           },
"pos_mapping_coverage":
{ Args: { "p_from": string,"p_to": string }; Returns: Json
                           },
"pos_money":
{ Args: { "p_value": number }; Returns: number
                           },
"pos_name_key":
{ Args: { "p_text": string }; Returns: string
                           },
"pos_option_schedule":
{ Args: { "p_option_value": string,"p_pos_item_id": string,"p_scope": string,"p_size_key": Json }; Returns: Json
                           },
"pos_qty":
{ Args: { "p_value": number }; Returns: number
                           },
"pos_size_key":
{ Args: { "p_size_name": string }; Returns: Json
                           },
"pos_size_key_normalize":
{ Args: { "p_key": Json }; Returns: Json
                           },
"pos_text_id":
{ Args: { "p_value": string,"p_what": string }; Returns: string
                           },
"post_backdated_batch":
{ Args: { "p_batch_id": string,"p_pending": Json }; Returns: (number)[]
                           },
"post_movements":
{ Args: { "p_movements": Json }; Returns: string
                           },
"post_sort":
{ Args: { "p_mixed_item": string,"p_occurred_at": string,"p_qty_taken": number,"p_shift_id"?: string,"p_sizes": Json }; Returns: string
                           },
"prepare_balance_locks":
{ Args: { "p_item_ids": (string)[] }; Returns: undefined
                           },
"profit_bucket":
{ Args: { "p_type": Database["app"]['Enums']["movement_type"] }; Returns: string
                           },
"rebuild_derived_balances":
{ Args: { "p_cause_batch": string,"p_item_ids": (string)[] }; Returns: undefined
                           },
"recipe_expand_exact":
{ Args: { "p_at": string,"p_recipe_id": string,"p_scale": number,"p_scale_den"?: number }; Returns: Json
                           } |
{ Args: { "p_apply_loss": boolean,"p_at": string,"p_recipe_id": string,"p_scale": number,"p_scale_den": number }; Returns: Json
                           },
"recipe_lines_normalize":
{ Args: { "p_lines": Json }; Returns: Json
                           },
"recipe_payload_assert_no_price_keys":
{ Args: { "p_depth": number,"p_node": Json }; Returns: undefined
                           },
"recipe_publish_version":
{ Args: { "p_batch_qty": number,"p_batch_unit": string,"p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_lines": Json,"p_reason": string,"p_recipe_id": string,"p_request_id": string,"p_validate": boolean }; Returns: Json
                           },
"recipe_schedule":
{ Args: { "p_recipe_id": string }; Returns: Json
                           },
"recipe_schedule_line":
{ Args: { "p_batch_qty": number,"p_batch_unit": string,"p_effective_from": string,"p_effective_to": string,"p_id": string }; Returns: string
                           },
"recipe_schedule_token":
{ Args: { "p_recipe_id": string }; Returns: string
                           },
"recipe_unit_ratio":
{ Args: { "p_from_unit": string,"p_to_unit": string }; Returns: {
              "ratio_den": number,"ratio_num": number
            }[]
                           },
"recipe_validate_publication":
{ Args: { "p_from": string,"p_recipe_id": string,"p_to": string }; Returns: undefined
                           },
"recipe_walk":
{ Args: { "p_at": string,"p_recipe_id": string,"p_scale": number,"p_scale_den"?: number,"p_validate": boolean }; Returns: Json
                           } |
{ Args: { "p_apply_loss": boolean,"p_at": string,"p_recipe_id": string,"p_scale": number,"p_scale_den": number,"p_validate": boolean }; Returns: Json
                           },
"recompute_item_set":
{ Args: { "p_item_ids": (string)[] }; Returns: (string)[]
                           },
"record_count":
{ Args: { "p_count": Json }; Returns: Json
                           },
"record_opening_stock":
{ Args: { "p_lines": Json,"p_occurred_at": string,"p_request_id": string }; Returns: string
                           },
"record_purchase":
{ Args: { "p_purchase": Json }; Returns: string
                           },
"record_sort":
{ Args: { "p_sort": Json }; Returns: string
                           },
"rename_expense_category":
{ Args: { "p_id": string,"p_name": string }; Returns: undefined
                           },
"replace_pos_order_lines":
{ Args: { "p_lines": Json,"p_order_id": string }; Returns: undefined
                           },
"replay_execute":
{ Args: { "p_cause": string,"p_item_ids": (string)[],"p_pending": Json,"p_write": boolean }; Returns: undefined
                           },
"replay_inflow":
{ Args: { "p_in_qty": number,"p_is_pending": boolean,"p_item_id": string,"p_line_key": number,"p_movement_id": number,"p_note": string,"p_occurred_at": string,"p_shift_id": string,"p_source_id": string,"p_source_type": string,"p_total_cost": number,"p_type": Database["app"]['Enums']["movement_type"],"p_unit_cost": number }; Returns: undefined
                           },
"replay_outflow":
{ Args: { "p_forced_total": number,"p_is_pending": boolean,"p_item_id": string,"p_line_key": number,"p_movement_id": number,"p_note": string,"p_occurred_at": string,"p_out_qty": number,"p_shift_id": string,"p_source_id": string,"p_source_type": string,"p_type": Database["app"]['Enums']["movement_type"] }; Returns: undefined
                           },
"replay_prepare_tables":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"replay_touch_deficit_flag":
{ Args: { "p_item_id": string }; Returns: undefined
                           },
"resolve_line_requirements":
{ Args: { "p_line_id": string,"p_order_id": string }; Returns: Json
                           },
"resolve_line_requirements_exact":
{ Args: { "p_line_id": string,"p_order_id": string }; Returns: Json
                           },
"resolve_order_requirements":
{ Args: { "p_expected_order_version": number,"p_order_id": string }; Returns: Json
                           },
"resolve_order_requirements_exact":
{ Args: { "p_expected_order_version": number,"p_order_id": string }; Returns: Json
                           },
"resolve_shift_id":
{ Args: { "p_at": string }; Returns: string
                           },
"resolve_unit_code":
{ Args: { "p_unit": string }; Returns: string
                           },
"schedule_token":
{ Args: { "p_family": string,"p_item_id": string,"p_unit_code": string }; Returns: string
                           },
"set_base_packaging":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_policy": Json,"p_pos_item_id": string,"p_reason": string,"p_request_id": string,"p_size_key": Json }; Returns: Json
                           },
"set_expense_category_active":
{ Args: { "p_active": boolean,"p_id": string }; Returns: undefined
                           },
"set_item_conversion":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_factor": number,"p_item_id": string,"p_reason": string,"p_request_id": string,"p_unit_code": string }; Returns: Json
                           },
"set_item_loss":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_item_id": string,"p_loss_pct": number,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"set_item_opening_price":
{ Args: { "p_expected_current_id": string,"p_item_id": string,"p_request_id": string,"p_unit_cost": number,"p_zero_cost_reason": string }; Returns: Json
                           } |
{ Args: { "p_expected_current_id": string,"p_expected_identity": string,"p_item_id": string,"p_request_id": string,"p_unit_cost": number,"p_zero_cost_reason": string }; Returns: Json
                           },
"set_month_expense_complete":
{ Args: { "p_complete": boolean,"p_month": string }; Returns: undefined
                           },
"set_order_type_packaging":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_order_type": string,"p_policy": Json,"p_reason": string,"p_request_id": string }; Returns: Json
                           },
"set_pos_base_mapping":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_pos_item_id": string,"p_reason": string,"p_request_id": string,"p_size_key": Json,"p_target": Json }; Returns: Json
                           },
"set_pos_exception":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_exception_reason": string,"p_expected_token": string,"p_pos_item_id": string,"p_reason": string,"p_request_id": string,"p_size_key": Json }; Returns: Json
                           },
"set_pos_option_mapping":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_option_value": string,"p_pos_item_id": string,"p_reason": string,"p_request_id": string,"p_scope": string,"p_size_key": Json,"p_target": Json }; Returns: Json
                           },
"set_pos_option_policy":
{ Args: { "p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_policy": string,"p_pos_item_id": string,"p_reason": string,"p_request_id": string,"p_size_key": Json }; Returns: Json
                           },
"set_recipe_version":
{ Args: { "p_batch_qty": number,"p_batch_unit": string,"p_effective_from": string,"p_effective_to": string,"p_expected_token": string,"p_lines": Json,"p_reason": string,"p_recipe_id": string,"p_request_id": string }; Returns: Json
                           },
"shift_for_target":
{ Args: { "p_movement_id": number }; Returns: string
                           },
"start_pos_sync_run":
{ Args: { "p_mode": string }; Returns: number
                           },
"suggest_pos_mappings":
{ Args: { "p_name": string }; Returns: Json
                           },
"text_has_long_digit_run":
{ Args: { "p_text": string }; Returns: boolean
                           },
"update_recipe":
{ Args: { "p_active": boolean,"p_expected_active": boolean,"p_expected_name": string,"p_name": string,"p_recipe_id": string,"p_request_id": string }; Returns: Json
                           },
"update_unit_conversion":
{ Args: { "p_expected_base_unit": string,"p_expected_factor": number,"p_factor": number,"p_item_id": string,"p_unit": string }; Returns: undefined
                           },
"void_expense_entry":
{ Args: { "p_id": string,"p_reason": string,"p_request_id": string }; Returns: string
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
