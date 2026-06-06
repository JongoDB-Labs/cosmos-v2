import { IntegrationRegistry } from "../registry";
import { CATALOG } from "./catalog.generated";

for (const provider of CATALOG) {
  IntegrationRegistry.register(provider);
}

export {};
