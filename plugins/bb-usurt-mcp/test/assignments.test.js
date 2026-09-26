import assert from "node:assert/strict";
import test from "node:test";
import { BbUsurtClient } from "../src/blackboard-client.js";

function mockTransport(routes) {
  const calls = [];
  return {
    calls,
    headersForRequest(headers) { return headers; },
    cookieValue() { return "session-cookie"; },
    cookieValueFor() { return "session-cookie"; },
    async request(url, options = {}) {
      calls.push({ url, ...options });
      const route = routes.get(url);
      if (!route) throw new Error("Unexpected request: " + url);
      return { status: route.status || 200, ok: (route.status || 200) < 400, url: route.url || url, protocol: "h1", headers: { get: () => "application/xml" }, async text() { return route.body; } };
    },
    close() {},
  };
}

function clientFor(transport) {
  const client = new BbUsurtClient({ username: "test-user", password: "test-password", downloadDir: "/tmp/bb-test-downloads", transport });
  client.authenticated = true;
  return client;
}

const portalUrl = "https://bb.usurt.ru/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";
const coursesUrl = "https://bb.usurt.ru/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_2_1";
const ajaxUrl = "https://bb.usurt.ru/webapps/portal/execute/tabs/tabAction";
const moduleBody = "action=refreshAjaxModule&modId=_22_1&tabId=_2_1&tab_tab_group_id=_2_1";
const portalHtml = '<a href="' + coursesUrl + '">Курсы Вкладка 2 из 5</a>';
const moduleHtml = '<div class="portlet" id="module:_22_1"><!-- extid:learning/coursetab-courses: --><script>new Ajax.Request("/webapps/portal/execute/tabs/tabAction",{method:"post",parameters:\'action\\x3DrefreshAjaxModule\\x26modId\\x3D_22_1\\x26tabId\\x3D_2_1\\x26tab_tab_group_id\\x3D_2_1\'});</script></div>';
const coursesXml = '<root><contents><![CDATA[<a href="/webapps/blackboard/execute/launcher?type=Course&amp;id=_course_1&amp;url=">2026_1000001: 2026_Курс для проверки</a>]]></contents></root>';

test("bb_courses loads the live AJAX module request from the Courses tab", async () => {
  const routes = new Map([
    [portalUrl, { body: portalHtml }],
    [coursesUrl, { body: moduleHtml }],
    [ajaxUrl, { body: coursesXml }],
  ]);
  const transport = mockTransport(routes);
  const client = clientFor(transport);
  const result = await client.listCourses();
  assert.equal(result.courses.length, 1);
  assert.equal(result.courses[0].courseId, "_course_1");
  assert.equal(transport.calls[2].method, "POST");
  assert.equal(transport.calls[2].body, moduleBody);
  assert.equal(transport.calls[2].headers["X-Requested-With"], "XMLHttpRequest");
  assert.equal(transport.calls[2].headers["X-Prototype-Version"], "1.7");
  assert.equal(transport.calls[2].headers.Origin, "https://bb.usurt.ru");
  assert.equal(transport.calls[2].headers["Content-type"], "application/x-www-form-urlencoded; charset=UTF-8");
  client.close();
});

test("course lists are reused briefly and can be refreshed on demand", async () => {
  const routes = new Map([
    [portalUrl, { body: portalHtml }],
    [coursesUrl, { body: moduleHtml }],
    [ajaxUrl, { body: coursesXml }],
  ]);
  const transport = mockTransport(routes);
  const client = clientFor(transport);
  const first = await client.listCourses();
  const callsAfterFirst = transport.calls.length;
  const second = await client.listCourses();
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.requestCount, 0);
  assert.equal(transport.calls.length, callsAfterFirst);
  const refreshed = await client.listCourses({ refresh: true });
  assert.equal(refreshed.cacheHit, false);
  assert.equal(transport.calls.length, callsAfterFirst + 3);
  client.close();
});

test("content index follows only content folders and reuses one scan across filters", async () => {
  const courseHref = "https://bb.usurt.ru/webapps/blackboard/execute/launcher?type=Course&id=_course_1&url=";
  const toolHref = "https://bb.usurt.ru/webapps/blackboard/content/launchLink.jsp?course_id=_course_1&toc_id=_tool_1";
  const folderHref = "https://bb.usurt.ru/webapps/blackboard/content/listContent.jsp?course_id=_course_1&content_id=_folder_1";
  const fileHref = "https://bb.usurt.ru/bbcswebdav/pid-_course_1-dt-content-rid-_file_1_1/xid-_file_1_1";
  const routes = new Map([
    [portalUrl, { body: portalHtml }],
    [coursesUrl, { body: moduleHtml }],
    [ajaxUrl, { body: coursesXml }],
    [courseHref, { url: "https://bb.usurt.ru/webapps/blackboard/execute/modulepage/view?course_id=_course_1", body: `<a href="${toolHref}">Оценки</a><a href="${folderHref}">Материалы</a>` }],
    [folderHref, { body: `<a href="${fileHref}">Расписание.pdf</a>` }],
  ]);
  const transport = mockTransport(routes);
  const client = clientFor(transport);
  const all = await client.scanCourseContent({ courseHref, maxFoldersPerCourse: 5 });
  assert.equal(all.items.some(item => item.href === folderHref), true);
  assert.equal(all.pagesRead, 2);
  assert.equal(all.requestCount, 5);
  assert.equal(transport.calls.some(call => call.url === toolHref), false);
  const files = await client.scanCourseContent({ courseHref, kind: "file", maxFoldersPerCourse: 5 });
  assert.equal(files.items.length, 1);
  assert.equal(files.indexCacheHit, true);
  assert.equal(files.requestCount, 0);
  assert.equal(transport.calls.length, 5);
  client.close();
});

test("assignment submission preview asks which native submit button to activate", async () => {
  const assignmentHref = "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_task_1&course_id=_course_1&group_id=&mode=view";
  const assignmentHtml = '<title>Практическое задание</title><form action="/webapps/assignment/uploadAssignment" method="post"><input type="hidden" name="nonce" value="private-token"><textarea name="comment"></textarea><button type="submit" name="saveDraft" value="draft">Черновик</button><button type="submit" name="submitAssignment" value="submit">Отправить</button></form>';
  const routes = new Map([
    [portalUrl, { body: portalHtml }],
    [coursesUrl, { body: moduleHtml }],
    [ajaxUrl, { body: coursesXml }],
    [assignmentHref, { body: assignmentHtml }],
  ]);
  const transport = mockTransport(routes);
  const client = clientFor(transport);
  const result = await client.submitAssignment({ href: assignmentHref });
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.selectionRequired, "submitterName");
  assert.deepEqual(result.submitters.map(button => button.name), ["saveDraft", "submitAssignment"]);
  assert.equal(transport.calls.filter(call => call.method === "POST").length, 1); // course list AJAX only; no assignment form was posted
  assert.equal(JSON.stringify(result).includes("private-token"), false);
  client.close();
});

test("assignment listing sorts dated assignments first and omits submitted work by default", async () => {
  const courseHref = "https://bb.usurt.ru/webapps/blackboard/execute/launcher?type=Course&id=_course_1&url=";
  const coursePage = "https://bb.usurt.ru/webapps/blackboard/execute/modulepage/view?course_id=_course_1";
  const folderHref = "https://bb.usurt.ru/webapps/blackboard/content/listContent.jsp?course_id=_course_1&content_id=_folder_1";
  const openHref = "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_open_1&course_id=_course_1&group_id=&mode=view";
  const submittedHref = "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_sent_1&course_id=_course_1&group_id=&mode=view";
  const folderHtml = '<a href="' + folderHref + '">Контроль знаний</a>';
  const contentHtml = '<a href="' + openHref + '">Сроковое задание</a><a href="' + submittedHref + '">Уже отправлено</a>';
  const openPage = '<title>Отправить задание: Сроковое задание</title><p>Дата выполнения 5 октября 2026 г. 23:59</p><form action="/webapps/assignment/uploadAssignment" method="post"><button type="submit" name="submit">Сохранить</button></form>';
  const submittedPage = '<title>Просмотреть историю отправки: Уже отправлено</title><p>Последняя оцененная попытка</p>';
  const routes = new Map([
    [portalUrl, { body: portalHtml }],
    [coursesUrl, { body: moduleHtml }],
    [ajaxUrl, { body: coursesXml }],
    [courseHref, { url: coursePage, body: folderHtml }],
    [folderHref, { body: folderHtml + contentHtml }],
    [openHref, { body: openPage }],
    [submittedHref, { body: submittedPage }],
  ]);
  const transport = mockTransport(routes);
  const client = clientFor(transport);
  const result = await client.listAssignments({ courseYear: "2026" });
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].title, "Сроковое задание");
  assert.equal(result.assignments[0].dueDate, "2026-10-05T23:59");
  assert.equal(result.assignments[0].canSubmit, true);
  assert.equal(result.foldersRead, 1);
  client.close();
});

test("generic page reads cannot launch Blackboard assessment attempts", async () => {
  const transport = mockTransport(new Map());
  const client = clientFor(transport);
  await assert.rejects(
    client.getPage("https://bb.usurt.ru/webapps/blackboard/content/launchAssessment.jsp?course_id=_course_1&content_id=_test_1&mode=view"),
    /dedicated tool with confirmed=true/,
  );
  assert.equal(transport.calls.length, 0);
  client.close();
});

test("notification reads use the dashboard DWR call without the global-navigation activity call", async () => {
  const dashboardUrl = "https://bb.usurt.ru/webapps/portal/execute/tabs/tabAction?tabId=_7_1&tab_tab_group_id=_7_1";
  const portalWithDashboard = '<a href="' + dashboardUrl + '">Панель мониторинга уведомлений</a>';
  const dashboardHtml = '<script src="/javascript/dwr/engine.js"></script><script src="/webapps/portal/dwr_open/interface/NautilusViewService.js"></script>';
  const engineJs = 'dwr.engine._origScriptSessionId="original-session";dwr.engine._sessionCookieName="JSESSIONID";';
  const dwrReply = '//#DWR-REPLY\ndwr.engine._remoteHandleCallback("0","0",{count:0});';
  const routes = new Map([
    [portalUrl, { body: portalWithDashboard }],
    [dashboardUrl, { body: dashboardHtml }],
    ["https://bb.usurt.ru/javascript/dwr/engine.js", { body: engineJs }],
    ["https://bb.usurt.ru/webapps/portal/dwr_open/call/plaincall/NautilusViewService.getEwsViewInfo.dwr", { body: dwrReply }],
  ]);
  const transport = mockTransport(routes);
  const client = clientFor(transport);
  const result = await client.readNotifications();
  const dwrCalls = transport.calls.filter(call => call.url.includes(".dwr"));
  assert.equal(result.status, 200);
  assert.equal(dwrCalls.length, 1);
  assert.match(dwrCalls[0].url, /NautilusViewService\.getEwsViewInfo\.dwr$/);
  assert.equal(dwrCalls[0].headers.Accept, "*/*");
  assert.equal(dwrCalls[0].headers.Origin, "https://bb.usurt.ru");
  assert.equal(dwrCalls[0].headers.Referer, dashboardUrl);
  assert.equal(dwrCalls[0].headers["Content-Type"], "text/plain");
  client.close();
});
