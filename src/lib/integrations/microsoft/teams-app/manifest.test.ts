// COSMOS-202 T1: the app package an admin uploads to Teams. The manifest names
// our bot, unfurls only this instance's host, and the zip holds what Teams
// requires at its root: manifest.json and two icons of the right sizes.
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { teamsAppPackage, teamsManifest } from "./manifest";

const ARGS = { appId: "00000000-aaaa-bbbb-cccc-000000000001", origin: "https://cosmos.example" };

const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
};

describe("Teams app package", () => {
  it("names our bot for both commands and unfurls only this instance's host", () => {
    const m = teamsManifest(ARGS);
    expect(m.id).toBe(ARGS.appId);
    expect(m.composeExtensions[0].botId).toBe(ARGS.appId);
    expect(m.composeExtensions[0].commands.map((c) => [c.id, c.type])).toEqual([["searchItems", "query"], ["createItem", "action"]]);
    expect(m.composeExtensions[0].commands[1].context).toEqual(["message"]);
    expect(m.composeExtensions[0].messageHandlers).toEqual([{ type: "link", value: { domains: ["cosmos.example"] } }]);
    expect(m.validDomains).toEqual(["cosmos.example"]);
    expect(m).not.toHaveProperty("bots"); // message extensions only: nobody chats with it in T1
  });

  it("declares the tabs on this host, and SSO for our App ID URI", () => {
    const m = teamsManifest(ARGS);
    expect(m.staticTabs).toEqual([expect.objectContaining({ contentUrl: "https://cosmos.example/teams/tab/my-work", scopes: ["personal"] })]);
    expect(m.configurableTabs).toEqual([expect.objectContaining({ configurationUrl: "https://cosmos.example/teams/tab/configure" })]);
    expect(m.webApplicationInfo).toEqual({ id: ARGS.appId, resource: `api://cosmos.example/${ARGS.appId}` });
  });

  it("zips manifest.json and the 192 px color and 32 px outline icons at the root", () => {
    const files = unzipSync(teamsAppPackage(ARGS));
    expect(Object.keys(files).sort()).toEqual(["color.png", "manifest.json", "outline.png"]);
    expect(JSON.parse(strFromU8(files["manifest.json"])).id).toBe(ARGS.appId);
    for (const [f, size] of [["color.png", 192], ["outline.png", 32]] as const) {
      expect([...files[f].subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(pngSize(files[f])).toEqual([size, size]);
    }
  });
});
