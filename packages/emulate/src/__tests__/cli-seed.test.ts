import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config-loader.js";
import { prepareStartServices, createPreparedServiceServer, seedPreparedService } from "../commands/start.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function config(client: Record<string, unknown>, named = false) {
  const directory = await mkdtemp(join(tmpdir(), "emulate-cli-seed-"));
  directories.push(directory);
  const seed = { oauth_clients: [{ client_id: "client", redirect_uris: ["http://localhost/callback"], ...client }] };
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify(named ? { services: { local: { emulator: "google", seed } } } : { google: seed }),
  );
  return { directory, path };
}

describe("Google CLI secret files", () => {
  it.each([false, true])("resolves a relative secret file in named config: %s", async (named) => {
    const { directory, path } = await config({ client_secret_file: "oauth-secret" }, named);
    await writeFile(join(directory, "oauth-secret"), "test-secret\n");
    const loaded = await loadConfig({ config: path });
    try {
      expect(loaded.services[0].seed).toMatchObject({ oauth_clients: [{ client_secret: "test-secret" }] });
      expect(JSON.stringify(loaded.services[0].seed)).not.toContain("client_secret_file");
    } finally {
      loaded.loader.close();
    }
  });

  it("keeps inline secrets unchanged and supports an absolute mounted file", async () => {
    const { directory, path } = await config({ client_secret: "inline" });
    const inline = await loadConfig({ config: path });
    expect(inline.services[0].seed).toMatchObject({ oauth_clients: [{ client_secret: "inline" }] });
    inline.loader.close();
    const file = join(directory, "mounted-secret");
    await writeFile(file, "mounted");
    await writeFile(path, JSON.stringify({ google: { oauth_clients: [{ client_secret_file: file }] } }));
    const mounted = await loadConfig({ config: path });
    expect(mounted.services[0].seed).toMatchObject({ oauth_clients: [{ client_secret: "mounted" }] });
    mounted.loader.close();
  });

  it.each([
    [{ client_secret_file: "missing" }, "Cannot read"],
    [{ client_secret_file: "" }, "non-empty file path"],
    [{ client_secret_file: 123 }, "non-empty file path"],
    [{ client_secret_file: "secret", client_secret: "do-not-log-this" }, "only one"],
  ])("fails before startup for invalid sources %s", async (client, message) => {
    const { path } = await config(client as Record<string, unknown>);
    await expect(loadConfig({ config: path })).rejects.toThrow(message as string);
    await expect(loadConfig({ config: path })).rejects.not.toThrow("do-not-log-this");
  });

  it("refuses empty and unreadable files", async () => {
    const { directory, path } = await config({ client_secret_file: "secret" });
    await writeFile(join(directory, "secret"), " \n");
    await expect(loadConfig({ config: path })).rejects.toThrow("must not be empty");
    await writeFile(path, JSON.stringify({ google: { oauth_clients: [{ client_secret_file: directory }] } }));
    await expect(loadConfig({ config: path })).rejects.toThrow("Cannot read");
  });
});

describe("CLI default seed selection", () => {
  it.each([undefined, true, false])("keeps configured users with defaultSeed=%s", async (defaultSeed) => {
    const { prepared } = await prepareStartServices(
      ["google"],
      {
        google: { users: [{ email: "configured@example.com" }], strict_scopes: true },
      },
      { port: 4000 },
      false,
    );
    const runtime = createPreparedServiceServer(prepared[0], {});
    try {
      seedPreparedService(prepared[0], runtime.store, runtime.webhooks, defaultSeed);
      const response = await runtime.app.request("http://localhost:4000/o/oauth2/v2/auth");
      const html = await response.text();
      expect(html).toContain("configured@example.com");
      expect(html.includes("testuser@gmail.com")).toBe(defaultSeed !== false);
    } finally {
      runtime.store.reset();
      runtime.webhooks.clear();
    }
  });
});
