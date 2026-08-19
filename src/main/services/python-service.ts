import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { ensureDir, id, projectDataPath, safeFilename } from "../utils.js";
import type { ArtifactService } from "./artifact-service.js";
import type { JobQueue } from "./job-queue.js";
import { requiresApproval } from "./policy.js";
import type { SettingsService } from "./settings-service.js";

export interface PythonRunResult {
  jobId: string;
  status: "completed" | "waiting-approval" | "failed";
  stdout: string;
  stderr: string;
  artifact?: Artifact;
  artifacts?: Artifact[];
}

export class PythonService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly dataRoot: string,
    private readonly settings: SettingsService,
    private readonly artifacts: ArtifactService,
    private readonly jobs: JobQueue
  ) {}

  async runProjectScript(input: {
    projectId: string;
    name: string;
    code: string;
    args?: string[];
    approved?: boolean;
    jobId?: string;
  }): Promise<PythonRunResult> {
    const project = this.db.getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    if (!input.approved && requiresApproval(project.policy, "python-script")) {
      const job = this.jobs.create({
        projectId: input.projectId,
        kind: "python",
        status: "waiting-approval",
        title: `Approve script: ${input.name}`,
        detail: "Project policy asks before Python scripts run.",
        result: {
          approval: {
            action: "python-script",
            name: input.name,
            code: input.code,
            args: input.args ?? []
          }
        }
      });
      return { jobId: job.id, status: "waiting-approval", stdout: "", stderr: job.detail ?? "" };
    }

    const job = input.jobId
      ? this.jobs.update(input.jobId, {
          status: "running",
          title: `Running ${input.name}`,
          progress: 0,
          detail: "Approval received. Starting script.",
          result: { approval: undefined }
        })
      : this.jobs.create({
          projectId: input.projectId,
          kind: "python",
          status: "running",
          title: `Running ${input.name}`
        });
    const scriptDir = projectDataPath(this.dataRoot, input.projectId, "scripts");
    await ensureDir(scriptDir);
    const scriptPath = join(scriptDir, `${safeFilename(input.name)}-${id("script")}.py`);
    await writeFile(scriptPath, input.code, "utf8");
    const python = await this.ensureProjectPython(input.projectId);
    const result = await runCommand(python.executable, [scriptPath, ...(input.args ?? [])], {
      cwd: projectDataPath(this.dataRoot, input.projectId),
      env: { ...process.env, PAPER_PILOT_PROJECT_DIR: projectDataPath(this.dataRoot, input.projectId) }
    });
    const log = [
      `# Python Run: ${input.name}`,
      "",
      "## STDOUT",
      "```",
      result.stdout,
      "```",
      "",
      "## STDERR",
      "```",
      result.stderr,
      "```"
    ].join("\n");
    const artifact = await this.artifacts.writeArtifact({
      projectId: input.projectId,
      type: "crawl-log",
      title: `Python log - ${input.name}`,
      content: log,
      source: "python-service",
      metadata: { scriptPath, exitCode: result.code },
      indexText: true
    });
    this.jobs.update(job.id, {
      status: result.code === 0 ? "completed" : "failed",
      progress: 1,
      detail: result.code === 0 ? "Script completed." : `Script exited with code ${result.code}.`,
      error: result.code === 0 ? undefined : result.stderr.slice(0, 500),
      result: { artifactId: artifact.id, scriptPath }
    });
    return {
      jobId: job.id,
      status: result.code === 0 ? "completed" : "failed",
      stdout: result.stdout,
      stderr: result.stderr,
      artifact
    };
  }

  async convertWithMarkItDown(
    projectId: string,
    sourcePath: string,
    approved = false,
    parentArtifactId?: string
  ): Promise<PythonRunResult> {
    const name = `convert-${safeFilename(sourcePath.split(/[\\/]/).pop() ?? "artifact")}`;
    const code = [
      "import sys",
      "from pathlib import Path",
      "from markitdown import MarkItDown",
      "source = Path(sys.argv[1])",
      "target = source.with_suffix(source.suffix + '.md')",
      "result = MarkItDown().convert(str(source))",
      "target.write_text(result.text_content, encoding='utf-8')",
      "print(target)"
    ].join("\n");
    await this.ensureMarkItDown(projectId);
    const run = await this.runProjectScript({ projectId, name, code, args: [sourcePath], approved });
    if (run.status !== "completed") return run;
    const markdownPath = run.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!markdownPath) {
      throw new Error("MarkItDown completed but did not print the converted Markdown path.");
    }
    const markdown = await readFile(markdownPath, "utf8");
    const artifact = await this.artifacts.writeArtifact({
      projectId,
      type: "markdown",
      title: `Markdown conversion - ${sourcePath.split(/[\\/]/).pop() ?? "document"}`,
      content: markdown,
      source: "markitdown",
      parentArtifactId,
      metadata: { sourcePath, markdownPath },
      indexText: true
    });
    return {
      ...run,
      artifact,
      artifacts: [artifact, ...(run.artifact ? [run.artifact] : [])]
    };
  }

  async ensureMarkItDown(projectId: string): Promise<void> {
    const python = await this.ensureProjectPython(projectId);
    await writeFile(
      projectDataPath(this.dataRoot, projectId, "requirements.txt"),
      ["markitdown[all]", "playwright"].join("\n"),
      "utf8"
    );
    await runCommand(python.executable, ["-m", "pip", "install", "markitdown[all]"], {
      cwd: projectDataPath(this.dataRoot, projectId)
    });
  }

  async ensureProjectPython(projectId: string): Promise<{ executable: string; venvDir: string }> {
    const appSettings = await this.settings.get();
    const projectDir = projectDataPath(this.dataRoot, projectId);
    await ensureDir(projectDir);
    if (appSettings.python.executablePath) {
      return { executable: appSettings.python.executablePath, venvDir: projectDir };
    }
    const venvDir = join(projectDir, ".venv");
    const executable =
      process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
    try {
      await access(executable);
      return { executable, venvDir };
    } catch {
      const systemPython = await detectPython();
      await runCommand(systemPython, ["-m", "venv", venvDir], { cwd: projectDir });
      await runCommand(executable, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: projectDir });
      return { executable, venvDir };
    }
  }

  async installPlaywrightChromium(projectId: string, approved = false): Promise<PythonRunResult> {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (!approved && requiresApproval(project.policy, "browser-install")) {
      const job = this.jobs.create({
        projectId,
        kind: "python",
        status: "waiting-approval",
        title: "Approve Chromium install",
        detail: "Browser fallback needs a Playwright Chromium install on this machine.",
        result: {
          approval: {
            action: "browser-install"
          }
        }
      });
      return { jobId: job.id, status: "waiting-approval", stdout: "", stderr: job.detail ?? "" };
    }
    return this.runProjectScript({
      projectId,
      name: "install-playwright-chromium",
      code: "import subprocess, sys\nsubprocess.check_call([sys.executable, '-m', 'pip', 'install', 'playwright'])\nsubprocess.check_call([sys.executable, '-m', 'playwright', 'install', 'chromium'])",
      approved: true
    });
  }

  async approvePendingPythonJob(jobId: string): Promise<PythonRunResult> {
    const job = this.jobs.get(jobId);
    const approval = job?.result?.approval as
      | { action: "python-script"; name?: string; code?: string; args?: string[] }
      | { action: "browser-install" }
      | undefined;
    if (!job || job.status !== "waiting-approval" || !approval?.action) {
      throw new Error(`No pending Python approval found for job ${jobId}.`);
    }
    if (approval.action === "browser-install") {
      this.jobs.update(jobId, {
        status: "running",
        title: "Installing Chromium",
        progress: 0,
        detail: "Approval received. Installing Playwright Chromium.",
        result: { approval: undefined }
      });
      return this.runProjectScript({
        projectId: job.projectId,
        name: "install-playwright-chromium",
        code: "import subprocess, sys\nsubprocess.check_call([sys.executable, '-m', 'pip', 'install', 'playwright'])\nsubprocess.check_call([sys.executable, '-m', 'playwright', 'install', 'chromium'])",
        approved: true,
        jobId
      });
    }
    if (!approval.name || !approval.code) {
      throw new Error(`Pending Python job ${jobId} is missing script details.`);
    }
    return this.runProjectScript({
      projectId: job.projectId,
      name: approval.name,
      code: approval.code,
      args: approval.args ?? [],
      approved: true,
      jobId
    });
  }
}

async function detectPython(): Promise<string> {
  const candidates: Array<[string, string[]]> =
    process.platform === "win32"
      ? [
          ["py", ["-3", "--version"]],
          ["python", ["--version"]]
        ]
      : [
          ["python3", ["--version"]],
          ["python", ["--version"]]
        ];
  for (const [command, args] of candidates) {
    const result = await runCommand(command, args, { cwd: process.cwd() }).catch(() => undefined);
    if (result?.code === 0) return command;
  }
  throw new Error("No Python runtime found. Configure Python in settings or install Python 3.11+.");
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
