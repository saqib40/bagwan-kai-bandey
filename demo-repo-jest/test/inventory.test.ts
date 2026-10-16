import { stockValue, lowStock, type Item } from '../src/inventory';

const items: Item[] = [
  { sku: 'A', qty: 2, unitPrice: 10 },
  { sku: 'B', qty: 0, unitPrice: 5 },
];

describe('inventory', () => {
  it('computes the total stock value', () => {
    expect(stockValue(items)).toBe(20);
  });

  it('finds items at or below the low-stock threshold', () => {
    expect(lowStock(items, 0).map((item) => item.sku)).toEqual(['B']);
  });

  it('records stock checks with a spy', () => {
    const rows: Item[] = [{ sku: 'C', qty: 3, unitPrice: 2 }];
    const check = jest.fn((list: Item[]) => stockValue(list));
    expect(check(rows)).toBe(6);
    expect(check).toHaveBeenCalledWith(rows);
  });
});
