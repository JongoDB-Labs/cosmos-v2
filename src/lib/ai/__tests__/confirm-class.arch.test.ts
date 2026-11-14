// Every tool that deletes, removes a member, closes a ceremony or changes many
// things at once is tagged `confirm: true` in the registry, so the agent loop
// asks the user before it runs. A new tool named that way without the tag
// fails here.
import { describe, it, expect } from "vitest";
import { cosmosTools } from "../tools";
import { isConfirmClass, nameIsConfirmClass } from "../confirm-class";

/** Today's confirm-class tools. Listed so a tag can't silently fall off one either. */
const EXPECTED = [
  "add_project_member",
  "add_team_member",
  "bulk_update_work_items",
  "close_ceremony",
  "delete_board",
  "delete_calendar_event",
  "delete_ceremony_action",
  "delete_ceremony_note",
  "delete_comment",
  "delete_meeting",
  "delete_milestone",
  "delete_note",
  "delete_objective",
  "delete_saved_view",
  "delete_work_item",
  "remove_project_member",
  "remove_team_member",
  "share_calendar_event",
  "share_note",
  "share_saved_view",
];

describe("confirm-class tools are tagged in the registry", () => {
  it("every tool whose name makes it confirm-class carries confirm: true", () => {
    const untagged = cosmosTools.filter((t) => nameIsConfirmClass(t.name) && t.confirm !== true).map((t) => t.name);
    expect(untagged).toEqual([]);
  });

  it("positive control: the tagged set is exactly today's confirm-class tools", () => {
    const tagged = cosmosTools.filter((t) => t.confirm === true).map((t) => t.name).sort();
    expect(tagged).toEqual([...EXPECTED].sort());
  });

  it("the name rule catches a new tool, and leaves ordinary writes alone", () => {
    for (const n of ["delete_widget", "bulk_archive_items", "remove_project_member", "remove_team_member", "close_ceremony"]) {
      expect(nameIsConfirmClass(n)).toBe(true);
    }
    // Anything that grants, removes or changes access: membership, roles,
    // permissions, sharing.
    for (const n of [
      "add_project_member", "add_team_member", "set_project_member_role", "update_work_role", "assign_work_role",
      "share_saved_view", "share_document", "grant_project_access", "revoke_api_key", "change_member_permissions",
    ]) {
      expect(nameIsConfirmClass(n), n).toBe(true);
    }
    for (const n of [
      "update_work_item", "archive_work_item", "create_board", "list_deleted_items", "list_project_members",
      "list_org_members", "update_project", "add_ceremony_note", "assign_work_item",
    ]) {
      expect(nameIsConfirmClass(n), n).toBe(false);
    }
  });

  it("the tag counts even where the name doesn't (a plugin may tag any tool)", () => {
    expect(isConfirmClass({ name: "wipe_canvas", confirm: true })).toBe(true);
    expect(isConfirmClass({ name: "wipe_canvas" })).toBe(false);
    expect(isConfirmClass({ name: "delete_canvas" })).toBe(true);
  });
});
