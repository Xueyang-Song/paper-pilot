import type { CrawlConfig, SourceDefinition, SourceId } from "../../shared/schemas.js";
import { builtInConnectors } from "./connectors.js";
import type { CrawlResult, SourceConnector, SourceContext } from "./types.js";

export class SourceRegistry {
  private connectors = new Map<SourceId, SourceConnector>();

  constructor(connectors: SourceConnector[] = builtInConnectors) {
    connectors.forEach((connector) => this.connectors.set(connector.definition.id, connector));
  }

  list(): SourceDefinition[] {
    return Array.from(this.connectors.values()).map((connector) => connector.definition);
  }

  get(sourceId: SourceId): SourceConnector {
    const connector = this.connectors.get(sourceId);
    if (!connector) throw new Error(`Unknown source: ${sourceId}`);
    return connector;
  }

  async run(sourceId: SourceId, config: CrawlConfig, context: SourceContext): Promise<CrawlResult> {
    try {
      return await this.get(sourceId).run(config, context);
    } catch (error) {
      return {
        papers: [],
        warnings: [error instanceof Error ? error.message : String(error)],
        provenance: { sourceId, failedGracefully: true }
      };
    }
  }
}
