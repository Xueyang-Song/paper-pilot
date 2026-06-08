import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateService, type UpdateClient } from "../src/main/services/update-service";

class FakeUpdater extends EventEmitter implements UpdateClient {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => null);
  downloadUpdate = vi.fn<() => Promise<string[]>>(async () => []);
  quitAndInstall = vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>();

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-08T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateService", () => {
  it("configures updater for stable Windows app updates", () => {
    const { updater } = createService();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("checks on startup and downloads an available update", async () => {
    const { service, updater } = createService();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.2.4" });
      return null;
    });
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("download-progress", {
        percent: 42.4,
        transferred: 42,
        total: 100,
        bytesPerSecond: 10
      });
      updater.emit("update-downloaded", { version: "0.2.4" });
      return ["installer.exe"];
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runOnlyPendingTimersAsync();

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      state: "downloaded",
      currentVersion: "0.2.3",
      availableVersion: "0.2.4",
      downloadPercent: 100,
      retryCount: 0
    });
  });

  it("installs a downloaded update on demand", async () => {
    const { service, updater } = createService();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.2.4" });
      return null;
    });
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("update-downloaded", { version: "0.2.4" });
      return ["installer.exe"];
    });

    await service.checkForUpdates(true);
    await vi.runOnlyPendingTimersAsync();
    service.installUpdateNow();

    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("backs off failed checks and stops after automatic retries are exhausted", async () => {
    const { service, updater } = createService();
    updater.checkForUpdates.mockRejectedValue(new Error("offline"));

    await service.checkForUpdates(true);

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      state: "failed",
      retryCount: 1,
      error: "offline",
      nextRetryAt: "2026-06-08T12:00:00.100Z"
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(service.getStatus().retryCount).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(service.getStatus().retryCount).toBe(3);

    await vi.advanceTimersByTimeAsync(300);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(4);
    expect(service.getStatus()).toMatchObject({
      state: "failed",
      retryCount: 3,
      nextRetryAt: undefined,
      error: "offline"
    });
  });

  it("resets the retry cycle for a manual retry", async () => {
    const { service, updater } = createService();
    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));

    await service.checkForUpdates(true);
    expect(service.getStatus().retryCount).toBe(1);

    updater.checkForUpdates.mockReset();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-not-available", { version: "0.2.3" });
      return null;
    });

    await service.checkForUpdates(true);

    expect(service.getStatus()).toMatchObject({
      state: "not-available",
      retryCount: 0,
      nextRetryAt: undefined,
      error: undefined
    });
  });

  it("ignores concurrent manual checks", async () => {
    const { service, updater } = createService();
    let resolveCheck: (value: unknown) => void = () => undefined;
    updater.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        })
    );

    const first = service.checkForUpdates(true);
    const second = service.checkForUpdates(true);
    updater.emit("update-not-available", { version: "0.2.3" });
    resolveCheck(null);

    await Promise.all([first, second]);

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("stays disabled outside packaged Windows builds", async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService({
      updater,
      currentVersion: "0.2.3",
      isPackaged: false,
      platform: "win32",
      startupCheckDelayMs: 1,
      periodicCheckIntervalMs: 10,
      retryDelaysMs: [100, 200, 300]
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1);
    await service.checkForUpdates(true);
    await service.downloadUpdate(true);

    expect(service.getStatus()).toMatchObject({ state: "disabled", currentVersion: "0.2.3" });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
});

function createService() {
  const updater = new FakeUpdater();
  const service = new UpdateService({
    updater,
    currentVersion: "0.2.3",
    isPackaged: true,
    platform: "win32",
    startupCheckDelayMs: 1_000,
    periodicCheckIntervalMs: 10_000,
    retryDelaysMs: [100, 200, 300]
  });
  return { service, updater };
}
