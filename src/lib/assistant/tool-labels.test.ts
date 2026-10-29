// @vitest-environment node
//
// A tool-call chip must say what Cosmo did, not which function it called.
//
// The labels were a curated map of ~20 core tool names inside the panel, so
// everything else — most core tools, every connector tool, and every tool a
// PLUGIN contributes — rendered as its raw identifier: "Ran create_whiteboard".
// A plugin tool can never be on a core list (core does not know the names), and
// for objects drawn onto an existing board the chip is the only account the user
// gets, because that call deliberately has no artifact card. So the derivation
// is what these tests pin.
import { describe, it, expect } from "vitest";
import { labelForTool, pastTenseLabel } from "./tool-labels";

describe("tool-call chip labels", () => {
  it("names a plugin's whiteboard tool calls in English", () => {
    // The two the whiteboard plugin contributes today. Neither is known to core,
    // and both used to read "Running create_whiteboard" / "Ran add_to_whiteboard".
    expect(labelForTool("create_whiteboard")).toBe("Creating whiteboard");
    expect(pastTenseLabel("create_whiteboard")).toBe("Created whiteboard");
    expect(labelForTool("add_to_whiteboard")).toBe("Adding to whiteboard");
    expect(pastTenseLabel("add_to_whiteboard")).toBe("Added to whiteboard");
  });

  it("reads a tool the plugin has not written yet", () => {
    // The point of deriving rather than listing: core names none of these.
    expect(labelForTool("create_board")).toBe("Creating board");
    expect(pastTenseLabel("create_object")).toBe("Created object");
  });

  it("keeps the wording the curated labels already had for core tools", () => {
    expect(labelForTool("create_work_item")).toBe("Creating work item");
    expect(pastTenseLabel("create_work_item")).toBe("Created work item");
    expect(labelForTool("list_projects")).toBe("Listing projects");
    expect(pastTenseLabel("list_projects")).toBe("Listed projects");
    expect(labelForTool("get_project")).toBe("Loading project");
    expect(pastTenseLabel("get_project")).toBe("Loaded project");
    expect(pastTenseLabel("send_email")).toBe("Sent email");
    expect(pastTenseLabel("write_file")).toBe("Wrote file");
  });

  it("reads a connector tool's namespace as a qualifier, not as the verb", () => {
    // `github_list_issues` — the verb is not first, and taking the first word as
    // one would read "Githubing list issues".
    expect(labelForTool("github_list_issues")).toBe("Listing github issues");
    expect(pastTenseLabel("slack_post_message")).toBe("Posted slack message");
    expect(pastTenseLabel("jira_create_issue")).toBe("Created jira issue");
  });

  it("never derives a past tense by suffix, which would produce garbage", () => {
    // "Sended", "Writed", "Readed" — the reason past forms are listed.
    expect(pastTenseLabel("send_email")).not.toContain("Sended");
    expect(pastTenseLabel("read_google_doc")).toBe("Read google doc");
    expect(pastTenseLabel("transition_item")).toBe("Moved item");
  });

  it("uses the curated label where the derived one would be wrong", () => {
    expect(labelForTool("semantic_search")).toBe("Searching the workspace");
    expect(pastTenseLabel("semantic_search")).toBe("Searched the workspace");
    expect(labelForTool("list_kpis")).toBe("Listing KPIs");
    expect(pastTenseLabel("describe_cql")).toBe("Explained CQL");
  });

  it("falls back to the raw name when no part of it is a verb", () => {
    // Unchanged behaviour, and deliberately not a guess: a name with no verb in
    // it has nothing to read.
    expect(labelForTool("nango_connection_thing")).toBe("Running nango_connection_thing");
    expect(pastTenseLabel("nango_connection_thing")).toBe("Ran nango_connection_thing");
  });

  it("has a label for a tool call with no name at all", () => {
    expect(labelForTool(undefined)).toBe("Running tool");
    expect(pastTenseLabel(undefined)).toBe("Ran tool");
  });
});
