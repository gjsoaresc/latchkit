import { removeProjectSkills, syncProject } from '../../dist/src/core.js';

const [root, operation, boundary] = process.argv.slice(2);
const faultBoundary = async (current) => {
  if (current !== boundary) return;
  process.send?.({ boundary: current });
  await new Promise(() => {});
};

await (operation === 'remove'
  ? removeProjectSkills(root, { faultBoundary })
  : syncProject(root, { faultBoundary }));
