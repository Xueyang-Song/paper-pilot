import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { UpdateStatus } from "../../shared/schemas.js";
import type * as ElectronUpdater from "electron-updater";

export const UPDATE_STARTUP_CHECK_DELAY_MS = 10_000;
export const UPDATE_PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const UPDATE_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;

type Timer = ReturnType<typeof setTimeout>;

interface VersionInfo {
  version?: string;
}

interface ProgressInfo {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface UpdateClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "checking-for-update", listener: () => void): this;
  on(event: "update-not-available", listener: (info: VersionInfo) => void): this;
  on(event: "update-available", listener: (info: VersionInfo) => void): this;
  on(event: "download-progress", listener: (info: ProgressInfo) => void): this;
  on(event: "update-downloaded", listener: (info: VersionInfo) => void): this;
  on(event: "error", listener: (error: Error, message?: string) => void): this;
}

export interface UpdateServiceOptions {
  updater: UpdateClient;
  currentVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform | string;
  startupCheckDelayMs?: number;
  periodicCheckIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
}

export class UpdateService extends EventEmitter {
  private readonly enabled: boolean;
  private readonly startupCheckDelayMs: number;
  private readonly periodicCheckIntervalMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => Date;
  private status: UpdateStatus;
  private started = false;
  private isChecking = false;
  private isDownloading = false;
  private operationFailureHandled = false;
  private startupTimer: Timer | undefined;
  private periodicTimer: Timer | undefined;
  private retryTimer: Timer | undefined;

  constructor(private readonly options: UpdateServiceOptions) {
    super();
    this.enabled = options.isPackaged && options.platform === "win32";
    this.startupCheckDelayMs = options.startupCheckDelayMs ?? UPDATE_STARTUP_CHECK_DELAY_MS;
    this.periodicCheckIntervalMs = options.periodicCheckIntervalMs ?? UPDATE_PERIODIC_CHECK_INTERVAL_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? UPDATE_RETRY_DELAYS_MS;
    this.now = options.now ?? (() => new Date());
    this.status = {
      state: this.enabled ? "idle" : "disabled",
      currentVersion: options.currentVersion,
      retryCount: 0
    };

    if (this.enabled) {
      this.configureUpdater();
      this.wireUpdaterEvents();
    }
  }

  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.checkForUpdates();
    }, this.startupCheckDelayMs);
    this.periodicTimer = setInterval(() => {
      void this.checkForUpdates();
    }, this.periodicCheckIntervalMs);
  }

  stop(): void {
    this.clearStartupTimer();
    this.clearPeriodicTimer();
    this.clearRetryTimer();
    this.started = false;
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async checkForUpdates(manual = false): Promise<UpdateStatus> {
    if (!this.enabled || this.status.state === "downloaded") return this.getStatus();
    if (manual) this.resetRetryCycle();
    if (this.isChecking || this.isDownloading) return this.getStatus();

    this.operationFailureHandled = false;
    this.isChecking = true;
    this.setStatus({
      state: "checking",
      downloadPercent: undefined,
      transferredBytes: undefined,
      totalBytes: undefined,
      bytesPerSecond: undefined,
      nextRetryAt: undefined,
      error: undefined
    });

    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      this.handleFailure(error);
    } finally {
      this.isChecking = false;
    }

    return this.getStatus();
  }

  async downloadUpdate(manual = false): Promise<UpdateStatus> {
    if (!this.enabled || this.status.state === "downloaded") return this.getStatus();
    if (manual) this.resetRetryCycle();
    if (this.isChecking || this.isDownloading) return this.getStatus();

    this.operationFailureHandled = false;
    this.isDownloading = true;
    this.setStatus({
      state: "downloading",
      downloadPercent: this.status.downloadPercent ?? 0,
      nextRetryAt: undefined,
      error: undefined
    });

    try {
      await this.options.updater.downloadUpdate();
    } catch (error) {
      this.handleFailure(error);
    } finally {
      this.isDownloading = false;
    }

    return this.getStatus();
  }

  installUpdateNow(): UpdateStatus {
    if (this.enabled && this.status.state === "downloaded") {
      this.options.updater.quitAndInstall(true, true);
    }
    return this.getStatus();
  }

  private configureUpdater(): void {
    const updater = this.options.updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
  }

  private wireUpdaterEvents(): void {
    this.options.updater.on("checking-for-update", () => {
      this.setStatus({ state: "checking", error: undefined, nextRetryAt: undefined });
    });

    this.options.updater.on("update-not-available", () => {
      this.clearRetryTimer();
      this.setStatus({
        state: "not-available",
        lastCheckedAt: this.isoNow(),
        retryCount: 0,
        nextRetryAt: undefined,
        error: undefined
      });
    });

    this.options.updater.on("update-available", (info) => {
      this.setStatus({
        state: "available",
        availableVersion: info.version,
        lastCheckedAt: this.isoNow(),
        retryCount: 0,
        nextRetryAt: undefined,
        error: undefined
      });
      setTimeout(() => {
        void this.downloadUpdate();
      }, 0);
    });

    this.options.updater.on("download-progress", (info) => {
      this.setStatus({
        state: "downloading",
        downloadPercent: clampPercent(info.percent),
        transferredBytes: info.transferred,
        totalBytes: info.total,
        bytesPerSecond: info.bytesPerSecond,
        error: undefined
      });
    });

    this.options.updater.on("update-downloaded", (info) => {
      this.clearRetryTimer();
      this.setStatus({
        state: "downloaded",
        availableVersion: info.version ?? this.status.availableVersion,
        downloadPercent: 100,
        retryCount: 0,
        nextRetryAt: undefined,
        error: undefined
      });
    });

    this.options.updater.on("error", (error, message) => {
      this.handleFailure(message ? new Error(message, { cause: error }) : error);
    });
  }

  private handleFailure(error: unknown): void {
    if (this.operationFailureHandled) return;
    this.operationFailureHandled = true;

    const scheduledRetries = this.status.retryCount;
    if (scheduledRetries >= this.retryDelaysMs.length) {
      this.setStatus({
        state: "failed",
        retryCount: scheduledRetries,
        nextRetryAt: undefined,
        error: errorMessage(error)
      });
      return;
    }

    const retryCount = scheduledRetries + 1;
    const delayMs = this.retryDelaysMs[scheduledRetries] ?? this.retryDelaysMs.at(-1) ?? 0;
    const nextRetryAt = new Date(this.now().getTime() + delayMs).toISOString();

    this.clearRetryTimer();
    this.setStatus({
      state: "failed",
      retryCount,
      nextRetryAt,
      error: errorMessage(error)
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.checkForUpdates();
    }, delayMs);
  }

  private resetRetryCycle(): void {
    this.clearRetryTimer();
    this.setStatus({
      retryCount: 0,
      nextRetryAt: undefined,
      error: undefined
    });
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("changed", this.getStatus());
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  private clearPeriodicTimer(): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = undefined;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export function createUpdateService(options: Omit<UpdateServiceOptions, "updater">): UpdateService {
  const require = createRequire(import.meta.url);
  const { autoUpdater } = require("electron-updater") as typeof ElectronUpdater;
  return new UpdateService({ ...options, updater: autoUpdater });
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(100, Math.max(0, value));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
