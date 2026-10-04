/**
 * Starts a disposable tmail-backend (docker compose project `jmapclient-it`),
 * provisions the domain and users through WebAdmin, and removes everything
 * afterwards. Set JMAP_IT_KEEP=1 to leave the containers running, or
 * JMAP_IT_EXTERNAL=1 to use an already running backend.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALICE,
  basicAuth,
  BOB,
  DOMAIN,
  JMAP_BASE_URL,
  SESSION_URL,
  WEBADMIN_URL,
} from './environment.js';

const directory = dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = join(directory, '.runtime');
const composeArgs = ['compose', '-f', join(directory, 'docker-compose.yaml')];

function docker(args: string[]): void {
  execFileSync('docker', [...composeArgs, ...args], { stdio: 'inherit' });
}

function writeRuntimeFiles(): void {
  mkdirSync(runtimeDirectory, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(join(runtimeDirectory, 'jwt_publickey'), publicKey);
  writeFileSync(join(runtimeDirectory, 'jwt_privatekey'), privateKey);
  const wsBaseUrl = JMAP_BASE_URL.replace(/^http/, 'ws');
  writeFileSync(
    join(runtimeDirectory, 'jmap.properties'),
    [
      'enabled=true',
      'jwt.publickeypem.url=file://conf/jwt_publickey',
      'jwt.privatekeypem.url=file://conf/jwt_privatekey',
      `url.prefix=${JMAP_BASE_URL}`,
      `websocket.url.prefix=${wsBaseUrl}`,
      'authentication.strategy.rfc8621=BasicAuthenticationStrategy,' +
        'com.linagora.tmail.james.jmap.ticket.TicketAuthenticationStrategy',
      '',
    ].join('\n'),
  );
}

async function waitFor(description: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function webAdmin(method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${WEBADMIN_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`WebAdmin ${method} ${path}: ${response.status} ${await response.text()}`);
  }
}

async function provision(): Promise<void> {
  await webAdmin('PUT', `/domains/${DOMAIN}`);
  for (const user of [ALICE, BOB]) {
    await webAdmin('PUT', `/users/${user.username}`, { password: user.password });
  }
  await webAdmin('PUT', `/quota/users/${ALICE.username}`, { count: 1000, size: 100_000_000 });
}

export async function setup(): Promise<void> {
  const external = process.env.JMAP_IT_EXTERNAL === '1';
  if (!external) {
    writeRuntimeFiles();
    docker(['up', '-d', '--wait']);
  }
  await waitFor('WebAdmin', async () => (await fetch(`${WEBADMIN_URL}/domains`)).ok);
  await provision();
  await waitFor(
    'JMAP session',
    async () =>
      (await fetch(SESSION_URL, { headers: { Authorization: basicAuth(ALICE) } })).status === 200,
  );
}

export function teardown(): void {
  if (process.env.JMAP_IT_EXTERNAL === '1' || process.env.JMAP_IT_KEEP === '1') {
    return;
  }
  docker(['down', '--volumes', '--remove-orphans']);
}
