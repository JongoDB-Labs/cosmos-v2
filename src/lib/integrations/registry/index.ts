import { IntegrationRegistry } from "../registry";
import { CATALOG } from "./catalog.generated";
import { MANUAL_CATALOG } from "./catalog.manual";

// Generated first, then manual — register is a Map.set keyed by slug, so a
// manual entry with the same slug REPLACES the generated one (used to promote
// Microsoft Teams from its generated `coming_soon` placeholder).
for (const provider of CATALOG) {
  IntegrationRegistry.register(provider);
}
for (const provider of MANUAL_CATALOG) {
  IntegrationRegistry.register(provider);
}

export {};
