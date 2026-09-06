// Confirmation-email rendering. Unrelated to *whether* an owner should be
// notified, so it must be preserved untouched when the opt-out requirement
// is added: the "unaffected implementation component worth preserving".
export function renderConfirmation(order) {
  return `Your order ${order.id} totaling $${order.total.toFixed(2)} has been placed.`;
}
