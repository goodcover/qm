import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

async function fixture(t: TestContext) {
  const built = buildApp(testConfig());
  await built.deploymentLayerReady;
  for (const actor of ["U1", "U2"]) {
    const computer = await built.sandboxResources.create(actor, `personal:${actor}`, "sprites", "default");
    await built.sandboxResources.setDefault(actor, `personal:${actor}`, computer.id);
  }
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  let provisions = 0;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = async (...args) => {
    provisions++;
    return provision(...args);
  };
  const turn = async (text: string, actor = "U1") => {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: actor },
      conversation: { kind: "dm", threadRef: `dm:${actor}:skill-source` },
      text,
    } as TurnRequest);
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.reply ?? "";
  };
  const publish = async (scopeId: string, body: string, packId?: string, name = "source-helper") => {
    const skill = await built.skills.create({
      scopeId,
      createdBy: "U1",
      ...(packId ? { pack: { packId, commit: "c", upstreamName: name } } : {}),
      manifest: {
        name,
        description: "source test",
        body,
        requiredCapabilities: [],
        files: [{ path: "references/example.txt", content: "PUBLISHED_ASSET" }],
      },
    });
    await built.skills.review(skill.id, "reviewer", []);
    await built.skills.publish(skill.id);
    return skill;
  };
  return { ...built, turn, publish, provisions: () => provisions };
}

test("published skill sources and assets read without a sandbox, respecting scope and archive", async (t) => {
  const b = await fixture(t);
  const skill = await b.publish("personal:U1", "PUBLISHED_BODY");
  assert.match(await b.turn("!sysprompt source-helper"), /\*\*source-helper\*\*/);
  assert.match(
    await b.turn("!skill source-helper"),
    /^\/.+\/\.agent-skills\/\w+\/[a-f0-9]{16}\/source-helper\nPUBLISHED_BODY$/,
  );
  assert.match(await b.turn("!skill source-helper references/example.txt"), /\nPUBLISHED_ASSET$/);
  assert.equal(await b.turn("!skill-run source-helper cat {dir}/references/example.txt"), "PUBLISHED_ASSET");
  assert.match(await b.turn("!skill source-helper", "U2"), /no skill file/);
  await b.skills.archive(skill.id);
  assert.match(await b.turn("!skill source-helper"), /no skill file/);
  assert.equal(b.provisions(), 3);
});

test("a body-only skill loads without any sandbox work", async (t) => {
  const b = await fixture(t);
  const skill = await b.skills.create({
    scopeId: "personal:U1",
    createdBy: "U1",
    manifest: { name: "notes-only", description: "text only", body: "JUST_TEXT", requiredCapabilities: [] },
  });
  await b.skills.review(skill.id, "reviewer", []);
  await b.skills.publish(skill.id);
  assert.equal(await b.turn("!skill notes-only"), "JUST_TEXT");
  assert.equal(await b.turn("!run echo hi"), "hi");
  assert.equal(b.provisions(), 1);
});

test("published skill loads reject invalid and control paths without provisioning", async (t) => {
  const b = await fixture(t);
  await b.publish("personal:U1", "PUBLISHED_BODY");
  for (const [name, path] of [
    ["missing", "SKILL.md"],
    ["source-helper", "../SKILL.md"],
    ["source-helper", ".tree"],
    ["..", "SKILL.md"],
    ["source-helper", "/SKILL.md"],
    ["source-helper", "./SKILL.md"],
    ["source-helper", "references/../../secret"],
    ["source-helper", "%2e%2e/secret"],
  ])
    assert.match(await b.turn(`!skill ${name} ${path}`), /no skill file/, `${name}/${path}`);
  assert.equal(b.provisions(), 0);
});

test("published source follows scope shadowing and preserves sandbox-authored working copies", async (t) => {
  const b = await fixture(t);
  await b.publish("org:default-org", "ORG_BODY");
  const personal = await b.publish("personal:U1", "PERSONAL_BODY");
  assert.match(await b.turn("!skill source-helper"), /\nPERSONAL_BODY$/);
  await b.turn("!write skills/source-helper/SKILL.md LOCAL_EDIT");
  assert.match(await b.turn("!skill source-helper"), /\nPERSONAL_BODY$/);
  assert.equal(await b.turn("!read skills/source-helper/SKILL.md"), "LOCAL_EDIT");
  await b.skills.archive(personal.id);
  assert.match(await b.turn("!skill source-helper"), /\nORG_BODY$/);
});

test("a body read avoids sandbox work and a file request materializes that skill under the skills root", async () => {
  const { createTurnSandboxes } = await import("../src/core/orchestrator/sandboxes.ts");
  const { SandboxAccessError } = await import("../src/sandbox/sandbox-resources.ts");
  type TurnSandboxContext = import("../src/core/orchestrator/sandboxes.ts").TurnSandboxContext;
  type SkillResolution = import("../src/skills/skill-store.ts").SkillResolution;
  const files = new Map<string, string>();
  let provisions = 0;
  const sandboxIds: Array<string | undefined> = [];
  let resolution = {
    skill: {
      id: "s",
      version: 1,
      scopeId: "personal:U1",
      manifest: {
        name: "source-helper",
        body: "BODY",
        files: [{ path: "references/example.txt", content: "v1" }],
      },
    },
    shadowed: [],
  } as unknown as SkillResolution;
  const unrelated = structuredClone(resolution);
  unrelated.skill!.id = "other";
  unrelated.skill!.manifest.name = "unrelated";
  unrelated.skill!.pack = { packId: "other-pack", commit: "c", upstreamName: "unrelated" };
  const visible = [resolution, unrelated];
  const handle = { id: "box", rootDir: "/workspace" };
  const turn = createTurnSandboxes({
    deps: {
      skills: { recordUse: async () => {} },
      sandboxResources: {
        access: async (_actor: string, id: string) => {
          if (id !== "resource-1" && id !== "box") throw new SandboxAccessError("sandbox not found");
          return { id, ownerScopeId: "personal:U1" };
        },
      },
      sandbox: {
        provision: async (_layers: unknown, options?: { sandboxId?: string }) => {
          sandboxIds.push(options?.sandboxId);
          provisions++;
          return { ...handle, id: options?.sandboxId ?? handle.id };
        },
        listDir: async () => [],
        removeDir: async () => {},
        readFile: async (_handle: unknown, path: string) => files.get(path) ?? null,
        writeFile: async (_handle: unknown, path: string, content: string) => {
          files.set(path, content);
        },
      },
    },
    input: { origin: { kind: "human" } },
    actor: { id: "U1" },
    session: { id: "s" },
    resolution: { layers: [{ scopeId: "personal:U1", mountPath: "", mode: "rw" }] },
    scopeId: "personal:U1",
    memoryScopeId: "personal:U1",
    turnSessionDir: "turn/s",
    turnFilesDir: "turn/s/t",
    connectorEnv: {},
    visibleSkillsForTurn: async () => visible,
    emitGapWork: () => {},
  } as unknown as TurnSandboxContext);
  const bodyOnly = structuredClone(unrelated);
  bodyOnly.skill!.id = "body-only";
  bodyOnly.skill!.manifest.name = "body-only";
  bodyOnly.skill!.manifest.files = [];
  delete bodyOnly.skill!.pack;
  visible.push(bodyOnly);
  assert.deepEqual(await turn.useSkill("body-only", "SKILL.md"), { content: "BODY", sourceScopeId: "personal:U1" });
  await assert.rejects(turn.useSkill("source-helper", "SKILL.md", ""), /non-empty/);
  await assert.rejects(turn.useSkill("source-helper", "SKILL.md", "missing"), /sandbox not found/);
  assert.equal(provisions, 0);
  await turn.provision();
  assert.equal(provisions, 1);
  assert.equal(files.size, 0);
  resolution = structuredClone(resolution);
  resolution.skill!.manifest.files![0]!.content = "v2";
  visible[0] = resolution;
  const loaded = await turn.useSkill("source-helper", "references/example.txt");
  assert.equal(loaded.content, "v2");
  assert.match(loaded.dir!, /^\/workspace\/\.agent-skills\/s\/[a-f0-9]{16}\/source-helper$/);
  const root = loaded.dir!.slice("/workspace/".length, -"/source-helper".length);
  assert.equal(provisions, 1);
  assert.equal(files.get(`${root}/source-helper/references/example.txt`), "v2");
  files.set(`${root}/source-helper/references/example.txt`, "local edit");
  assert.equal((await turn.useSkill("source-helper", "SKILL.md")).dir, loaded.dir);
  assert.equal(files.get(`${root}/source-helper/references/example.txt`), "local edit");
  await turn.useSkill("source-helper", "SKILL.md", "box");
  assert.equal(files.get(`${root}/source-helper/references/example.txt`), "local edit");
  resolution.skill!.pack = { packId: "pack", commit: "c", upstreamName: "source-helper" };
  resolution.screenedBundles = [
    { packId: "pack", commit: "c", hash: "pack-hash", files: [{ path: "lib.txt", content: "PACK_RESOURCE" }] },
  ];
  const beforeResource = new Map(files);
  await turn.provisionResource("resource-1");
  assert.deepEqual(files, beforeResource);
  const onResource = await turn.useSkill("source-helper", "SKILL.md", "resource-1");
  assert.equal(onResource.dir, loaded.dir);
  assert.equal(onResource.packDir, `/workspace/${root}/.packs/pack`);
  assert.deepEqual(sandboxIds, [undefined, "box", "resource-1"]);
  assert.equal(files.get(`${root}/.packs/pack/lib.txt`), "PACK_RESOURCE");
  assert.equal(
    [...files.keys()].some((path) => path.includes("/unrelated/")),
    false,
  );
});

test("pack assets run from the skills root and stay across turns", async (t) => {
  const { computeBundleHash } = await import("../src/skills/skill-bundle-store.ts");
  const b = await fixture(t);
  const skill = await b.publish("personal:U1", "PACK_BODY", "source-pack");
  const files = [{ path: "example.sh", content: "printf PACK_ASSET" }];
  await b.skillBundles.put({ packId: "source-pack", commit: "c", files, hash: computeBundleHash(files) });
  assert.match(await b.turn("!skill source-helper"), /\.agent-skills\/\w+\/[a-f0-9]{16}\/\.packs\/source-pack/);
  assert.equal(b.provisions(), 1);
  assert.equal(await b.turn("!skill-run source-helper sh {dir}/../.packs/source-pack/example.sh"), "PACK_ASSET");
  assert.equal(await b.turn("!run find . -name example.sh | wc -l | tr -d ' '"), "1");
  await b.skills.archive(skill.id);
  assert.match(await b.turn("!skill source-helper"), /no skill file/);
});

test("owner sandbox loads current global skill sources separately and removes revoked trees", async () => {
  const { createTurnSandboxes } = await import("../src/core/orchestrator/sandboxes.ts");
  type TurnSandboxContext = import("../src/core/orchestrator/sandboxes.ts").TurnSandboxContext;
  type SkillResolution = import("../src/skills/skill-store.ts").SkillResolution;
  const disks = new Map<string, Map<string, string>>();
  const provisions: string[] = [];
  const skill = (name: string, scopeId: string): SkillResolution =>
    ({
      skill: {
        id: name,
        version: 1,
        scopeId,
        pack: { packId: "pack", commit: "c", upstreamName: name },
        manifest: { name, body: name, files: [{ path: "scripts/run.py", content: name }] },
      },
      shadowed: [],
    }) as unknown as SkillResolution;
  let current = [skill("commander", "org:default-org"), skill("room-helper", "channel:room")];
  let failWrites = false;
  let reads = 0;
  let revokeAtRead = 0;
  let writes = 0;
  const turn = createTurnSandboxes({
    deps: {
      skills: { recordUse: async () => {} },
      sandbox: {
        provision: async (_layers: unknown, options?: { scratch?: unknown }) => {
          const id = options?.scratch ? "owner" : "shared";
          provisions.push(id);
          disks.set(id, new Map());
          return { id, rootDir: "/workspace" };
        },
        listDir: async () => [],
        removeDir: async (h: { id: string }, path: string) => {
          const files = disks.get(h.id)!;
          for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        },
        readFile: async (h: { id: string }, path: string) => disks.get(h.id)?.get(path) ?? null,
        writeFile: async (h: { id: string }, path: string, content: string) => {
          writes++;
          if (failWrites && path.endsWith("scripts/run.py")) throw new Error("fixture write failed");
          disks.get(h.id)!.set(path, content);
        },
      },
    },
    input: { origin: { kind: "human" } },
    actor: { id: "U1" },
    session: { id: "s" },
    resolution: {
      layers: [
        { scopeId: "org:default-org", mountPath: "global", mode: "ro" },
        { scopeId: "channel:room", mountPath: "", mode: "rw" },
      ],
    },
    scopeId: "channel:room",
    memoryScopeId: "channel:room",
    turnSessionDir: "turn/s",
    turnFilesDir: "turn/s/t",
    transferId: "t",
    connectorEnv: {},
    ownerAuthAvailable: true,
    visibleSkillsForTurn: async () => {
      if (++reads === revokeAtRead) current = [];
      return current;
    },
    emitGapWork: () => {},
  } as unknown as TurnSandboxContext);
  const { hashId } = await import("../src/util/crypto.ts");
  const assetPath = (name: string) => `.agent-skills/s/${hashId([name, "1"], 16)}/${name}/scripts/run.py`;
  await turn.provisionOwnerAuth!();
  assert.deepEqual(provisions, ["owner"]);
  assert.equal(disks.get("owner")!.get(assetPath("commander")), "commander");
  assert.ok(![...disks.get("owner")!.keys()].some((path) => path.includes("room-helper")));
  const writesBeforeUsageUpdate = writes;
  current = current.map((r) => ({ ...r, skill: { ...r.skill!, lastUsedAt: Date.now() } }));
  await turn.provisionOwnerAuth!();
  assert.equal(writes, writesBeforeUsageUpdate);
  const loaded = await turn.useSkill("commander", "SKILL.md");
  assert.equal(loaded.dir, `/workspace/${assetPath("commander").replace("/scripts/run.py", "")}`);
  assert.equal(disks.get("shared")!.get(`${loaded.dir!.replace("/workspace/", "")}/scripts/run.py`), "commander");
  turn.invalidateProvision();
  const reloaded = await turn.useSkill("commander", "SKILL.md");
  assert.equal(disks.get("shared")!.get(`${reloaded.dir!.replace("/workspace/", "")}/scripts/run.py`), "commander");
  current = [];
  await turn.provisionOwnerAuth!();
  assert.ok(!disks.get("owner")!.has(assetPath("commander")));
  current = [skill("commander", "org:default-org")];
  failWrites = true;
  await assert.rejects(turn.provisionOwnerAuth!(), /fixture write failed/);
  failWrites = false;
  current = [skill("new-helper", "org:default-org")];
  reads = 0;
  revokeAtRead = 2;
  await assert.rejects(turn.provisionOwnerAuth!(), /global skills changed/);
  assert.ok(!disks.get("owner")!.has(assetPath("new-helper")));
});
