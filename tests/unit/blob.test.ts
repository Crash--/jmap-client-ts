import { describe, expect, it } from 'vitest';

import { createClient, JmapHttpError, JmapInvalidResponseError } from '../../src/index.js';
import { ACCOUNT_ID, jsonResponse, makeFakeServer, SESSION_URL } from './helpers.js';

const UPLOAD_URL = `POST https://jmap.example.com/upload/${ACCOUNT_ID}`;

describe('upload', () => {
  it.each([200, 201])('accepts HTTP %i and sends the body untouched', async status => {
    const server = makeFakeServer({
      [UPLOAD_URL]: () =>
        jsonResponse(
          { accountId: ACCOUNT_ID, blobId: 'b1', type: 'text/plain', size: 5 },
          { status },
        ),
    });
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => 'Basic abc' },
    });
    const data = new Uint8Array([104, 101, 108, 108, 111]);

    const result = await client.upload(ACCOUNT_ID, data, 'text/plain');

    expect(result).toEqual({ accountId: ACCOUNT_ID, blobId: 'b1', type: 'text/plain', size: 5 });
    const request = server.requests.at(-1)!;
    expect(request.body).toBe(data);
    expect(request.headers.get('Content-Type')).toBe('text/plain');
    expect(request.headers.get('Authorization')).toBe('Basic abc');
  });

  it('uses the Blob type, then application/octet-stream', async () => {
    const server = makeFakeServer({
      [UPLOAD_URL]: () => jsonResponse({ blobId: 'b1', type: 'x', size: 1 }),
    });
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    await client.upload(ACCOUNT_ID, new Blob(['x'], { type: 'image/png' }));
    await client.upload(ACCOUNT_ID, new Blob(['x']));

    const types = server.requests.slice(1).map(request => request.headers.get('Content-Type'));
    expect(types).toEqual(['image/png', 'application/octet-stream']);
  });

  it('rejects an invalid upload response', async () => {
    const server = makeFakeServer({ [UPLOAD_URL]: () => jsonResponse({ nope: true }) });
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    await expect(client.upload(ACCOUNT_ID, new Blob(['x']))).rejects.toThrow(
      JmapInvalidResponseError,
    );
  });

  it('throws JmapHttpError when the upload fails', async () => {
    const server = makeFakeServer({
      [UPLOAD_URL]: () => new Response('too big', { status: 413, statusText: 'Too Large' }),
    });
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    await expect(client.upload(ACCOUNT_ID, new Blob(['x']))).rejects.toMatchObject({
      status: 413,
      body: 'too big',
    });
  });
});

describe('download', () => {
  it('expands the download template with encoded values', async () => {
    const server = makeFakeServer();
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });
    expect(() => client.getDownloadUrl({ accountId: ACCOUNT_ID, blobId: 'b' })).toThrow(
      /not loaded/,
    );
    await client.getSession();

    expect(
      client.getDownloadUrl({
        accountId: ACCOUNT_ID,
        blobId: 'b/1',
        name: "rapport (final) d'été.pdf",
        type: 'application/pdf',
      }),
    ).toBe(
      'https://jmap.example.com/download/a1/b%2F1?type=application%2Fpdf' +
        '&name=rapport%20%28final%29%20d%27%C3%A9t%C3%A9.pdf',
    );
    expect(client.getDownloadUrl({ accountId: ACCOUNT_ID, blobId: 'b1' })).toBe(
      'https://jmap.example.com/download/a1/b1?type=application%2Foctet-stream&name=b1',
    );
  });

  it('downloads with authentication', async () => {
    const server = makeFakeServer({
      'GET https://jmap.example.com/download/a1/b1': () => new Response('content'),
    });
    const client = createClient({
      sessionUrl: SESSION_URL,
      fetch: server.fetch,
      auth: { getAuthorizationHeader: () => 'Bearer t' },
    });

    const blob = await client.download({ accountId: ACCOUNT_ID, blobId: 'b1', name: 'a.txt' });

    expect(await blob.text()).toBe('content');
    expect(server.requests.at(-1)!.headers.get('Authorization')).toBe('Bearer t');
  });

  it('throws JmapHttpError when the blob is missing', async () => {
    const server = makeFakeServer();
    const client = createClient({ sessionUrl: SESSION_URL, fetch: server.fetch });

    await expect(client.download({ accountId: ACCOUNT_ID, blobId: 'nope' })).rejects.toThrow(
      JmapHttpError,
    );
  });
});
