import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nginxConfig } from './server.mjs';

test('direct REST calls use the app access policy without blocking sign-in', () => {
  const config = nginxConfig({
    serverUrl: 'https://reader.example',
    certificate: '/cert.pem', certificateKey: '/key.pem', dataDir: '/data',
    ports: { client: 3000, kong: 8000, s3: 9000 },
  });
  assert.match(config, /location \/rest\/v1\/ \{\s*auth_request \/_readest_access;/);
  assert.match(config, /location = \/_readest_access \{\s*internal;\s*proxy_pass http:\/\/127\.0\.0\.1:3000\/api\/auth\/access;/);
  const authBlock = config.match(/location \/auth\/v1\/ \{([^}]+)\}/)?.[1];
  assert.ok(authBlock);
  assert.doesNotMatch(authBlock, /auth_request/);
});
