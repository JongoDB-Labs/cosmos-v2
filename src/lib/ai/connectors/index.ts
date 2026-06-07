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
import { jiraConnector } from "./jira.descriptor";
import { slackConnector } from "./slack.descriptor";
import { nangoConnector } from "./nango.descriptor";

registerConnector(googleConnector);
registerConnector(githubConnector);
// Native token-auth connectors (availability:"all" — gov-usable behind our own egress
// fence; sealed via the v2.7/v2.8 org-credential vault + sealed-install path).
registerConnector(jiraConnector);
registerConnector(slackConnector);
// COMMERCIAL-ONLY connector breadth (Nango). Gov tenants never see/reach it (D5) —
// the descriptor's availability:"commercial-only" drives the registry's tenant filter
// + dispatch refusal; the executor + connect route hard-block gov too.
registerConnector(nangoConnector);

export {
  connectorToolDefs,
  connectorToolNames,
  executeConnectorTool,
  connectorEgressMaps,
  getConnectorDescriptors,
} from "./registry";
