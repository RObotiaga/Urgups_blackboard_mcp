import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertRequestParity, BROWSER_HEADER_PROFILE, buildCourseSearchRequest } from "../src/protocol.js";
import { BbUsurtClient, buildDwrEwsViewInfoRequest, encodeBrowserMultipart, parseCourseCatalogEntries, parseDwrReply, summarizePage } from "../src/blackboard-client.js";
import { HttpCloakTransport } from "../src/httpcloak-transport.js";

const capture = JSON.parse(await readFile(new URL("../captures/browser-observed.json", import.meta.url), "utf8"));

test("catalog search matches the body captured from the live browser form", () => {
  const actual = buildCourseSearchRequest("2026");
  assertRequestParity(actual, capture.browserFormCapture.actual);
  assert.equal(actual.body.split("&").map(part => part.split("=", 1)[0]).join(","), capture.browserFormCapture.bodyFieldOrder.join(","));
});

test("search request keeps browser field ordering and form encoding", () => {
  const actual = buildCourseSearchRequest("сети и связь");
  assert.equal(actual.body, "type=Course&command=NewSearch&searchText=%D1%81%D0%B5%D1%82%D0%B8+%D0%B8+%D1%81%D0%B2%D1%8F%D0%B7%D1%8C");
});

test("catalog search parses course rows with instructor and enrollment action", () => {
  const html = `<table><tr><td><a href="#" title="Зачислить">Зачислить</a>Название курса: 2026_Теория безопасности_Коваленко Владимир Николаевич Инструктор: Коваленко Владимир Николаевич Описание: Учебники:</td></tr></table>`;
  assert.deepEqual(parseCourseCatalogEntries(html), [{
    kind: "course-catalog",
    label: "2026_Теория безопасности_Коваленко Владимир Николаевич",
    courseName: "2026_Теория безопасности_Коваленко Владимир Николаевич",
    instructor: "Коваленко Владимир Николаевич",
    enrollmentAvailable: true,
  }]);
});

test("search loads the live Courses-tab form and submits its exact native form shape", async () => {
  const calls = [];
  const portalUrl = "https://bb.usurt.ru/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";
  const coursesUrl = "https://bb.usurt.ru/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_2";
  const formPage = `<form action="/webapps/blackboard/execute/viewCatalog" method="post" enctype="application/x-www-form-urlencoded"><input type="hidden" name="type" value=""><input type="hidden" name="command" value=""><input type="text" name="searchText"><input type="submit" value="Перейти"></form>`;
  const transport = new HttpCloakTransport({ session: {
    headers: {},
    async request(method, url, options) {
      calls.push({ method, url, options });
      let text = "<html><title>Blackboard</title></html>";
      if (url === portalUrl) text = `<a href="${coursesUrl}">Курсы Вкладка 2 из 5</a>`;
      else if (url === coursesUrl) text = formPage;
      else if (url === capture.browserFormCapture.actual.url) text = `<a href="/webapps/blackboard/execute/launcher?type=Course&amp;id=test-id">Test course</a>`;
      return { statusCode: 200, reason: "OK", ok: true, url, protocol: "h1", headers: {}, body: Buffer.from(text), text };
    },
    close() {},
  } });
  const client = new BbUsurtClient({ transport });
  client.authenticated = true;
  try {
    const result = await client.searchCourses("2026");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, portalUrl);
    assert.equal(calls[1].url, coursesUrl);
    assert.equal(calls[2].method, "POST");
    assert.equal(calls[2].url, capture.browserFormCapture.actual.url);
    assert.equal(calls[2].options.body, capture.browserFormCapture.actual.body);
    assert.equal(calls[2].options.headers.Origin, "https://bb.usurt.ru");
    assert.equal(transport.session.headers.Accept, BROWSER_HEADER_PROFILE.Accept);
    assert.equal(result.browserParity.includes("byte-for-byte"), true);
  } finally {
    client.close();
  }
});

test("HTTPcloak session applies the latest captured browser header values", async () => {
  const session = { headers: { "X-Preset": "preserved" }, request: async (_method, url, options) => {
    session.last = { url, options };
    return { statusCode: 200, reason: "OK", ok: true, url, protocol: "h1", headers: {}, body: Buffer.from("ok"), text: "ok" };
  }, close() {} };
  const transport = new HttpCloakTransport({ session });
  const response = await transport.request("https://bb.usurt.ru/webapps/login/", { fetchMode: "navigate" });
  const profileByLowerName = Object.fromEntries(Object.entries(BROWSER_HEADER_PROFILE).map(([name, value]) => [name.toLowerCase(), value]));
  const latestHeaders = capture.observedRoutes.find(route => route.feature === "calendar-assignment-feed").safeHeaders;
  for (const name of ["User-Agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]) assert.equal(profileByLowerName[name.toLowerCase()], latestHeaders[name] ?? latestHeaders[name.toLowerCase()]);
  for (const [name, value] of Object.entries(BROWSER_HEADER_PROFILE)) assert.equal(session.headers[name], value);
  assert.equal(session.headers["X-Preset"], "preserved");
  assert.equal(session.last.options.headers["Sec-Fetch-Mode"], "navigate");
  assert.equal(session.last.options.headers["Sec-Fetch-Dest"], "document");
  assert.equal(session.last.options.headers["Sec-Fetch-User"], "?1");
  const sentHeaders = Object.fromEntries([
    ...Object.entries(session.headers),
    ...Object.entries(session.last.options.headers),
  ].map(([name, value]) => [name.toLowerCase(), value]));
  assert.equal(transport.info.httpVersion, "h1");
  const versionedHeaderNames = new Set(["user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
  for (const [name, value] of Object.entries(capture.wireObservation.request.safeHeaders)) {
    if (["host", "connection"].includes(name.toLowerCase()) || versionedHeaderNames.has(name.toLowerCase())) continue;
    assert.equal(sentHeaders[name.toLowerCase()], value, name);
  }
  assert.equal(await response.text(), "ok");
  transport.close();
});

test("manual streaming transport sets explicit fetch metadata", async () => {
  let streamOptions;
  const stream = {
    statusCode: 200, reason: "OK", ok: true, url: "https://bb.usurt.ru/file", protocol: "h1", headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from("file"); }, close() { stream.closed = true; },
  };
  const session = { headers: {}, requestStream(_method, _url, options) { streamOptions = options; return stream; }, close() {} };
  const transport = new HttpCloakTransport({ session });
  const response = await transport.request("https://bb.usurt.ru/file", { headers: { Referer: "https://bb.usurt.ru/course" }, fetchMode: "navigate", streaming: true });
  assert.equal(streamOptions.headers["Sec-Fetch-Site"], "same-origin");
  assert.equal(streamOptions.headers["Sec-Fetch-Mode"], "navigate");
  assert.equal(streamOptions.headers["Sec-Fetch-Dest"], "document");
  assert.equal(await response.text(), "file");
  assert.equal(stream.closed, true);
  transport.close();
});

test("request trace shows effective safe headers and never cookie values", async () => {
  const session = { headers: {}, request: async (_method, url) => ({
    statusCode: 200, reason: "OK", ok: true, url, protocol: "h1", headers: {}, body: Buffer.alloc(0), text: "",
  }), close() {} };
  const transport = new HttpCloakTransport({ session });
  const client = new BbUsurtClient({ transport });
  await client.request("https://bb.usurt.ru/webapps/login/", { referer: "", fetchMode: "navigate" });
  const headers = client.lastTrace.request.headers;
  assert.equal(headers["User-Agent"], BROWSER_HEADER_PROFILE["User-Agent"]);
  assert.equal(headers["Sec-Fetch-Site"], "none");
  assert.equal(headers["Sec-Fetch-Mode"], "navigate");
  assert.equal(headers["Upgrade-Insecure-Requests"], "1");
  assert.equal(Object.keys(headers).some(name => name.toLowerCase() === "cookie"), false);
  client.close();
});

test("multipart form body preserves field order and binary file bytes", async () => {
  const boundary = "----WebKitFormBoundary1234567890123456";
  const payload = Buffer.from([0, 255, 13, 10, 42]);
  const result = await encodeBrowserMultipart([
    ["before", "one"],
    ["upload", { filePath: "answer.bin" }],
    ["after", "two"],
  ], { boundary, fileReader: async () => payload });
  const first = result.body.indexOf(Buffer.from('name="before"'));
  const file = result.body.indexOf(Buffer.from('name="upload"'));
  const last = result.body.indexOf(Buffer.from('name="after"'));
  assert.ok(first < file && file < last);
  assert.ok(result.body.includes(payload));
  assert.equal(result.contentType, `multipart/form-data; boundary=${boundary}`);
  assert.ok(result.body.toString("utf8").endsWith(`--${boundary}--\r\n`));
});

test("notification DWR request keeps the captured route, content type and body field order", () => {
  const actual = buildDwrEwsViewInfoRequest({
    pageUrl: "https://bb.usurt.ru/webapps/portal/execute/tabs/tabAction?tabId=_7_1&tab_tab_group_id=_7_1",
    httpSessionId: "x".repeat(32),
    scriptSessionId: "y".repeat(35),
  });
  const browserRequest = capture.observedRoutes.find(route => route.feature === "activity-notifications" && route.path.endsWith("getEwsViewInfo.dwr"));
  assert.equal(actual.method, browserRequest.method);
  assert.equal(new URL(actual.url).pathname, browserRequest.path);
  assert.equal(actual.contentType, browserRequest.contentType);
  const bodyLines = actual.body.split("\n").filter(Boolean);
  assert.deepEqual(bodyLines.map(line => line.slice(0, line.indexOf("="))), browserRequest.bodyFieldOrder);
  for (const [name, value] of Object.entries(browserRequest.staticBodyFields)) {
    if (name !== "batchId") assert.equal(bodyLines.find(line => line.startsWith(`${name}=`)), `${name}=${value}`);
  }
  assert.equal(Buffer.byteLength(actual.body), browserRequest.bodyBytes);
  assert.equal(actual.body.endsWith("\n"), true);
  assert.match(actual.body, /c0-scriptName=NautilusViewService\nc0-methodName=getEwsViewInfo\nc0-id=0\nc0-param0=null:null\nbatchId=0\n$/);
});

test("DWR replies are parsed as inert JSON-compatible data", () => {
  const value = parseDwrReply(`throw "DWR guard";\n//#DWR-REPLY\ndwr.engine._remoteHandleCallback("0","0",{actionsList:null,count:2,items:[{title:"Task \\"one\\"",read:false}]});`);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { actionsList: null, count: 2, items: [{ title: 'Task "one"', read: false }] });
});

test("page parser reports live links and form fields without hidden values", () => {
  const page = summarizePage(`
    <title>Материалы курса</title>
    <a href="/webapps/blackboard/content/listContent.jsp?content_id=_1_1">Задания</a>
    <form action="/submit" method="post" enctype="application/x-www-form-urlencoded">
      <input type="hidden" name="nonce" value="do-not-expose">
      <input type="text" name="answer">
      <button type="submit" name="submit" value="Save">Отправить</button>
    </form>
  `, "https://bb.usurt.ru/course");
  assert.equal(page.title, "Материалы курса");
  assert.equal(page.links[0].label, "Задания");
  assert.deepEqual(page.forms[0].fields.map(field => field.name), ["nonce", "answer"]);
  assert.equal(JSON.stringify(page).includes("do-not-expose"), false);
});
