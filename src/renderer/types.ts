import type { Artifact, Conversation, Job, Message, Paper, Project } from "../shared/schemas";

export interface ProjectBundle {
  project: Project;
  conversations: Conversation[];
  messages: Message[];
  artifacts: Artifact[];
  papers: Paper[];
  jobs: Job[];
}
