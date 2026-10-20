import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

// The page's DOM patcher, lifted out of public/app.js and run against linkedom.
function loadSetHtml() {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const helper = src.slice(src.indexOf('const TIME_TEXT'), src.indexOf('// ---------- Search engine'));
  const { document } = parseHTML('<html><body><div id="r"></div></body></html>');
  const { setHtml } = new Function('document', `${helper}\nreturn { setHtml };`)(document);
  return { setHtml, el: document.getElementById('r') };
}
const story = (id, t, ago = '1m ago') => `<article class="story" data-id="${id}"><h3>${t}</h3><img src="/${id}.jpg"><time data-ts="1">${ago}</time></article>`;

test('live updates keep unchanged nodes, so images do not reload', () => {
  const { setHtml, el } = loadSetHtml();
  setHtml(el, story('a', 'A') + story('b', 'B'));
  const [a, b] = el.children;
  a.querySelector('img').loaded = true;

  setHtml(el, story('a', 'A', '2m ago') + story('b', 'B', '2m ago'));
  assert.equal(el.children[0], a, 'a relative-time change alone replaces nothing');
  assert.equal(el.children[1], b);

  setHtml(el, story('c', 'C') + story('a', 'A') + story('b', 'B2'));
  assert.deepEqual([...el.children].map((n) => n.getAttribute('data-id')), ['c', 'a', 'b']);
  assert.equal(el.children[1], a);
  assert.equal(a.querySelector('img').loaded, true);
  assert.equal(el.children[2], b, 'an edited story is patched in place');
  assert.equal(b.querySelector('h3').textContent, 'B2');

  setHtml(el, story('b', 'B2'));
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0], b);
});
