import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HttpCloakTransport } from "../src/httpcloak-transport.js";

const capture = JSON.parse(await readFile(new URL("../captures/browser-observed.json", import.meta.url), "utf8"));

test("wire headers on a local server match captured initial document values", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ method: request.method, rawHeaders: request.rawHeaders }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = new HttpCloakTransport({ httpVersion: "h1" });
  try {
    const url = `http://127.0.0.1:${server.address().port}/webapps/login/`;
    const response = await transport.request(url, { fetchMode: "navigate" });
    const observed = JSON.parse(await response.text());
    const headers = Object.fromEntries(Array.from({ length: observed.rawHeaders.length / 2 }, (_, index) => [
      observed.rawHeaders[index * 2].toLowerCase(), observed.rawHeaders[index * 2 + 1],
    ]));
    assert.equal(observed.method, capture.initialDocumentRequest.method);
    for (const [name, value] of Object.entries(capture.initialDocumentRequest.headers)) assert.equal(headers[name], value, name);
  } finally {
    transport.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
