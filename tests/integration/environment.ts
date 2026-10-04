/** Where the integration backend listens and who uses it. */
export const JMAP_PORT = Number(process.env.JMAP_IT_JMAP_PORT ?? 18100);
export const WEBADMIN_PORT = Number(process.env.JMAP_IT_WEBADMIN_PORT ?? 18101);
export const JMAP_BASE_URL = `http://127.0.0.1:${JMAP_PORT}`;
export const WEBADMIN_URL = `http://127.0.0.1:${WEBADMIN_PORT}`;
export const SESSION_URL = `${JMAP_BASE_URL}/jmap/session`;
export const DOMAIN = 'example.com';
export const ALICE = { username: `alice@${DOMAIN}`, password: 'alice-password' };
export const BOB = { username: `bob@${DOMAIN}`, password: 'bob-password' };

export function basicAuth(user: { username: string; password: string }): string {
  return `Basic ${Buffer.from(`${user.username}:${user.password}`).toString('base64')}`;
}
