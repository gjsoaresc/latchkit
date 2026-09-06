// Shared subscriber lookup, also used by a weekly digest job outside this
// small fixture. Whether an order-notification opt-out should also suppress
// that unrelated digest is unknown to this fixture and must be flagged for
// review rather than resolved either way.
export function listSubscribers(customerId) {
  return [customerId];
}
