import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  classifyReleaseState,
  compareVersions,
  parseVersion,
  planReleaseVersion,
  releaseTypeFromLabels,
  selectAssociatedPullRequest
} from "../scripts/release-plan.mjs";

describe("release version planning", () => {
  it("parses stable semantic versions", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(() => parseVersion("v1.2.3-beta.1")).toThrow(/stable semantic version/);
  });

  it("applies patch, minor, and major bumps", () => {
    expect(bumpVersion("1.2.3", "patch")).toEqual({ major: 1, minor: 2, patch: 4 });
    expect(bumpVersion("1.2.3", "minor")).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(bumpVersion("1.2.3", "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it("defaults unlabeled pull requests to patch and rejects conflicts", () => {
    expect(releaseTypeFromLabels(["dependencies"])).toBe("patch");
    expect(releaseTypeFromLabels(["release:minor"])).toBe("minor");
    expect(() => releaseTypeFromLabels(["release:patch", "release:major"])).toThrow(/at most one/);
  });

  it("folds every pending merge to avoid concurrent version collisions", () => {
    expect(
      planReleaseVersion("v0.2.4", [{ releaseType: "patch" }, { releaseType: "minor" }, { releaseType: "patch" }])
    ).toBe("0.3.1");
  });

  it("orders stable versions numerically", () => {
    expect(compareVersions("v0.10.0", "v0.9.9")).toBeGreaterThan(0);
  });

  it("requires one associated merged pull request", () => {
    expect(() => selectAssociatedPullRequest([], "abc", "main")).toThrow(/exactly one squash-merged pull request/);
    expect(() =>
      selectAssociatedPullRequest(
        [{ merged_at: "2026-08-19", merge_commit_sha: "def", base: { ref: "main" }, number: 7 }],
        "abc",
        "main"
      )
    ).toThrow(/squash-merged pull request/);
    expect(
      selectAssociatedPullRequest(
        [{ merged_at: "2026-08-19", merge_commit_sha: "abc", base: { ref: "main" }, number: 7 }],
        "abc",
        "main"
      ).number
    ).toBe(7);
  });

  it("distinguishes complete releases from repairs", () => {
    expect(classifyReleaseState({ tagExists: false })).toBe("release");
    expect(classifyReleaseState({ tagExists: true, releaseAssets: ["Paper-Pilot-Setup-1.0.0.exe"] })).toBe("repair");
    expect(
      classifyReleaseState({
        tagExists: true,
        releaseExists: true,
        releaseAssets: [
          "Paper-Pilot-Setup-1.0.0.exe",
          "Paper-Pilot-Setup-1.0.0.exe.blockmap",
          "latest.yml",
          "SHA256SUMS.txt"
        ]
      })
    ).toBe("complete");
    expect(
      classifyReleaseState({
        tagExists: true,
        releaseExists: true,
        releaseDraft: true,
        releaseAssets: [
          "Paper-Pilot-Setup-1.0.0.exe",
          "Paper-Pilot-Setup-1.0.0.exe.blockmap",
          "latest.yml",
          "SHA256SUMS.txt"
        ]
      })
    ).toBe("repair");
  });
});
