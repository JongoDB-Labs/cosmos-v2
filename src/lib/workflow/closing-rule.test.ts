import { describe, it, expect } from "vitest";
import { closingRuleOn } from "./closing-rule";
import { workflowSettings } from "./settings";

describe("closingRuleOn", () => {
  it("off unless the org turns it on", () => {
    expect(workflowSettings({}).closingRule).toBe(false);
    expect(workflowSettings({ workflow: { closingRule: true } }).closingRule).toBe(true);
    expect(workflowSettings({ workflow: { closingRule: "yes" } }).closingRule).toBe(false);
  });
  it("a project's own choice wins either way; anything else follows the org", () => {
    expect(closingRuleOn(true, { closingRule: false })).toBe(false);
    expect(closingRuleOn(false, { closingRule: true })).toBe(true);
    expect(closingRuleOn(true, { closingRule: null })).toBe(true);
    expect(closingRuleOn(false, {})).toBe(false);
    expect(closingRuleOn(true, null)).toBe(true);
  });
});

