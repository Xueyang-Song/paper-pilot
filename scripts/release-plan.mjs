import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_LABELS = new Map([
  ["release:patch", "patch"],
  ["release:minor", "minor"],
  ["release:major", "major"]
]);

const RELEASE_ASSET_PATTERNS = [/\.exe$/i, /\.exe\.blockmap$/i, /^latest\.yml$/i, /^SHA256SUMS\.txt$/i];
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value) {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`Expected a stable semantic version, received '${value}'.`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version, withPrefix = false) {
  const value = `${version.major}.${version.minor}.${version.patch}`;
  return withPrefix ? `v${value}` : value;
}

export function compareVersions(left, right) {
  const a = typeof left === "string" ? parseVersion(left) : left;
  const b = typeof right === "string" ? parseVersion(right) : right;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function bumpVersion(version, releaseType) {
  const current = typeof version === "string" ? parseVersion(version) : version;
  if (releaseType === "major") return { major: current.major + 1, minor: 0, patch: 0 };
  if (releaseType === "minor") return { major: current.major, minor: current.minor + 1, patch: 0 };
  if (releaseType === "patch") return { major: current.major, minor: current.minor, patch: current.patch + 1 };
  throw new Error(`Unsupported release type '${releaseType}'.`);
}

export function releaseTypeFromLabels(labels) {
  const selected = labels.map((label) => RELEASE_LABELS.get(label)).filter(Boolean);
  if (selected.length > 1) {
    throw new Error(
      `Choose at most one release label. Found: ${labels.filter((label) => RELEASE_LABELS.has(label)).join(", ")}.`
    );
  }
  return selected[0] ?? "patch";
}

export function planReleaseVersion(baseTag, releases) {
  let version = parseVersion(baseTag);
  for (const release of releases) version = bumpVersion(version, release.releaseType);
  return formatVersion(version);
}

export function selectAssociatedPullRequest(pulls, targetSha, baseBranch = "main") {
  const merged = pulls.filter((pull) => pull.merged_at && pull.base?.ref === baseBranch);
  const exact = merged.filter((pull) => pull.merge_commit_sha === targetSha);
  if (exact.length !== 1) {
    throw new Error(
      `Expected exactly one squash-merged pull request for ${targetSha} on ${baseBranch}; found ${exact.length}. Direct pushes and non-squash merges are not releasable.`
    );
  }
  return exact[0];
}

export function classifyReleaseState({
  tagExists,
  releaseExists = false,
  releaseDraft = false,
  releasePrerelease = false,
  releaseAssets = []
}) {
  if (!tagExists) return "release";
  const complete =
    releaseExists &&
    !releaseDraft &&
    !releasePrerelease &&
    releaseAssets.length === RELEASE_ASSET_PATTERNS.length &&
    RELEASE_ASSET_PATTERNS.every((pattern) => releaseAssets.some((asset) => pattern.test(asset)));
  return complete ? "complete" : "repair";
}

function runGit(args, allowFailure = false) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return "";
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

function gitSucceeds(args) {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function githubRequest(repository, path, token, allowNotFound = false) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "paper-pilot-release-planner",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${path} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function pullRequestForCommit(repository, sha, token, baseBranch) {
  const pulls = await githubRequest(repository, `/commits/${sha}/pulls`, token);
  return selectAssociatedPullRequest(pulls, sha, baseBranch);
}

function nearestReleaseTag(targetSha) {
  const candidates = runGit(["tag", "--merged", targetSha, "--list", "v*", "--sort=-version:refname"])
    .split(/\r?\n/u)
    .filter((tag) => SEMVER_PATTERN.test(tag));
  for (const tag of candidates) {
    const ancestry = runGit(["rev-list", "--first-parent", `${tag}..${targetSha}`], true);
    const tagCommit = runGit(["rev-list", "-n", "1", tag]);
    const firstParentHistory = runGit(["rev-list", "--first-parent", targetSha]).split(/\r?\n/u);
    if (tagCommit === targetSha || (ancestry && firstParentHistory.includes(tagCommit))) return tag;
  }
  throw new Error(`No stable vX.Y.Z tag exists on the first-parent history of ${targetSha}.`);
}

function tagsAtCommit(targetSha) {
  const output = runGit(["tag", "--points-at", targetSha, "--list", "v*"], true);
  return output
    .split(/\r?\n/u)
    .filter((tag) => SEMVER_PATTERN.test(tag))
    .sort((left, right) => compareVersions(right, left));
}

function releaseNotes(pull, targetSha, tag) {
  const body = pull.body?.trim();
  return [
    `## ${pull.title}`,
    "",
    body || "No pull request description was provided.",
    "",
    `- Pull request: [#${pull.number}](${pull.html_url})`,
    `- Author: [@${pull.user.login}](${pull.user.html_url})`,
    `- Commit: \`${targetSha}\``,
    `- Version: \`${tag}\``
  ].join("\n");
}

function fallbackReleaseNotes(targetSha, tag) {
  return [`## ${tag}`, "", "Automated Paper Pilot release recovery.", "", `- Commit: \`${targetSha}\``].join("\n");
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

async function createPlan({ repository, targetSha, token, baseBranch }) {
  const resolvedTarget = runGit(["rev-parse", "--verify", `${targetSha}^{commit}`]);
  const remoteMain = runGit(["rev-parse", `origin/${baseBranch}`]);
  if (!gitSucceeds(["merge-base", "--is-ancestor", resolvedTarget, remoteMain])) {
    throw new Error(`${resolvedTarget} is not on origin/${baseBranch}.`);
  }

  const baseTag = nearestReleaseTag(resolvedTarget);
  const commitOutput = runGit(["rev-list", "--first-parent", "--reverse", `${baseTag}..${resolvedTarget}`], true);
  const commits = commitOutput ? commitOutput.split(/\r?\n/u) : [];
  const releases = [];
  for (const sha of commits) {
    const pull = await pullRequestForCommit(repository, sha, token, baseBranch);
    const labels = pull.labels.map((label) => label.name);
    releases.push({ sha, pull, labels, releaseType: releaseTypeFromLabels(labels) });
  }

  const exactTags = tagsAtCommit(resolvedTarget);
  const calculatedVersion = planReleaseVersion(baseTag, releases);
  const calculatedTag = `v${calculatedVersion}`;
  if (exactTags.some((tag) => tag !== calculatedTag)) {
    throw new Error(
      `Commit ${resolvedTarget} is tagged ${exactTags.join(", ")}, but history calculates ${calculatedTag}.`
    );
  }
  const calculatedTagCommit = runGit(["rev-parse", "--verify", `${calculatedTag}^{commit}`], true);
  if (calculatedTagCommit && calculatedTagCommit !== resolvedTarget) {
    throw new Error(`${calculatedTag} already points to ${calculatedTagCommit}, not ${resolvedTarget}.`);
  }

  const tag = calculatedTag;
  const release = await githubRequest(repository, `/releases/tags/${encodeURIComponent(tag)}`, token, true);
  let targetPull = releases.at(-1)?.pull;
  if (!targetPull) {
    const pulls = await githubRequest(repository, `/commits/${resolvedTarget}/pulls`, token);
    try {
      targetPull = selectAssociatedPullRequest(pulls, resolvedTarget, baseBranch);
    } catch (error) {
      if (!exactTags.length) throw error;
    }
  }
  const state = classifyReleaseState({
    tagExists: exactTags.includes(tag),
    releaseExists: Boolean(release),
    releaseDraft: release?.draft,
    releasePrerelease: release?.prerelease,
    releaseAssets: release?.assets?.map((asset) => asset.name) ?? []
  });
  const notes = targetPull ? releaseNotes(targetPull, resolvedTarget, tag) : fallbackReleaseNotes(resolvedTarget, tag);

  return {
    status: state,
    version: tag.slice(1),
    tag,
    baseTag,
    targetSha: resolvedTarget,
    releaseType: releases.at(-1)?.releaseType ?? "existing",
    pullNumber: targetPull?.number ?? "",
    pullUrl: targetPull?.html_url ?? "",
    pullTitle: targetPull?.title ?? tag,
    notesBase64: Buffer.from(notes, "utf8").toString("base64")
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = argument("--repository") ?? process.env.GITHUB_REPOSITORY;
  const targetSha = argument("--target-sha") ?? process.env.TARGET_SHA;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const baseBranch = argument("--base-branch") ?? "main";
  if (!repository || !targetSha || !token) {
    throw new Error("Release planning requires --repository, --target-sha, and GH_TOKEN/GITHUB_TOKEN.");
  }
  const plan = await createPlan({ repository, targetSha, token, baseBranch });
  for (const [name, value] of Object.entries({
    status: plan.status,
    version: plan.version,
    tag: plan.tag,
    target_sha: plan.targetSha,
    release_type: plan.releaseType,
    pull_number: plan.pullNumber,
    pull_url: plan.pullUrl,
    pull_title: plan.pullTitle,
    notes_base64: plan.notesBase64
  })) {
    writeOutput(name, value);
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
