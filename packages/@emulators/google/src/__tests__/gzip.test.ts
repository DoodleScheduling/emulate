import { gzipSync } from "node:zlib";
import { createServer } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const redirect = "http://localhost/callback";
const input = {
  summary: "SDK event",
  start: { dateTime: "2026-10-21T09:00:00Z" },
  end: { dateTime: "2026-10-21T10:00:00Z" },
};

async function fixture(scope = "https://www.googleapis.com/auth/calendar") {
  const runtime = createServer(googlePlugin, { baseUrl: base });
  seedFromConfig(runtime.store, base, {
    strict_scopes: true,
    users: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
    calendars: [
      { id: "primary", user_email: "alice@example.com", summary: "Alice", primary: true },
      { id: "private", user_email: "bob@example.com", summary: "Bob" },
    ],
    oauth_clients: [{ client_id: "client", client_secret: "secret", redirect_uris: [redirect] }],
  });
  const form = (path: string, data: Record<string, string>) =>
    runtime.app.request(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data),
    });
  const grant = await form("/o/oauth2/v2/auth/callback", {
    email: "alice@example.com",
    client_id: "client",
    redirect_uri: redirect,
    scope,
  });
  expect(grant.status).toBe(302);
  const exchange = await form("/oauth2/token", {
    grant_type: "authorization_code",
    client_id: "client",
    client_secret: "secret",
    redirect_uri: redirect,
    code: new URL(grant.headers.get("Location")!).searchParams.get("code")!,
  });
  expect(exchange.status).toBe(200);
  const { access_token: token } = (await exchange.json()) as { access_token: string };
  const post = (body: Uint8Array | string, encoding?: string, bearer = token, calendar = "primary") =>
    runtime.app.request(`${base}/calendar/v3/calendars/${calendar}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(encoding ? { "Content-Encoding": encoding } : {}),
      },
      body: typeof body === "string" ? body : new Uint8Array(body).buffer,
    });
  return { ...runtime, post, token };
}

describe("Google gzip request bodies", () => {
  it.each([undefined, "opaque", "transparent"])(
    "preserves transparency %s in event reads and free/busy",
    async (transparency) => {
      const { app, post, token } = await fixture();
      const response = await post(gzipSync(JSON.stringify({ ...input, transparency })), "gzip");
      expect(response.status).toBe(200);
      const created = (await response.json()) as { id: string; transparency: string };
      expect(created.transparency).toBe(transparency ?? "opaque");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const listed = await app.request(`${base}/calendar/v3/calendars/primary/events`, { headers });
      expect(await listed.json()).toMatchObject({
        items: [{ id: created.id, transparency: transparency ?? "opaque" }],
      });
      const busy = await app.request(`${base}/calendar/v3/freeBusy`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          timeMin: input.start.dateTime,
          timeMax: input.end.dateTime,
          items: [{ id: "primary" }],
        }),
      });
      expect(await busy.json()).toMatchObject({
        calendars: {
          primary: {
            busy: transparency === "transparent" ? [] : [{ start: input.start.dateTime, end: input.end.dateTime }],
          },
        },
      });
    },
  );

  it.each([undefined, "identity", "gzip", " GZip "])("creates an event with encoding %s", async (encoding) => {
    const { post } = await fixture();
    const json = JSON.stringify(input);
    const response = await post(encoding?.trim().toLowerCase() === "gzip" ? gzipSync(json) : json, encoding);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ summary: input.summary, start: input.start, end: input.end });
  });

  it.each([
    { name: "malformed gzip", body: Buffer.from("not gzip"), encoding: "gzip", status: 400 },
    {
      name: "decoded size limit",
      body: gzipSync(JSON.stringify({ ...input, description: "x".repeat(2 * 1024 * 1024) })),
      encoding: "gzip",
      status: 413,
    },
    { name: "compressed size limit", body: Buffer.alloc(2 * 1024 * 1024 + 1), encoding: "gzip", status: 413 },
    { name: "unsupported encoding", body: JSON.stringify(input), encoding: "br", status: 415 },
  ])("refuses $name without a state change", async ({ body, encoding, status }) => {
    const { store, post } = await fixture();
    const before = JSON.stringify(store.snapshot());
    expect((await post(body, encoding)).status).toBe(status);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it("keeps authentication, write scopes and account isolation before decoding", async () => {
    const { store, post } = await fixture();
    const before = JSON.stringify(store.snapshot());
    expect((await post("not gzip", "gzip", "unknown")).status).toBe(401);
    expect((await post(gzipSync(JSON.stringify(input)), "gzip", undefined, "private")).status).toBe(404);
    expect(JSON.stringify(store.snapshot())).toBe(before);
    const readonly = await fixture("https://www.googleapis.com/auth/calendar.events.readonly");
    expect((await readonly.post(gzipSync(JSON.stringify(input)), "gzip")).status).toBe(403);
  });
});
