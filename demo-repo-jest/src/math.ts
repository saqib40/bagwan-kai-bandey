export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function safeDivide(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}
