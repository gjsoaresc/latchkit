import { renderConfirmation } from './templates.js';

// Notifies the order owner. The requirement at the time this shipped was
// "notify every order owner"; there is no opt-out check yet.
export function notifyOrderOwner(order, _context) {
  return renderConfirmation(order);
}
