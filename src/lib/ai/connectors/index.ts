// src/lib/ai/connectors/index.ts
//
// The single registration point for external connectors. Importing this module
// registers every connector exactly once (module-eval side effect), after which the
// registry's derived accessors (connectorToolDefs / connectorToolNames /
// executeConnectorTool / connectorEgressMaps) reflect the full set. Consumers
// (tools.ts, tool-executor.ts, egress/projection.ts) import from here so the
// registration is guaranteed to have run before they read the registry.
//
// Adding the next connector = add its descriptor file + one registerConnector line
// here. No edits to tools.ts / tool-executor.ts / projection.ts.

import { registerConnector } from "./registry";
import { googleConnector } from "./google.descriptor";
import { githubConnector } from "./github.descriptor";

registerConnector(googleConnector);
registerConnector(githubConnector);

export {
  connectorToolDefs,
  connectorToolNames,
  executeConnectorTool,
  connectorEgressMaps,
  getConnectorDescriptors,
} from "./registry";
