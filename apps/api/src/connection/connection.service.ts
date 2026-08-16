import { Inject, Injectable } from "@nestjs/common";
import {
  credentialsForSave,
  daysUntilExpiry,
  findConnection,
  listConnections,
  openClientSecret,
  recordConnectionCheck,
  saveConnection,
  scopeFor,
  tokenUrlFor,
  withRequestTenantScope,
  type AuditActor,
  type ConnectionRecord,
  type SaveConnectionInput as SaveConnectionRecordInput
} from "@growpath/db";
import type { Connection, ConnectionTestResult, SaveConnectionInput } from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";
import { D365TokenClient } from "./d365-token.client";

/**
 * D365 connections (US-040, US-042, US-045).
 *
 * Every read and write runs inside `withRequestTenantScope`, so there is no
 * tenant identifier anywhere in this file and another tenant's environment id
 * simply matches no row — a 404, never a 403.
 */

const toConnection = (record: ConnectionRecord): Connection => ({
  environmentId: record.environmentId,
  environmentName: record.environmentName,
  environmentKind: record.environmentKind,
  url: record.url,
  entraTenantId: record.entraTenantId,
  authorityHost: record.authorityHost,
  clientId: record.clientId,
  hasClientSecret: record.hasClientSecret,
  clientSecretUpdatedAt: record.clientSecretUpdatedAt?.toISOString() ?? null,
  clientSecretExpiresAt: record.clientSecretExpiresAt?.toISOString() ?? null,
  // Computed here rather than in the client: a browser or device with a wrong
  // clock would otherwise decide for itself whether a credential is expiring,
  // and the point of the warning is that it is reliable.
  daysUntilSecretExpiry: daysUntilExpiry(record.clientSecretExpiresAt),
  state: record.state,
  checkedAt: record.checkedAt?.toISOString() ?? null,
  error: record.error,
  // Derived, so the screen can show exactly what the server will call rather
  // than leaving an administrator to assemble it from three fields.
  tokenUrl: tokenUrlFor(record),
  scope: scopeFor(record.url)
});

/** What a save can conclude, before HTTP status codes are chosen for it. */
export type SaveOutcome =
  | { status: "saved"; connection: Connection }
  /** No such environment in this tenant. */
  | { status: "not_found" }
  /** First-time configuration with no secret supplied — nothing to test with. */
  | { status: "secret_required" }
  /** The live check refused the credentials, so nothing was written. */
  | { status: "rejected"; result: ConnectionTestResult };

@Injectable()
export class ConnectionService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly tokens: D365TokenClient
  ) {}

  async list(): Promise<Connection[]> {
    const records = await withRequestTenantScope(this.pool, (client) => listConnections(client));
    return records.map(toConnection);
  }

  async find(id: string): Promise<Connection | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      findConnection(client, id)
    );
    return record ? toConnection(record) : null;
  }

  /**
   * Test, then save — never the other way round.
   *
   * The sprint's exit criterion is that configuration cannot be saved until a
   * live connection test passes, and this ordering is the whole of it. Saving
   * first and testing after would leave a broken credential in place whenever
   * the test failed, and the screen would have to offer a way to undo a change
   * the administrator never wanted committed.
   *
   * The HTTP exchange deliberately happens **between** two scoped transactions
   * rather than inside one. A ten-second network call inside a database
   * transaction holds a connection and its row locks open for the duration, and
   * a directory that is merely slow would then exhaust the pool. The cost is a
   * window in which another administrator could edit the same connection; the
   * last write wins, and the audit log records both.
   */
  async save(
    id: string,
    input: SaveConnectionInput,
    actor: AuditActor
  ): Promise<SaveOutcome> {
    const record: SaveConnectionRecordInput = {
      entraTenantId: input.entraTenantId,
      authorityHost: input.authorityHost,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      clientSecretExpiresAt: input.clientSecretExpiresAt
        ? new Date(input.clientSecretExpiresAt)
        : null
    };

    const prepared = await withRequestTenantScope(this.pool, async (client) => {
      const existing = await findConnection(client, id);
      if (!existing) return null;
      // Resolves "omitted secret keeps the stored one" once, so the tested
      // credential and the saved one cannot come from different rules.
      return { existing, credentials: await credentialsForSave(client, id, record) };
    });

    if (!prepared) return { status: "not_found" };
    if (!prepared.credentials) {
      // The environment exists but has no stored secret and none was supplied.
      // There is nothing to test, so there is nothing that could be saved.
      return { status: "secret_required" };
    }

    const check = await this.tokens.check(prepared.credentials);

    if (!check.ok) {
      const failed = await withRequestTenantScope(this.pool, (client) =>
        // Records the failure against the connection as it *currently* stands.
        // The rejected configuration is not written anywhere — a credential that
        // does not work is not a state worth persisting.
        recordConnectionCheck(client, id, check, actor)
      );
      return {
        status: "rejected",
        result: {
          ok: false,
          state: failed?.state ?? "not_configured",
          error: check.error,
          checkedAt: (failed?.checkedAt ?? new Date()).toISOString()
        }
      };
    }

    const saved = await withRequestTenantScope(this.pool, (client) =>
      saveConnection(client, id, record, actor)
    );
    return saved
      ? { status: "saved", connection: toConnection(saved) }
      : { status: "not_found" };
  }

  /**
   * Re-checks a stored configuration without changing it.
   *
   * The credential is opened, presented and discarded; nothing about it is
   * returned. An unconfigured environment answers `not_configured` rather than
   * an error — "there is nothing to test" is a truthful result, not a failure of
   * the request.
   */
  async test(id: string, actor: AuditActor): Promise<ConnectionTestResult | null> {
    const prepared = await withRequestTenantScope(this.pool, async (client) => {
      const existing = await findConnection(client, id);
      if (!existing) return null;
      return { existing, credentials: await openClientSecret(client, id) };
    });

    if (!prepared) return null;

    if (!prepared.credentials) {
      return {
        ok: false,
        state: prepared.existing.clientId ? "failing" : "not_configured",
        // A configured connection whose sealed secret will not open is a key
        // problem, not a credential problem, and `invalid_client` would send an
        // administrator to rotate a secret that was never wrong.
        error: prepared.existing.clientId ? "unexpected" : null,
        checkedAt: new Date().toISOString()
      };
    }

    const check = await this.tokens.check(prepared.credentials);
    const updated = await withRequestTenantScope(this.pool, (client) =>
      recordConnectionCheck(client, id, check, actor)
    );

    return {
      ok: check.ok,
      state: updated?.state ?? "not_configured",
      error: check.ok ? null : check.error,
      checkedAt: (updated?.checkedAt ?? new Date()).toISOString()
    };
  }
}
