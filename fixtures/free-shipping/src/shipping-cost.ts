export function shippingCostCents(subtotalCents: number): number {
  return subtotalCents > 5_000 ? 0 : 500;
}
