import type { Artifact, Job, Message, Paper, Project } from "../shared/schemas";

export interface ProjectBundle {
  project: Project;
  messages: Message[];
  artifacts: Artifact[];
  papers: Paper[];
  jobs: Job[];
}
