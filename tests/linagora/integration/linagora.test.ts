/**
 * The Linagora methods against tmail-backend (memory image). Each run uses
 * a fresh user, so that the singletons (Forward, Filter, Settings) start
 * from their defaults.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { assertSetSucceeded, createClient } from '../../../src/index.js';
import type { JmapClient, Mailbox } from '../../../src/index.js';
import {
  LINAGORA_CAPABILITIES,
  LINAGORA_METHOD_CAPABILITIES,
} from '../../../src/linagora/index.js';
import { basicAuth, DOMAIN, SESSION_URL, WEBADMIN_URL } from '../../integration/environment.js';

const user = { username: `linagora-${Date.now()}@${DOMAIN}`, password: 'linagora-password' };

/** A 1×1 transparent PNG. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  character => character.charCodeAt(0),
);

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//jmap-client-ts//tests//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:jmap-client-ts-integration',
  'DTSTAMP:20260101T080000Z',
  'DTSTART:20260110T090000Z',
  'DTEND:20260110T100000Z',
  'SUMMARY:Integration meeting',
  'LOCATION:Room 42',
  'ORGANIZER;CN=Bob:mailto:bob@example.com',
  'ATTENDEE;CN=Alice;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

let client: JmapClient;
let accountId = '';
let mailboxes: Pick<Mailbox, 'id' | 'role' | 'name'>[] = [];

async function waitFor<T>(description: string, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function mailboxId(role: string): string {
  const mailbox = mailboxes.find(candidate => candidate.role === role);
  if (mailbox === undefined) {
    throw new Error(`No ${role} mailbox`);
  }
  return mailbox.id;
}

/** Creates an email in a mailbox and returns its id. */
async function createEmail(subject: string, inMailboxId: string): Promise<string> {
  const response = await client.call('Email/set', {
    accountId,
    create: {
      email: {
        mailboxIds: { [inMailboxId]: true },
        from: [{ name: null, email: user.username }],
        to: [{ name: null, email: user.username }],
        subject,
        bodyValues: { body: { value: subject } },
        textBody: [{ partId: 'body', type: 'text/plain' }],
      },
    },
  });
  assertSetSucceeded(response);
  return response.created!.email!.id;
}

beforeAll(async () => {
  const created = await fetch(`${WEBADMIN_URL}/users/${user.username}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: user.password }),
  });
  expect(created.ok).toBe(true);
  client = createClient({
    sessionUrl: SESSION_URL,
    auth: { getAuthorizationHeader: () => basicAuth(user) },
    methodCapabilities: LINAGORA_METHOD_CAPABILITIES,
  });
  await client.getSession();
  accountId = client.getPrimaryAccountId();
  // A new account gets its mailboxes on its first request
  mailboxes = await waitFor('the default mailboxes', async () => {
    const { list } = await client.call('Mailbox/get', {
      accountId,
      ids: null,
      properties: ['role', 'name'],
    });
    return list.some(mailbox => mailbox.role === 'inbox') ? list : null;
  });
});

describe('tmail-backend Linagora extensions', () => {
  it('advertises the extensions', () => {
    for (const capability of [
      LINAGORA_CAPABILITIES.labels,
      LINAGORA_CAPABILITIES.forward,
      LINAGORA_CAPABILITIES.filter,
      LINAGORA_CAPABILITIES.settings,
      LINAGORA_CAPABILITIES.messagesVault,
      LINAGORA_CAPABILITIES.publicAssets,
      LINAGORA_CAPABILITIES.mailboxClear,
      LINAGORA_CAPABILITIES.calendarEvent,
    ]) {
      expect(client.hasCapability(capability), capability).toBe(true);
    }
  });

  it('creates, follows, updates and destroys labels', async () => {
    const before = await client.call('Label/get', { accountId, ids: null });

    const [set, created] = await client.request(b => {
      const s = b.call('Label/set', {
        accountId,
        create: { work: { displayName: 'Work', color: '#0080ff', description: 'Job' } },
      });
      const g = b.call('Label/get', {
        accountId,
        ids: null,
        properties: ['displayName', 'keyword', 'color', 'description', 'readOnly'],
      });
      return [s, g];
    });
    const label = set.created!.work!;
    expect(label).toEqual({ id: expect.any(String), keyword: expect.any(String) });
    expect(created.list).toEqual([
      {
        id: label.id,
        displayName: 'Work',
        keyword: label.keyword,
        color: '#0080ff',
        description: 'Job',
        readOnly: false,
      },
    ]);

    const changes = await client.call('Label/changes', { accountId, sinceState: before.state });
    expect(changes.created).toEqual([label.id]);

    // The keyword of a label tags emails
    const emailId = await createEmail('Labelled', mailboxId('inbox'));
    await client.call('Email/set', {
      accountId,
      update: { [emailId]: { [`keywords/${label.keyword!}`]: true } },
    });
    const tagged = await client.call('Email/query', {
      accountId,
      filter: { hasKeyword: label.keyword! },
    });
    expect(tagged.ids).toEqual([emailId]);

    const updated = await client.call('Label/set', {
      accountId,
      update: { [label.id]: { color: '#ff0000' } },
    });
    expect(Object.keys(updated.updated ?? {})).toEqual([label.id]);

    const destroyed = await client.call('Label/set', { accountId, destroy: [label.id] });
    expect(destroyed.destroyed).toEqual([label.id]);
  });

  it('reads and updates the forwards', async () => {
    const initial = await client.call('Forward/get', { accountId, ids: ['singleton'] });
    expect(initial.list).toEqual([{ id: 'singleton', localCopy: true, forwards: [] }]);

    await client.call('Forward/set', {
      accountId,
      update: { singleton: { localCopy: false, forwards: [`bob@${DOMAIN}`] } },
    });
    const forwarded = await client.call('Forward/get', { accountId, ids: ['singleton'] });
    expect(forwarded.list[0]).toEqual({
      id: 'singleton',
      localCopy: false,
      forwards: [`bob@${DOMAIN}`],
    });

    await client.call('Forward/set', {
      accountId,
      update: { singleton: { localCopy: true, forwards: [] } },
    });
  });

  it('replaces the filtering rules, read back without their ids', async () => {
    const initial = await client.call('Filter/get', { accountId, ids: ['singleton'] });
    expect(initial.list).toEqual([{ id: 'singleton', rules: [] }]);

    const set = await client.call('Filter/set', {
      accountId,
      ifInState: initial.state,
      update: {
        singleton: [
          {
            id: 'r1',
            name: 'Reject',
            conditionGroup: {
              conditionCombiner: 'OR',
              conditions: [
                { field: 'from', comparator: 'contains', value: 'spammer' },
                { field: 'subject', comparator: 'start-with', value: '[ad]' },
              ],
            },
            action: { appendIn: { mailboxIds: [] }, reject: true },
          },
          {
            id: 'r2',
            name: 'Archive',
            condition: { field: 'to', comparator: 'exactly-equals', value: 'list@example.com' },
            action: {
              appendIn: { mailboxIds: [mailboxId('archive')] },
              markAsSeen: true,
              withKeywords: ['list'],
            },
          },
        ],
      },
    });
    expect(set.updated).toEqual({ singleton: {} });

    const { list } = await client.call('Filter/get', { accountId, ids: ['singleton'] });
    expect(list[0]!.rules).toEqual([
      {
        name: 'Reject',
        conditionGroup: {
          conditionCombiner: 'OR',
          conditions: [
            { field: 'from', comparator: 'contains', value: 'spammer' },
            { field: 'subject', comparator: 'start-with', value: '[ad]' },
          ],
        },
        condition: { field: 'from', comparator: 'contains', value: 'spammer' },
        action: {
          appendIn: { mailboxIds: [] },
          markAsSeen: false,
          markAsImportant: false,
          reject: true,
          withKeywords: [],
        },
      },
      expect.objectContaining({
        name: 'Archive',
        conditionGroup: {
          conditionCombiner: 'AND',
          conditions: [{ field: 'to', comparator: 'exactly-equals', value: 'list@example.com' }],
        },
      }),
    ]);

    await client.call('Filter/set', { accountId, update: { singleton: [] } });
  });

  it('patches the settings key by key', async () => {
    await client.call('Settings/set', {
      accountId,
      update: {
        singleton: { 'settings/language': 'fr', 'settings/read.receipts.always': 'true' },
      },
    });
    const [settings] = await client.request(b => [
      b.call('Settings/get', { accountId, ids: null }),
      b.call('Settings/set', {
        accountId,
        update: { singleton: { 'settings/read.receipts.always': 'false' } },
      }),
    ]);
    expect(settings.list).toEqual([
      { id: 'singleton', settings: { language: 'fr', 'read.receipts.always': 'true' } },
    ]);

    const { list } = await client.call('Settings/get', { accountId, ids: ['singleton'] });
    expect(list[0]!.settings).toEqual({ language: 'fr', 'read.receipts.always': 'false' });
  });

  it('restores deleted emails from the vault', async () => {
    const subject = `Recover me ${Date.now()}`;
    const emailId = await createEmail(subject, mailboxId('inbox'));
    await client.call('Email/set', { accountId, destroy: [emailId] });

    const set = await client.call('EmailRecoveryAction/set', {
      accountId,
      create: { recover: { subject } },
    });
    const taskId = set.created!.recover!.id;

    const done = await waitFor('the recovery task', async () => {
      const { list, notFound } = await client.call('EmailRecoveryAction/get', {
        accountId,
        ids: [taskId],
        properties: ['status', 'successfulRestoreCount', 'errorRestoreCount'],
      });
      expect(notFound).toEqual([]);
      const action = list[0]!;
      return ['waiting', 'inProgress'].includes(action.status) ? null : action;
    });
    expect(done).toEqual({
      id: taskId,
      status: 'completed',
      successfulRestoreCount: 1,
      errorRestoreCount: 0,
    });

    const canceled = await client.call('EmailRecoveryAction/set', {
      accountId,
      update: { [taskId]: { status: 'canceled' } },
    });
    expect(canceled.notUpdated?.[taskId]?.type).toBe('invalidStatus');
  });

  it('publishes an image as a public asset', async () => {
    const { blobId } = await client.upload(accountId, PNG, 'image/png');
    const set = await client.call('PublicAsset/set', {
      accountId,
      create: { image: { blobId } },
    });
    const assetId = set.created!.image!.id;

    const { list } = await client.call('PublicAsset/get', { accountId, ids: [assetId] });
    expect(list).toEqual([
      {
        id: assetId,
        // tmail-backend puts the username where its documentation says the account id
        publicURI: expect.stringMatching(new RegExp(`/publicAsset/[^/]+/${assetId}$`)),
        size: PNG.byteLength,
        contentType: 'image/png',
        identityIds: {},
      },
    ]);
    // Served without authentication
    const image = await fetch(list[0]!.publicURI);
    expect(image.status).toBe(200);

    const destroyed = await client.call('PublicAsset/set', { accountId, destroy: [assetId] });
    expect(destroyed.destroyed).toEqual([assetId]);
  });

  it('clears a mailbox', async () => {
    const set = await client.call('Mailbox/set', {
      accountId,
      create: { folder: { name: 'To clear' } },
    });
    const folderId = set.created!.folder!.id;
    await createEmail('One', folderId);
    await createEmail('Two', folderId);

    const cleared = await client.call('Mailbox/clear', { accountId, mailboxId: folderId });

    expect(cleared).toEqual({ accountId, totalDeletedMessagesCount: 2 });
  });

  it('parses a calendar invitation', async () => {
    const { blobId } = await client.upload(
      accountId,
      new TextEncoder().encode(ICS),
      'text/calendar',
    );

    const response = await client.call('CalendarEvent/parse', {
      accountId,
      blobIds: [blobId, 'unknown'],
      properties: ['uid', 'title', 'location', 'method', 'organizer'],
    });

    expect(response.parsed?.[blobId]).toEqual([
      {
        uid: 'jmap-client-ts-integration',
        title: 'Integration meeting',
        location: 'Room 42',
        method: 'REQUEST',
        organizer: { name: 'Bob', mailto: 'bob@example.com' },
      },
    ]);
    expect([...(response.notFound ?? []), ...(response.notParsable ?? [])]).toEqual(['unknown']);
  });

  it('autocompletes contacts', async () => {
    const response = await client.call('TMailContact/autocomplete', {
      accountId,
      filter: { text: 'nobody-matches-this' },
      limit: 5,
    });
    expect(response).toMatchObject({ accountId, list: [] });
  });
});
