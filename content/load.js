// Content loading that works both in the browser (fetch) and in Node
// (fs), so sim.js and index.html read exactly the same JSON.

const FILES = {
  abilities: 'abilities.json',
  auras: 'auras.json',
  units: 'units.json',
  parties: 'parties.json',
};

const BOSSES = ['chthon'];
const AI = ['tank', 'healer', 'dps'];

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

async function readJson(relative) {
  const url = new URL(relative, import.meta.url);
  if (isNode) {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(url, 'utf8'));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${relative}: ${res.status}`);
  return res.json();
}

export async function loadContent() {
  const content = { bosses: {}, ai: {} };
  await Promise.all([
    ...Object.entries(FILES).map(async ([key, file]) => {
      content[key] = await readJson(file);
    }),
    ...BOSSES.map(async (id) => {
      content.bosses[id] = await readJson(`bosses/${id}.json`);
    }),
    ...AI.map(async (id) => {
      content.ai[id] = await readJson(`ai/${id}.json`);
    }),
  ]);
  return content;
}
