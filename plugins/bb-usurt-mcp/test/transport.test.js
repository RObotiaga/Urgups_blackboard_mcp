import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HttpCloakTransport } from "../src/httpcloak-transport.js";

const capture = JSON.parse(await readFile(new URL("../captures/browser-observed.json", import.meta.url), "utf8"));

test("default transport uses the HTTP/1.1 protocol observed in the browser", () => {
  const transport = new HttpCloakTransport({ session: { headers: {}, close() {} } });
  try {
    assert.equal(capture.wireObservation.request.protocol, "http/1.1");
    assert.equal(transport.info.httpVersion, "h1");
  } finally {
    transport.close();
  }
});

test("wire headers preserve stable navigation values and use the latest captured browser version", async () => {
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
    const versionedHeaders = new Set(["user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
    for (const [name, value] of Object.entries(capture.initialDocumentRequest.headers)) if (!versionedHeaders.has(name)) assert.equal(headers[name], value, name);
    const latestHeaders = capture.observedRoutes.find(route => route.feature === "calendar-assignment-feed").safeHeaders;
    const latestHeadersLower = Object.fromEntries(Object.entries(latestHeaders).map(([name, value]) => [name.toLowerCase(), value]));
    for (const name of versionedHeaders) assert.equal(headers[name], latestHeadersLower[name], name);
  } finally {
    transport.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
