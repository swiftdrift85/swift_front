export interface CartItem {
  item_code: string;
  item_name: string;
  rate: number;
  minimum_rate: number;
  qty: number;
  uom: string;
  stock_qty: number;
  image?: string;
}

export interface PosItem {
  item_code: string;
  item_name: string;
  rate: number;
  minimum_rate: number;
  uom: string;
  stock_qty: number;
  sellable_qty: number;
  warehouses: { warehouse: string; warehouse_name: string; actual_qty: number }[];
  image?: string;
}
