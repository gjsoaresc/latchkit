// Shared order-listing helper. It is also used by an admin reporting job that
// is outside this small fixture. Narrowing what it returns for the exporter's
// benefit could silently change what that other consumer sees too, and this
// fixture has no way to know. Its impact is seeded as genuinely unknown: a
// careful change should flag it for review rather than resolve it either way.
export function listAllOrders(orders) {
  return orders.slice();
}
