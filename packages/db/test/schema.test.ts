import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_ENTITY_TYPES,
  AUDIT_INTERFACES,
  CAMPAIGN_STATES,
  CHANNELS,
  CONSENT_SCOPES,
  CONTACT_BASES,
  MEDIA_ASSET_KINDS,
  MEDIA_CONTENT_TYPES,
  MEDIA_STATES,
  OUTREACH_STATES,
  type OutreachState,
  isLegalOutreachTransition,
} from '../../core/src/index.ts';
import { migrateUp } from '../src/migrate.ts';
import { type TestDb, createTestDb, expectSqlError } from './helpers.ts';

const USER = '11111111-1111-1111-1111-111111111111';

describe('schema matches the domain model', () => {
  let db: TestDb;
  let workspace: string;
  let campaign: string;

  before(() => {
    db = createTestDb();
    migrateUp(db.url);
    db.query(`INSERT INTO users (id, email) VALUES ('${USER}', 'agent@example.com')`);
    workspace = db.query(`INSERT INTO workspaces (name) VALUES ('Test Realty') RETURNING id`);
    campaign = db.query(
      `INSERT INTO campaigns (workspace_id, title, objective) VALUES ('${workspace}', 'Palm Way', 'Win listing') RETURNING id`,
    );
  });
  after(() => db.drop());

  it('accepts every campaign state from core and rejects others', () => {
    for (const s of CAMPAIGN_STATES) {
      db.query(`INSERT INTO campaigns (workspace_id, title, objective, status) VALUES ('${workspace}', 't', 'o', '${s}')`);
    }
    expectSqlError(db, `INSERT INTO campaigns (workspace_id, title, objective, status) VALUES ('${workspace}', 't', 'o', 'live')`);
  });

  it('accepts every channel, consent scope, contact basis, actor type and interface from core', () => {
    for (const c of CHANNELS) {
      db.query(`INSERT INTO suppressions (workspace_id, channel, address, reason) VALUES ('${workspace}', '${c}', 'x-${c}', 'test')`);
    }
    db.query(
      `INSERT INTO consents (workspace_id, channel, address, scopes, written_signature, disclosure_shown, obtained_at)
       VALUES ('${workspace}', 'sms', '+13055550100', ARRAY[${CONSENT_SCOPES.map((s) => `'${s}'`).join(',')}], true, true, now())`,
    );
    for (const b of CONTACT_BASES) {
      db.query(`INSERT INTO prospects (workspace_id, display_name, contact_basis) VALUES ('${workspace}', 'p', '${b}')`);
    }
    for (const a of AUDIT_ACTOR_TYPES) {
      for (const v of AUDIT_INTERFACES) {
        db.query(
          `INSERT INTO audit_events (workspace_id, actor_type, via, entity_type, entity_id, action) VALUES ('${workspace}', '${a}', '${v}', 'campaign', '${campaign}', 'test')`,
        );
      }
    }
    for (const e of AUDIT_ENTITY_TYPES) {
      db.query(
        `INSERT INTO audit_events (workspace_id, actor_type, via, entity_type, entity_id, action) VALUES ('${workspace}', 'system', 'api', '${e}', 'x', 'test')`,
      );
    }
    expectSqlError(
      db,
      `INSERT INTO audit_events (workspace_id, actor_type, via, entity_type, entity_id, action) VALUES ('${workspace}', 'system', 'api', 'invoice', 'x', 'test')`,
    );
    expectSqlError(db, `INSERT INTO suppressions (workspace_id, channel, address, reason) VALUES ('${workspace}', 'fax', 'x', 'r')`);
    expectSqlError(
      db,
      `INSERT INTO consents (workspace_id, channel, address, scopes, written_signature, disclosure_shown, obtained_at)
       VALUES ('${workspace}', 'sms', 'x', ARRAY['robocalls'], true, true, now())`,
    );
  });

  it('enforces exactly the outreach transitions core allows (all 36 pairs)', () => {
    const approve = `, approved_by = '${USER}', approved_at = now()`;
    const pathTo: Record<OutreachState, string[]> = {
      DRAFT: [],
      READY: ["state = 'READY'"],
      APPROVED: ["state = 'READY'", `state = 'APPROVED'${approve}`],
      EXECUTING: ["state = 'READY'", `state = 'APPROVED'${approve}`, "state = 'EXECUTING'"],
      COMPLETED: ["state = 'READY'", `state = 'APPROVED'${approve}`, "state = 'EXECUTING'", "state = 'COMPLETED'"],
      FAILED: ["state = 'READY'", `state = 'APPROVED'${approve}`, "state = 'FAILED'"],
    };
    for (const from of OUTREACH_STATES) {
      for (const to of OUTREACH_STATES) {
        if (from === to) continue;
        const id = db.query(
          `INSERT INTO outreach_actions (workspace_id, campaign_id, channel, subject_key, content)
           VALUES ('${workspace}', '${campaign}', 'email', 's', '{"text":"hi"}') RETURNING id`,
        );
        for (const set of pathTo[from]) db.query(`UPDATE outreach_actions SET ${set} WHERE id = '${id}'`);
        const set = to === 'APPROVED' ? `state = 'APPROVED'${approve}` : `state = '${to}'`;
        const sql = `UPDATE outreach_actions SET ${set} WHERE id = '${id}'`;
        if (isLegalOutreachTransition(from, to)) {
          db.query(sql);
          assert.equal(db.query(`SELECT state FROM outreach_actions WHERE id = '${id}'`), to, `${from}->${to}`);
        } else {
          expectSqlError(db, sql);
          assert.equal(db.query(`SELECT state FROM outreach_actions WHERE id = '${id}'`), from, `${from}->${to}`);
        }
      }
    }
  });

  it('creates actions only as DRAFT and never approved without an approver', () => {
    expectSqlError(
      db,
      `INSERT INTO outreach_actions (workspace_id, campaign_id, channel, subject_key, content, state)
       VALUES ('${workspace}', '${campaign}', 'email', 's', '{}', 'APPROVED')`,
    );
    const id = db.query(
      `INSERT INTO outreach_actions (workspace_id, campaign_id, channel, subject_key, content)
       VALUES ('${workspace}', '${campaign}', 'email', 's', '{}') RETURNING id`,
    );
    db.query(`UPDATE outreach_actions SET state = 'READY' WHERE id = '${id}'`);
    expectSqlError(db, `UPDATE outreach_actions SET state = 'APPROVED' WHERE id = '${id}'`);
  });

  it('freezes approved content and clears approval when returning to draft', () => {
    const id = db.query(
      `INSERT INTO outreach_actions (workspace_id, campaign_id, channel, subject_key, content)
       VALUES ('${workspace}', '${campaign}', 'email', 's', '{"text":"v1"}') RETURNING id`,
    );
    db.query(`UPDATE outreach_actions SET state = 'READY' WHERE id = '${id}'`);
    db.query(`UPDATE outreach_actions SET state = 'APPROVED', approved_by = '${USER}', approved_at = now() WHERE id = '${id}'`);
    expectSqlError(db, `UPDATE outreach_actions SET content = '{"text":"v2"}' WHERE id = '${id}'`);
    db.query(`UPDATE outreach_actions SET state = 'DRAFT', content = '{"text":"v2"}' WHERE id = '${id}'`);
    assert.equal(db.query(`SELECT coalesce(approved_by::text, 'none') FROM outreach_actions WHERE id = '${id}'`), 'none');
  });

  it('keeps the audit log append-only', () => {
    const id = db.query(
      `INSERT INTO audit_events (workspace_id, actor_type, via, entity_type, entity_id, action)
       VALUES ('${workspace}', 'user', 'web', 'campaign', '${campaign}', 'approve') RETURNING id`,
    );
    assert.match(expectSqlError(db, `UPDATE audit_events SET action = 'x' WHERE id = ${id}`), /append-only/);
    assert.match(expectSqlError(db, `DELETE FROM audit_events WHERE id = ${id}`), /append-only/);
  });

  it('requires a channel for contact grants only, one active grant each', () => {
    db.query(`INSERT INTO workspace_permissions (workspace_id, kind) VALUES ('${workspace}', 'discover')`);
    db.query(`INSERT INTO workspace_permissions (workspace_id, kind, channel) VALUES ('${workspace}', 'contact', 'email')`);
    expectSqlError(db, `INSERT INTO workspace_permissions (workspace_id, kind) VALUES ('${workspace}', 'contact')`);
    expectSqlError(db, `INSERT INTO workspace_permissions (workspace_id, kind, channel) VALUES ('${workspace}', 'generate', 'email')`);
    expectSqlError(db, `INSERT INTO workspace_permissions (workspace_id, kind, channel) VALUES ('${workspace}', 'contact', 'email')`);
    db.query(`UPDATE workspace_permissions SET revoked_at = now() WHERE workspace_id = '${workspace}' AND channel = 'email'`);
    db.query(`INSERT INTO workspace_permissions (workspace_id, kind, channel) VALUES ('${workspace}', 'contact', 'email')`);
  });

  it('treats suppressed addresses case-insensitively', () => {
    db.query(`INSERT INTO suppressions (workspace_id, address, reason) VALUES ('${workspace}', 'Owner@Example.com', 'opt-out')`);
    expectSqlError(db, `INSERT INTO suppressions (workspace_id, address, reason) VALUES ('${workspace}', 'owner@example.com', 'opt-out')`);
  });

  it('requires a brokerage name on the business profile', () => {
    expectSqlError(
      db,
      `INSERT INTO business_profiles (workspace_id, licensee_name, brokerage_name, market) VALUES ('${workspace}', 'Ana', '  ', 'Miami')`,
    );
  });

  it('keeps opportunity scores within 0–100, tied to a source record, one per subject', () => {
    const src = db.query(`SELECT id FROM data_sources WHERE key = 'fl-dor-nal'`);
    assert.ok(src, 'migration seeds the fl-dor-nal source');
    const rec = db.query(
      `INSERT INTO source_records (source_id, external_id, file_date, zip, payload) VALUES ('${src}', 'P1', '2026-10-01', '33180', '{}') RETURNING id`,
    );
    const rec2 = db.query(
      `INSERT INTO source_records (source_id, external_id, file_date, zip, payload) VALUES ('${src}', 'P1', '2026-11-01', '33180', '{}') RETURNING id`,
    );
    expectSqlError(
      db,
      `INSERT INTO source_records (source_id, external_id, file_date, zip, payload) VALUES ('${src}', 'P2', '2026-10-01', '3318', '{}')`,
    );
    const ins = (score: number, record = rec) =>
      `INSERT INTO opportunities (workspace_id, source_record_id, subject_key, type, score, confidence, reasons, scoring_version)
       VALUES ('${workspace}', '${record}', 'fl-dor-nal:23:P1', 'potential_seller', ${score}, 1, '[]', 'seller-v2')`;
    expectSqlError(db, ins(101));
    db.query(ins(80));
    expectSqlError(db, ins(70)); // one opportunity per record and type
    expectSqlError(db, ins(70, rec2)); // and one per subject, across roll files
  });

  it('tracks ZIP coverage and discovery runs with constrained states', () => {
    db.query(`INSERT INTO zip_coverage (county_code, zip) VALUES ('23', '33180')`);
    assert.equal(db.query(`SELECT status FROM zip_coverage WHERE zip = '33180'`), 'pending');
    expectSqlError(db, `INSERT INTO zip_coverage (county_code, zip, status) VALUES ('23', '33181', 'done')`);
    expectSqlError(db, `INSERT INTO zip_coverage (county_code, zip) VALUES ('23', 'ABCDE')`);
    db.query(`INSERT INTO workspace_discovery (workspace_id) VALUES ('${workspace}')`);
    expectSqlError(db, `UPDATE workspace_discovery SET status = 'done' WHERE workspace_id = '${workspace}'`);
  });

  it('allows one draft being written per opportunity, and constrains model runs and outcomes', () => {
    const opp = db.query(`SELECT id FROM opportunities WHERE workspace_id = '${workspace}' LIMIT 1`);
    assert.ok(opp, 'an opportunity from the earlier test');
    const draft = (status: string) =>
      `INSERT INTO campaigns (workspace_id, opportunity_id, title, objective, status) VALUES ('${workspace}', '${opp}', 't', 'o', '${status}') RETURNING id`;
    db.query(draft('generating'));
    expectSqlError(db, draft('generating'));
    db.query(draft('review'));
    expectSqlError(
      db,
      `INSERT INTO model_runs (workspace_id, purpose, role, provider, model, prompt_version, status) VALUES ('${workspace}', 'x', 'genius', 'p', 'm', 'v', 'ok')`,
    );
    expectSqlError(
      db,
      `INSERT INTO model_runs (workspace_id, purpose, role, provider, model, prompt_version, status, cost_usd) VALUES ('${workspace}', 'x', 'fast', 'p', 'm', 'v', 'ok', -1)`,
    );
    const outcome = (o: string) =>
      `INSERT INTO opportunity_outcomes (workspace_id, opportunity_id, outcome, score, scoring_version, occurred_on, recorded_by)
       VALUES ('${workspace}', '${opp}', '${o}', 60, 'seller-v3', '2026-10-01', '${USER}')`;
    db.query(outcome('listing'));
    expectSqlError(db, outcome('sold'));
  });

  it('tracks Film Crew media: states from core, labelled generated scenes, one current headshot, image runs', () => {
    for (const s of MEDIA_STATES) db.query(`UPDATE campaigns SET media_status = '${s}' WHERE id = '${campaign}'`);
    expectSqlError(db, `UPDATE campaigns SET media_status = 'posted' WHERE id = '${campaign}'`);
    const asset = (kind: string, source: string, extra: { campaign?: string; illustrative?: boolean; provider?: string; type?: string } = {}) =>
      `INSERT INTO media_assets (workspace_id, campaign_id, kind, source, content_type, bytes, byte_size, illustrative, provider, model)
       VALUES ('${workspace}', ${extra.campaign ? `'${extra.campaign}'` : 'NULL'}, '${kind}', '${source}', '${extra.type ?? 'image/png'}',
               '\\x89504e47'::bytea, 4, ${extra.illustrative ?? false}, ${extra.provider ? `'${extra.provider}'` : 'NULL'},
               ${extra.provider ? "'m'" : 'NULL'}) RETURNING id`;
    assert.deepEqual([...MEDIA_ASSET_KINDS].sort(), ['headshot', 'neighborhood_image']);
    for (const t of MEDIA_CONTENT_TYPES) {
      db.query(asset('headshot', 'upload', { type: t }));
      db.query(`UPDATE media_assets SET replaced_at = now() WHERE kind = 'headshot' AND replaced_at IS NULL`);
    }
    db.query(asset('headshot', 'upload'));
    expectSqlError(db, asset('headshot', 'upload'));
    expectSqlError(db, asset('headshot', 'upload', { type: 'image/svg+xml' }));
    db.query(asset('neighborhood_image', 'generated', { campaign, illustrative: true, provider: 'google' }));
    expectSqlError(db, asset('neighborhood_image', 'generated', { campaign, illustrative: false, provider: 'google' }));
    expectSqlError(db, asset('neighborhood_image', 'upload', { campaign, illustrative: true }));
    expectSqlError(db, asset('headshot', 'generated', { provider: 'google' }));
    db.query(`INSERT INTO model_runs (workspace_id, purpose, role, provider, model, prompt_version, status) VALUES ('${workspace}', 'x', 'image', 'google', 'm', 'v', 'ok')`);
  });

  it('enables row-level security on every table, so the public Data API sees nothing', () => {
    const open = db.query(
      `SELECT string_agg(c.relname, ',') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    assert.equal(open, '');
  });
});
