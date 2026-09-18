import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GitLabClient } from "../../src/gitlab/api";

const servers: Server[] = [];

async function serve(handler: (url: string, headers: Record<string, string | string[] | undefined>) => { status: number; headers?: Record<string, string>; body?: string }): Promise<string> {
  const server = createServer((req, res) => {
    const { status, headers, body } = handler(req.url ?? "/", req.headers);
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(body ?? "{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

describe("GitLabClient", () => {
  it("never sends the token to a host it was redirected to", async () => {
    const received: (string | string[] | undefined)[] = [];
    const elsewhere = await serve((_url, headers) => {
      received.push(headers["private-token"]);
      return { status: 200, body: "[]" };
    });
    const gitlab = await serve(() => ({ status: 302, headers: { location: `${elsewhere}/api/v4/projects/1/issues` } }));

    const client = new GitLabClient("glpat-secret", `${gitlab}/api/v4`, "1");
    await expect(client.listIssues("flaky-test")).rejects.toThrow(/redirected to .*off this GitLab/);
    expect(received).toEqual([]);
  });

  it("follows a redirect that stays on the same GitLab", async () => {
    let moved = false;
    const gitlab = await serve((url, headers) => {
      if (!moved) {
        moved = true;
        return { status: 301, headers: { location: `/api/v4/projects/2/issues?labels=flaky-test` } };
      }
      return { status: 200, body: JSON.stringify([{ iid: 7, state: "opened", description: `seen ${url} with ${String(headers["private-token"])}` }]) };
    });
    const issues = await new GitLabClient("glpat-secret", `${gitlab}/api/v4`, "1").listIssues("flaky-test");
    expect(issues).toEqual([{ number: 7, state: "open", body: "seen /api/v4/projects/2/issues?labels=flaky-test with glpat-secret" }]);
  });
});
