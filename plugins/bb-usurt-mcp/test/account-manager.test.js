import assert from "node:assert/strict";
import test from "node:test";
import { AccountManager, matchAssignments, normalizeCourse, normalizeTitle } from "../src/account-manager.js";
import { BbUsurtClient } from "../src/blackboard-client.js";

function mockTransport(routes = new Map()) {
  const calls = [];
  return {
    calls,
    headersForRequest(headers) { return headers; },
    cookieValue() { return "session-cookie"; },
    cookieValueFor() { return "session-cookie"; },
    async request(url, options = {}) {
      calls.push({ url, ...options });
      const route = routes.get(url);
      if (!route) return { status: 200, ok: true, url, protocol: "h1", headers: { get: () => "text/html" }, async text() { return ""; } };
      return { status: route.status || 200, ok: (route.status || 200) < 400, url: route.url || url, protocol: "h1", headers: { get: () => "text/html" }, async text() { return route.body; } };
    },
    close() {},
  };
}

test("AccountManager initializes from environment variables with multiple accounts", () => {
  const env = {
    BB_ACCOUNT_STUDENT1_USERNAME: "stud1",
    BB_ACCOUNT_STUDENT1_PASSWORD: "pass1",
    BB_ACCOUNT_STUDENT2_USERNAME: "stud2",
    BB_ACCOUNT_STUDENT2_PASSWORD: "pass2",
    BB_USURT_DEFAULT_ACCOUNT: "student1",
  };

  const manager = AccountManager.fromConfig({ env, transportFactory: () => mockTransport() });
  assert.equal(manager.size, 2);
  assert.equal(manager.getActiveAccount().id, "student1");
  assert.equal(manager.getActiveAccount().username, "stud1");

  const summary = manager.listAccountsSummary();
  assert.equal(summary.totalAccounts, 2);
  assert.equal(summary.activeAccount, "student1");

  const acc1 = summary.accounts.find(a => a.id === "student1");
  const acc2 = summary.accounts.find(a => a.id === "student2");
  assert.equal(acc1.isActive, true);
  assert.equal(acc2.isActive, false);
  assert.equal(acc2.username, "stud2");

  manager.close();
});

test("AccountManager supports switching active account and retrieves correct client", () => {
  const manager = new AccountManager({
    accounts: [
      { id: "userA", username: "loginA", password: "pA" },
      { id: "userB", username: "loginB", password: "pB" },
    ],
    transportFactory: () => mockTransport(),
  });

  assert.equal(manager.getActiveAccount().id, "userA");
  assert.equal(manager.getClient().username, "loginA");

  manager.setActiveAccount("userB");
  assert.equal(manager.getActiveAccount().id, "userB");
  assert.equal(manager.getClient().username, "loginB");

  assert.equal(manager.getClient("userA").username, "loginA");
  assert.equal(manager.getClient("loginA").username, "loginA");

  assert.throws(() => manager.setActiveAccount("nonexistent"), /не найден/);
  assert.throws(() => manager.getClient("unknown"), /не найден/);

  manager.close();
});

test("AccountManager falls back to legacy BB_USURT_USERNAME and BB_USURT_PASSWORD as default account", () => {
  const env = {
    BB_USURT_USERNAME: "legacy_user",
    BB_USURT_PASSWORD: "legacy_password",
  };

  const manager = AccountManager.fromConfig({ env, transportFactory: () => mockTransport() });
  assert.equal(manager.size, 1);
  assert.equal(manager.getActiveAccount().id, "default");
  assert.equal(manager.getActiveAccount().username, "legacy_user");
  assert.equal(manager.getClient().username, "legacy_user");

  manager.close();
});

test("normalizeTitle and normalizeCourse normalize strings correctly", () => {
  assert.equal(normalizeTitle('Лабораторная работа №1: "Алгоритмы"'), "лабораторная работа 1: алгоритмы");
  assert.equal(normalizeCourse("2026_1000001: 2026_Сетевые технологии"), "2026 сетевые технологии");
});

test("matchAssignments matches pairs by content_id or title and identifies unmatched items", () => {
  const list1 = [
    { title: "ЛР 1", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_t1&course_id=_c1", submissionStatus: "submitted" },
    { title: "ЛР 2", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_t2&course_id=_c1", submissionStatus: "submitted" },
    { title: "ЛР 3", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_t3&course_id=_c1", submissionStatus: "not-submitted" },
    { title: "Курсовая работа", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_coursework&course_id=_c1", submissionStatus: "submitted" },
  ];

  const list2 = [
    { title: "ЛР 1", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_t1&course_id=_c1", submissionStatus: "submitted" },
    { title: "ЛР 2", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_t2&course_id=_c1", submissionStatus: "not-submitted" },
    { title: "ЛР 3", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_t3&course_id=_c1", submissionStatus: "not-submitted" },
    { title: "Дополнительное задание", course: "Физика", courseId: "_c1", href: "https://bb.usurt.ru/upload?content_id=_extra&course_id=_c1", submissionStatus: "not-submitted" },
  ];

  const { matchedPairs, unmatched1, unmatched2 } = matchAssignments(list1, list2);
  assert.equal(matchedPairs.length, 3);
  assert.equal(unmatched1.length, 1);
  assert.equal(unmatched1[0].title, "Курсовая работа");
  assert.equal(unmatched2.length, 1);
  assert.equal(unmatched2[0].title, "Дополнительное задание");
});

test("compareSubmissions correctly reports assignments submitted by user1 but not submitted by user2", async () => {
  const manager = new AccountManager({
    transportFactory: () => mockTransport(),
  });

  const client1 = new BbUsurtClient({ username: "user1", password: "p1", transport: mockTransport() });
  client1.authenticated = true;
  client1.listAssignments = async () => ({
    warnings: [],
    assignments: [
      {
        course: "Математика",
        courseId: "_math",
        title: "ДЗ 1",
        href: "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_hw1&course_id=_math",
        dueDate: "2026-10-01",
        dueDateLabel: "1 октября 2026 г.",
        submissionStatus: "submitted",
        canSubmit: false,
      },
      {
        course: "Математика",
        courseId: "_math",
        title: "ДЗ 2",
        href: "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_hw2&course_id=_math",
        dueDate: "2026-10-15",
        dueDateLabel: "15 октября 2026 г.",
        submissionStatus: "submitted",
        canSubmit: false,
      },
      {
        course: "Математика",
        courseId: "_math",
        title: "ДЗ 3",
        href: "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_hw3&course_id=_math",
        dueDate: "2026-11-01",
        dueDateLabel: "1 ноября 2026 г.",
        submissionStatus: "not-submitted",
        canSubmit: true,
      },
    ],
  });

  const client2 = new BbUsurtClient({ username: "user2", password: "p2", transport: mockTransport() });
  client2.authenticated = true;
  client2.listAssignments = async () => ({
    warnings: [],
    assignments: [
      {
        course: "Математика",
        courseId: "_math",
        title: "ДЗ 1",
        href: "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_hw1&course_id=_math",
        dueDate: "2026-10-01",
        dueDateLabel: "1 октября 2026 г.",
        submissionStatus: "submitted",
        canSubmit: false,
      },
      {
        course: "Математика",
        courseId: "_math",
        title: "ДЗ 2",
        href: "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_hw2&course_id=_math",
        dueDate: "2026-10-15",
        dueDateLabel: "15 октября 2026 г.",
        submissionStatus: "not-submitted",
        canSubmit: true,
      },
      {
        course: "Математика",
        courseId: "_math",
        title: "ДЗ 3",
        href: "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_hw3&course_id=_math",
        dueDate: "2026-11-01",
        dueDateLabel: "1 ноября 2026 г.",
        submissionStatus: "not-submitted",
        canSubmit: true,
      },
    ],
  });

  manager.addAccount({ id: "alice", username: "user1", client: client1 });
  manager.addAccount({ id: "bob", username: "user2", client: client2 });

  const result = await manager.compareSubmissions({ account1: "alice", account2: "bob" });

  assert.equal(result.account1.submittedCount, 2);
  assert.equal(result.account2.submittedCount, 1);
  assert.equal(result.needsSubmissionByAccount2.length, 1);
  assert.equal(result.needsSubmissionByAccount2[0].title, "ДЗ 2");
  assert.equal(result.needsSubmissionByAccount2[0].account1Status, "submitted");
  assert.equal(result.needsSubmissionByAccount2[0].account2Status, "not-submitted");
  assert.equal(result.needsSubmissionByAccount2[0].account2CanSubmit, true);
  assert.equal(result.needsSubmissionByAccount2[0].account2Href, "https://bb.usurt.ru/webapps/assignment/uploadAssignment?content_id=_hw2&course_id=_math");

  assert.equal(result.bothSubmitted.length, 1);
  assert.equal(result.bothSubmitted[0].title, "ДЗ 1");

  assert.equal(result.neitherSubmitted.length, 1);
  assert.equal(result.neitherSubmitted[0].title, "ДЗ 3");

  assert.equal(result.needsSubmissionByAccount1.length, 0);
  assert.match(result.summary, /Найдено 1 заданий, отправленных у "alice", но НЕ отправленных у "bob"/);

  manager.close();
});
