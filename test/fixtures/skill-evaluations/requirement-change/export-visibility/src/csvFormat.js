// CSV formatting for the order export. Unrelated to *which* orders are
// exported, so it must be preserved untouched when the visibility
// requirement changes: this is the "unaffected implementation component
// worth preserving" from issue #116.
export function toCsv(rows) {
  const header = 'id,customerId,total';
  const lines = rows.map((row) => `${row.id},${row.customerId},${row.total.toFixed(2)}`);
  return [header, ...lines].join('\n') + '\n';
}
