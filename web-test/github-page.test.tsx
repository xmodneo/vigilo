import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { GitHubConnectionView } from '../app/app/github/github-connection-view.js';

test('GitHub connection page renders the disconnected installation action', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView installation={null} workspaceId="workspace-1" />,
  );

  assert.match(html, /GitHub connection/);
  assert.match(html, /Not connected/);
  assert.match(html, /action="\/api\/github\/installations"/);
  assert.match(html, /method="post"/);
  assert.match(html, /Repository selection comes next/);
});

test('GitHub connection page renders only stable connected installation facts', () => {
  const html = renderToStaticMarkup(
    <GitHubConnectionView
      installation={{
        accountLogin: 'octo-org',
        accountType: 'Organization',
        installationId: 7001,
        status: 'active',
      }}
      workspaceId="workspace-1"
    />,
  );

  assert.match(html, /Connected/);
  assert.match(html, /octo-org/);
  assert.match(html, /Organization/);
  assert.match(html, /active/);
  assert.doesNotMatch(html, /access[_ -]?token|private[_ -]?key|client[_ -]?secret/i);
});
