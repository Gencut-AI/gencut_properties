import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { migrateUp } from '../../db/src/migrate.ts';
import { type TestDb, createTestDb } from '../../db/test/helpers.ts';
import {
  checkInstagramNow,
  createDb,
  dismissInstagramComment,
  ensureWorkspace,
  getInstagramView,
  GraphInstagramClient,
  type IgComment,
  type InstagramClient,
  type InstagramConfig,
  instagramCheckDue,
  instagramConfigFromEnv,
  type RequestContext,
  saveBusinessProfile,
  sendInstagramLink,
  ServiceError,
  type Sql,
  syncInstagramComments,
} from '../src/index.ts';

// Synthetic accounts and comments.
const user = (): RequestContext => {
  const id = randomUUID();
  return { userId: id, email: `agent-${id.slice(0, 8)}@example.com`, via: 'web' };
};

class FakeInstagram implements InstagramClient {
  replies: { commentId: string; text: string }[] = [];
  failReply: string | null = null;
  byMedia: Record<string, IgComment[]>;
  constructor(byMedia: Record<string, IgComment[]>) {
    this.byMedia = byMedia;
  }
  async account() {
    return { userId: '1784', username: 'agent.example' };
  }
  async recentMedia() {
    return Object.keys(this.byMedia).map((id) => ({ id, permalink: `https://instagram.example/p/${id}` }));
  }
  async comments(mediaId: string) {
    return this.byMedia[mediaId] ?? [];
  }
  async privateReply(_u: string, commentId: string, text: string) {
    if (this.failReply) throw new Error(this.failReply);
    this.replies.push({ commentId, text });
    return 'mid.1';
  }
}

const comment = (id: string, username: string, text: string, at = new Date()): IgComment => ({ id, text, username, fromId: `u-${username}`, timestamp: at });

describe('instagram comments', () => {
  let tdb: TestDb;
  let sql: Sql;
  before(() => {
    tdb = createTestDb();
    migrateUp(tdb.url);
    sql = createDb(tdb.url, { max: 4 });
  });
  after(async () => {
    await sql.end();
    tdb.drop();
  });

  async function connected() {
    const u = user();
    const { workspaceId } = await ensureWorkspace(sql, u);
    await saveBusinessProfile(sql, u, workspaceId, { licenseeName: 'Ana Test', brokerageName: 'Example Bay Realty LLC', market: 'miami-dade', focusZips: ['33180'], propertyUses: ['single_family'] });
    const config: InstagramConfig = { accessToken: 'test-ig-token', workspaceId, keywords: ['VALUE', 'SEND'] };
    return { u, workspaceId, config };
  }

  it('keeps only keyword comments from other people, once each', async () => {
    const { u, workspaceId, config } = await connected();
    const fake = new FakeInstagram({
      m1: [comment('c1', 'buyer.one', 'VALUE please'), comment('c2', 'friend', 'Nice!'), comment('c3', 'agent.example', 'value is up')],
      m2: [comment('c4', 'seller.two', 'send me the info')],
    });
    assert.equal(await instagramCheckDue(sql, workspaceId), true);
    assert.deepEqual(await syncInstagramComments(sql, config, fake), { checked: true, found: 2, error: null });
    assert.deepEqual(await syncInstagramComments(sql, config, fake), { checked: true, found: 0, error: null }, 'no duplicates');
    assert.equal(await instagramCheckDue(sql, workspaceId), false);

    const view = await getInstagramView(sql, u, workspaceId, config);
    assert.equal(view.connected, true);
    assert.equal(view.username, 'agent.example');
    assert.deepEqual(view.comments.map((c) => [c.username, c.keyword]).sort(), [['buyer.one', 'VALUE'], ['seller.two', 'SEND']]);
    // Another workspace sees nothing of it.
    const other = user();
    const { workspaceId: ws2 } = await ensureWorkspace(sql, other);
    assert.equal((await getInstagramView(sql, other, ws2, config)).connected, false);
    await assert.rejects(checkInstagramNow(sql, other, ws2, config, fake), /not connected/);
  });

  it('sends one approved private reply with the link, records failures, and respects the 7-day window', async () => {
    const { u, workspaceId, config } = await connected();
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const fake = new FakeInstagram({ m1: [comment('d1', 'buyer.one', 'VALUE'), comment('d2', 'late.one', 'VALUE', old)] });
    await syncInstagramComments(sql, config, fake);
    const link = 'https://gencut.example/l/ana-test-abc123?src=instagram';

    fake.failReply = 'Instagram refused the request (400, code 10): no permission';
    assert.deepEqual(await sendInstagramLink(sql, u, workspaceId, 'd1', link, config, fake), { sent: false, error: fake.failReply });
    fake.failReply = null;
    assert.deepEqual(await sendInstagramLink(sql, u, workspaceId, 'd1', link, config, fake), { sent: true, error: null });
    assert.equal(fake.replies.length, 1);
    assert.ok(fake.replies[0]!.text.includes(link) && fake.replies[0]!.text.startsWith('Hi @buyer.one'));
    await assert.rejects(sendInstagramLink(sql, u, workspaceId, 'd1', link, config, fake), /already sent/);
    await assert.rejects(sendInstagramLink(sql, u, workspaceId, 'd2', link, config, fake), /within 7 days/);
    const view = await getInstagramView(sql, u, workspaceId, config);
    assert.deepEqual(view.comments.map((c) => [c.id, c.replyState, c.canReply]).sort(), [['d1', 'sent', false], ['d2', 'none', false]]);

    await dismissInstagramComment(sql, u, workspaceId, 'd2');
    assert.deepEqual((await getInstagramView(sql, u, workspaceId, config)).comments.map((c) => c.id), ['d1']);
    await assert.rejects(sendInstagramLink(sql, user(), workspaceId, 'd1', link, config, fake), (e: ServiceError) => e.code === 'forbidden');
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'instagram_comment' AND workspace_id = ${workspaceId}`;
    assert.equal(n?.n, 5); // 2 found, 1 failed, 1 sent, 1 dismissed
  });

  it('records an unreachable account instead of failing the page', async () => {
    const { workspaceId, config } = await connected();
    const broken = new FakeInstagram({});
    broken.account = async () => {
      throw new Error('Instagram refused the request (401, code 190): token expired');
    };
    const r = await syncInstagramComments(sql, config, broken);
    assert.equal(r.checked, false);
    const [a] = await sql<{ last_error: string }[]>`SELECT last_error FROM instagram_accounts WHERE workspace_id = ${workspaceId}`;
    assert.match(a?.last_error ?? '', /token expired/);
  });

  it('reads configuration and calls graph.instagram.com with the token only in a header', async () => {
    assert.equal(instagramConfigFromEnv({ INSTAGRAM_ACCESS_TOKEN: 't' }), null);
    const ws = randomUUID();
    assert.deepEqual(instagramConfigFromEnv({ INSTAGRAM_ACCESS_TOKEN: ' t ', INSTAGRAM_WORKSPACE_ID: ws, INSTAGRAM_KEYWORDS: 'value' }), {
      accessToken: 't', workspaceId: ws, keywords: ['VALUE'],
    });
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const ok = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/me?')) return Response.json({ user_id: '1784', username: 'agent.example' });
      if (String(url).includes('/comments')) return Response.json({ data: [{ id: 'c1', text: 'VALUE', timestamp: '2026-10-29T12:00:00+0000', from: { id: '9', username: 'buyer.one' } }] });
      if (String(url).endsWith('/messages')) return Response.json({ recipient_id: '9', message_id: 'mid.1' });
      return Response.json({ data: [{ id: 'm1', permalink: 'https://instagram.example/p/m1' }] });
    }) as typeof fetch;
    const c = new GraphInstagramClient('test-ig-token', ok);
    assert.deepEqual(await c.account(), { userId: '1784', username: 'agent.example' });
    assert.deepEqual(await c.recentMedia('1784', 10), [{ id: 'm1', permalink: 'https://instagram.example/p/m1' }]);
    assert.equal((await c.comments('m1'))[0]?.username, 'buyer.one');
    assert.equal(await c.privateReply('1784', 'c1', 'hi'), 'mid.1');
    assert.ok(calls.every((x) => x.url.startsWith('https://graph.instagram.com/v26.0/') && !x.url.includes('test-ig-token')));
    assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, 'Bearer test-ig-token');
    assert.deepEqual(JSON.parse(String(calls[3]!.init!.body)), { recipient: { comment_id: 'c1' }, message: { text: 'hi' } });
    const denied = (async () => Response.json({ error: { message: 'Invalid token test-ig-token', code: 190 } }, { status: 401 })) as typeof fetch;
    await assert.rejects(new GraphInstagramClient('test-ig-token', denied).account(), (e: Error) => /401, code 190/.test(e.message) && !e.message.includes('test-ig-token'));
  });
});
