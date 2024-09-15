import { describe, expect, it } from "vitest";
import { createDefaultProjectPolicy } from "../src/main/db";
import { requiresApproval, yoloWarning } from "../src/main/services/policy";

describe("project policy", () => {
  it("requires script approval by default", () => {
    const policy = createDefaultProjectPolicy();
    expect(requiresApproval(policy, "python-script")).toBe(true);
  });

  it("lets yolo mode bypass approvals with an explicit warning string", () => {
    const policy = { ...createDefaultProjectPolicy(), autonomy: "yolo" as const };
    expect(requiresApproval(policy, "browser-install")).toBe(false);
    expect(yoloWarning()).toMatch(/YOLO mode/);
  });
});
