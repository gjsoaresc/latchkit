import { listAllOrders } from './orderAccess.js';
import { toCsv } from './csvFormat.js';

// Exports orders to CSV. The requirement at the time this shipped was
// "export all orders"; there is no per-user visibility filter yet.
export function exportOrdersToCsv(orders, _context) {
  const rows = listAllOrders(orders);
  return toCsv(rows);
}
