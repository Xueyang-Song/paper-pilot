import type { PaperPilotApi } from "../preload/index";

declare global {
  interface Window {
    paperPilot: PaperPilotApi;
  }
}

export {};
