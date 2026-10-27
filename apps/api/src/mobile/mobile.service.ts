import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  findMobileBootstrap,
  findMobileConfig,
  removeMobileLogo,
  saveMobileConfig,
  saveMobileLogo,
  withoutTenantScope,
  withRequestTenantScope,
  type AuditActor,
  type MobileConfigRecord,
  type MobileLogo
} from "@growpath/db";
import {
  TENANT_LOGO_DATA_URL,
  TENANT_LOGO_MAX_BYTES,
  type MobileConfig,
  type SaveMobileConfigInput,
  type SaveMobileLogoInput,
  type TenantLogoContentType
} from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

/**
 * Mobile runtime configuration (US-040).
 *
 * The response this builds is what replaces the Ionic app's `environment.ts`.
 * It carries no credential: the D365 client secret lives on `d365_environment`,
 * is sealed, and is read only by the token client — none of the queries reached
 * from here so much as name that table.
 */

const toDataUrl = (logo: MobileLogo): string =>
  `data:${logo.contentType};base64,${logo.data.toString("base64")}`;

const toConfig = (record: MobileConfigRecord): MobileConfig => ({
  tenantSlug: record.tenantSlug,
  tenantName: record.tenantName,
  apiBaseUrl: record.apiBaseUrl,
  userAuth: record.userAuth,
  minimumAppVersion: record.minimumAppVersion,
  logoDataUrl: record.logo ? toDataUrl(record.logo) : null,
  updatedAt: record.updatedAt.toISOString()
});

/**
 * Whether the bytes are what the `data:` prefix says they are.
 *
 * The prefix is the caller's claim; the file signature is the fact. Checked so
 * that what a device is told is a PNG is one — a mislabelled payload is at best
 * a broken image on every handset, and at worst a sniffing browser's guess.
 */
function matchesSignature(type: TenantLogoContentType, bytes: Buffer): boolean {
  switch (type) {
    case "image/png":
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case "image/webp":
      return (
        bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
        bytes.subarray(8, 12).toString("latin1") === "WEBP"
      );
  }
}

/** Decodes an uploaded logo, refusing anything oversized or mislabelled. */
function decodeLogo(dataUrl: string): { contentType: TenantLogoContentType; data: Buffer } {
  const match = TENANT_LOGO_DATA_URL.exec(dataUrl);
  if (!match) {
    throw new BadRequestException({ message: "The logo must be a PNG, JPEG or WebP image." });
  }
  const contentType = match[1] as TenantLogoContentType;
  const data = Buffer.from(match[2], "base64");

  if (data.length === 0 || data.length > TENANT_LOGO_MAX_BYTES) {
    throw new BadRequestException({ message: "The logo must be at most 64 KB." });
  }
  if (!matchesSignature(contentType, data)) {
    throw new BadRequestException({ message: "The logo's contents do not match its type." });
  }
  return { contentType, data };
}

@Injectable()
export class MobileService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * The bootstrap read, for a device that has no session yet.
   *
   * Unscoped, and deliberately loud about it. A freshly installed app holds a
   * slug and nothing else, so there is no token for a tenant to come from —
   * exactly the position `POST /tenants` is in, and it uses the same escape
   * hatch, which logs the bypass with the request's correlation ID (US-012).
   *
   * The bypass is safe here for a reason worth stating: `findMobileBootstrap`
   * selects a fixed column list from one table whose every column is
   * device-public by design. An unscoped query is dangerous when it can reach
   * data the scoping was protecting, and this one cannot.
   */
  async bootstrap(slug: string): Promise<MobileConfig | null> {
    const record = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Mobile bootstrap resolves a tenant from the slug a device was installed with; there is no session yet for a tenant to come from (US-040)."
      },
      (client) => findMobileBootstrap(client, slug)
    );
    return record ? toConfig(record) : null;
  }

  /** The caller's own tenant's configuration, for the administration screen. */
  async find(): Promise<MobileConfig | null> {
    const record = await withRequestTenantScope(this.pool, (client) => findMobileConfig(client));
    return record ? toConfig(record) : null;
  }

  /** Creates or replaces the caller's own tenant's configuration. */
  async save(input: SaveMobileConfigInput, actor: AuditActor): Promise<MobileConfig | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      saveMobileConfig(
        client,
        {
          apiBaseUrl: input.apiBaseUrl,
          userAuth: input.userAuth,
          minimumAppVersion: input.minimumAppVersion ?? null
        },
        actor
      )
    );
    return record ? toConfig(record) : null;
  }

  /**
   * Sets the logo. Null when the tenant has no configuration yet — a logo with
   * no devices to show it on is not something to store.
   */
  async saveLogo(input: SaveMobileLogoInput, actor: AuditActor): Promise<MobileConfig | null> {
    const logo = decodeLogo(input.dataUrl);
    const record = await withRequestTenantScope(this.pool, (client) =>
      saveMobileLogo(client, logo, actor)
    );
    return record ? toConfig(record) : null;
  }

  /** Removes the logo, so devices show the Grow Path mark alone. */
  async removeLogo(actor: AuditActor): Promise<MobileConfig | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      removeMobileLogo(client, actor)
    );
    return record ? toConfig(record) : null;
  }
}
