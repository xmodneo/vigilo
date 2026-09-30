import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import Home from '../app/page.js';

test('landing page communicates the execution boundary and current status', () => {
  const html = renderToStaticMarkup(Home());

  assert.match(html, /repair garage for AI builders/i);
  assert.match(html, /fresh verification environment/i);
  assert.match(html, /Controlled beta limitations apply/i);
  assert.match(html, /eligible public, single-package Node\.js 24\/npm repositories/i);
  assert.doesNotMatch(html, /Milestone 1 complete|execution setup comes next|Autonomous software maintenance/i);
  assert.match(html, /Sign in with GitHub/i);
});
