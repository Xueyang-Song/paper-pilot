import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-conversation-migration-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("conversation persistence", () => {
  it("isolates messages and cascades deleted chat history without deleting artifacts", () => {
    const db = new PaperPilotDb(join(dir, "conversations.db"));
    const project = db.createProject("Conversation project");
    const first = db.ensureDefaultConversation(project.id);
    const second = db.createConversation(project.id, "Second chat", "exploratory");
    db.appendMessage({ projectId: project.id, conversationId: first.id, role: "user", content: "first", metadata: {} });
    db.appendMessage({
      projectId: project.id,
      conversationId: second.id,
      role: "user",
      content: "second",
      metadata: {}
    });
    db.saveArtifact({
      id: "answer",
      projectId: project.id,
      type: "chat-answer",
      title: "Durable answer",
      path: join(dir, "answer.md"),
      mime: "text/markdown",
      hash: "hash",
      source: "research-chat",
      metadata: { conversationId: second.id },
      createdAt: new Date().toISOString()
    });

    expect(db.listMessages(project.id, first.id).map((message) => message.content)).toEqual(["first"]);
    expect(db.listMessages(project.id, second.id).map((message) => message.content)).toEqual(["second"]);
    db.deleteConversation(second.id);
    expect(db.listMessages(project.id, second.id)).toHaveLength(0);
    expect(db.getArtifact(project.id, "answer")?.title).toBe("Durable answer");
    db.close();
  });

  it("backfills legacy messages into an Existing conversation", () => {
    const path = join(dir, "legacy.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        topic TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        policy_json TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES (
        'legacy_project', 'Legacy', 'topic', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'
      );
      INSERT INTO messages VALUES (
        'legacy_message', 'legacy_project', 'user', 'preserve me', '{}', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const db = new PaperPilotDb(path);
    const [conversation] = db.listConversations("legacy_project");
    expect(conversation.title).toBe("Existing conversation");
    expect(db.listMessages("legacy_project", conversation.id)[0].content).toBe("preserve me");
    const migrated = new DatabaseSync(path);
    expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    migrated.close();
    db.close();
  });

  it("refuses to open a database created by a newer schema", () => {
    const path = join(dir, "future.db");
    const future = new DatabaseSync(path);
    future.exec("PRAGMA user_version = 4");
    future.close();
    expect(() => new PaperPilotDb(path)).toThrow(/newer than this Paper Pilot build supports/i);
  });
});
