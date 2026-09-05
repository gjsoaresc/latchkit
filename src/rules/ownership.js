import { createHash } from 'node:crypto';

export const SECTION_START = '<!-- latchkit:project-instructions:start -->';
export const SECTION_END = '<!-- latchkit:project-instructions:end -->';

export const digest = (content) => createHash('sha256').update(content).digest('hex');

export function lineEndingOf(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function findManagedSection(content) {
  const start = content.indexOf(SECTION_START);
  const end = content.indexOf(SECTION_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end === -1 || end < start || content.indexOf(SECTION_START, start + 1) !== -1)
    throw new Error('Latchkit project instruction markers are incomplete or duplicated.');
  const after = end + SECTION_END.length;
  return { start, end: after, content: content.slice(start, after) };
}

export function renderManagedSection(body, newline = '\n') {
  const normalized = body.replaceAll('\r\n', '\n').trimEnd().replaceAll('\n', newline);
  return `${SECTION_START}${newline}${normalized}${newline}${SECTION_END}`;
}

export function mergeManagedSection(current, body) {
  const newline = lineEndingOf(current);
  const nextSection = renderManagedSection(body, newline);
  const existing = findManagedSection(current);
  if (existing)
    return `${current.slice(0, existing.start)}${nextSection}${current.slice(existing.end)}`;
  if (!current) return `${nextSection}${newline}`;
  const separator = current.endsWith(newline + newline)
    ? ''
    : current.endsWith(newline)
      ? newline
      : newline + newline;
  return `${current}${separator}${nextSection}${newline}`;
}

export function removeManagedSection(current) {
  const existing = findManagedSection(current);
  if (!existing) return current;
  let start = existing.start;
  let end = existing.end;
  if (start > 0 && current.slice(0, start).endsWith('\r\n\r\n')) start -= 2;
  else if (start > 0 && current.slice(0, start).endsWith('\n\n')) start -= 1;
  if (current.slice(end, end + 2) === '\r\n') end += 2;
  else if (current[end] === '\n') end += 1;
  return current.slice(0, start) + current.slice(end);
}
