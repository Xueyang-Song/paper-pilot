import electron from "electron";
import type { CredentialUpsert } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";

const { safeStorage } = electron;

export class CredentialService {
  constructor(private readonly db: PaperPilotDb) {}

  upsert(input: CredentialUpsert): void {
    const encrypted = this.encrypt(input.secret);
    this.db.upsertEncryptedCredential(input.sourceId, input.label, encrypted);
  }

  get(sourceId: string, label = "default"): string | undefined {
    const encrypted = this.db.getEncryptedCredential(sourceId, label);
    return encrypted ? this.decrypt(encrypted) : undefined;
  }

  getMany(sourceIds: string[]): Record<string, string | undefined> {
    return Object.fromEntries(sourceIds.map((sourceId) => [sourceId, this.get(sourceId)]));
  }

  has(sourceId: string, label = "default"): boolean {
    return Boolean(this.db.getEncryptedCredential(sourceId, label));
  }

  listFlags(): Array<{ sourceId: string; label: string; updatedAt: string }> {
    return this.db.listCredentialFlags();
  }

  remove(sourceId: string, label = "default"): boolean {
    return this.db.deleteCredential(sourceId, label);
  }

  test(sourceId: string, label = "default"): { sourceId: string; label: string; ok: boolean; detail: string } {
    const hasSecret = this.has(sourceId, label);
    return {
      sourceId,
      label,
      ok: hasSecret,
      detail: hasSecret ? "Credential is stored and readable." : "No credential is stored for this source."
    };
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(value).toString("base64")}`;
    }
    return `plain:${Buffer.from(value, "utf8").toString("base64")}`;
  }

  private decrypt(value: string): string {
    if (value.startsWith("safe:")) {
      return safeStorage.decryptString(Buffer.from(value.slice(5), "base64"));
    }
    if (value.startsWith("plain:")) {
      return Buffer.from(value.slice(6), "base64").toString("utf8");
    }
    return value;
  }
}
