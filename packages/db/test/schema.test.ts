import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_INTERFACES,
  CAMPAIGN_STATES,
  CHANNELS,
  CONSENT_SCOPES,
  CONTACT_BASES,
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

  it('keeps opportunity scores within 0–100 and tied to a source record', () => {
    const src = db.query(`INSERT INTO data_sources (key, name, kind) VALUES ('fl-dor-nal', 'FL DOR NAL', 'public_record') RETURNING id`);
    const rec = db.query(
      `INSERT INTO source_records (source_id, external_id, file_date, payload) VALUES ('${src}', 'P1', '2026-10-01', '{}') RETURNING id`,
    );
    const ins = (score: number) =>
      `INSERT INTO opportunities (workspace_id, source_record_id, type, score, confidence, reasons, scoring_version)
       VALUES ('${workspace}', '${rec}', 'potential_seller', ${score}, 1, '[]', 'seller-v1')`;
    expectSqlError(db, ins(101));
    db.query(ins(80));
    expectSqlError(db, ins(70)); // one opportunity per record and type
  });
});
