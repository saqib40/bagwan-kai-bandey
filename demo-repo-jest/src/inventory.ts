export interface Item {
  sku: string;
  qty: number;
  unitPrice: number;
}

export function stockValue(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
}

export function lowStock(items: Item[], threshold: number): Item[] {
  return items.filter((item) => item.qty <= threshold);
}
