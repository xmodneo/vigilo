import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import Home from '../app/page.js';

test('landing page communicates the execution boundary and current status', () => {
  const html = renderToStaticMarkup(Home());

  assert.match(html, /sandbox-first software maintenance platform/i);
  assert.match(html, /independently verified before publication/i);
  assert.match(html, /Milestone 1 complete/i);
  assert.match(html, /Repository selection available/i);
  assert.match(html, /execution setup comes next/i);
  assert.match(html, /Sign in with GitHub/i);
});
