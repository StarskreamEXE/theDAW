import { open, mark, shot } from './lib.mjs';
const { browser, page } = await open();
const miss = await mark(page, [
  { n: 1, target: page.getByRole('button', { name: 'Make', exact: true }) },
  { n: 2, target: page.getByRole('button', { name: 'Import', exact: true }) },
]);
console.log('missing', miss);
await shot(page, '_smoke', { title: 'SMOKE TEST', subtitle: 'helper check' });
await browser.close();
