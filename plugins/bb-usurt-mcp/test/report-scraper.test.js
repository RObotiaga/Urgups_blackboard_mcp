import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGrade,
  cleanCellText,
  extractAspFields,
  isSessionExpired,
  parseReportHtml,
  formatReportResults,
  getStudentRecordBook,
} from "../src/report-scraper.js";
import { AccountManager } from "../src/account-manager.js";
import { BbUsurtClient } from "../src/blackboard-client.js";

test("parseGrade correctly categorizes exams, passes and debts", () => {
  const g5 = parseGrade("Отлично");
  assert.equal(g5.gradeValue, 5);
  assert.equal(g5.isExam, true);
  assert.equal(g5.passed, true);
  assert.equal(g5.isDebt, false);

  const g4 = parseGrade("хорошо");
  assert.equal(g4.gradeValue, 4);
  assert.equal(g4.isExam, true);
  assert.equal(g4.passed, true);
  assert.equal(g4.isDebt, false);

  const g3 = parseGrade("Удовлетворительно");
  assert.equal(g3.gradeValue, 3);
  assert.equal(g3.isExam, true);
  assert.equal(g3.passed, true);
  assert.equal(g3.isDebt, false);

  const g2 = parseGrade("Неудовлетворительно");
  assert.equal(g2.gradeValue, 2);
  assert.equal(g2.isExam, true);
  assert.equal(g2.passed, false);
  assert.equal(g2.isDebt, true);

  const pass = parseGrade("Зачтено");
  assert.equal(pass.gradeValue, null);
  assert.equal(pass.isExam, false);
  assert.equal(pass.passed, true);
  assert.equal(pass.isDebt, false);

  const fail1 = parseGrade("Незачет");
  assert.equal(fail1.passed, false);
  assert.equal(fail1.isDebt, true);

  const fail2 = parseGrade("Недопуск");
  assert.equal(fail2.passed, false);
  assert.equal(fail2.isDebt, true);

  const fail3 = parseGrade("Не явился");
  assert.equal(fail3.passed, false);
  assert.equal(fail3.isDebt, true);
});

test("extractAspFields and isSessionExpired handle ReportViewer state", () => {
  const sampleHtml = `
    <html>
      <body>
        <input type="hidden" name="__VIEWSTATE" value="vs123" />
        <input type="hidden" name="__VIEWSTATEGENERATOR" value="gen456" />
        <input type="hidden" name="__EVENTVALIDATION" value="ev789" />
        <input type="hidden" name="ReportViewer1$ctl04" value="" />
        <input type="hidden" name="ReportViewer1$ctl06" value="0" />
        <input type="text" name="other" value="ignored" />
      </body>
    </html>
  `;
  const fields = extractAspFields(sampleHtml);
  assert.equal(fields.__VIEWSTATE, "vs123");
  assert.equal(fields.__VIEWSTATEGENERATOR, "gen456");
  assert.equal(fields.__EVENTVALIDATION, "ev789");
  assert.equal(fields["ReportViewer1$ctl04"], "");
  assert.equal(fields["ReportViewer1$ctl06"], "0");
  assert.equal(fields.other, undefined);

  assert.equal(isSessionExpired("Something ASP.NET session has expired here"), true);
  assert.equal(isSessionExpired("Normal page"), false);
});

const MOCK_REPORT_HTML = `
<!DOCTYPE html>
<html>
<body>
  <table>
    <tr><td>2022/2023</td></tr>
    <tr><td>1 курс</td></tr>
    <tr><td>1 семестр</td></tr>
    <tr><td>Дисциплина</td><td>Оценка</td><td>Дата</td></tr>
    <tr>
      <td>Математический анализ</td>
      <td>Отлично</td>
      <td>15.01.2023</td>
    </tr>
    <tr>
      <td>Физика</td>
      <td>Хорошо</td>
      <td>20.01.2023</td>
    </tr>
    <tr>
      <td>История России</td>
      <td>Зачтено</td>
      <td>10.01.2023</td>
    </tr>
    <tr>
      <td>Программирование</td>
      <td>Неудовлетворительно</td>
      <td>25.01.2023</td>
    </tr>
    <tr><td>2 семестр</td></tr>
    <tr>
      <td>Линейная алгебра</td>
      <td>Удовлетворительно</td>
      <td>18.06.2023</td>
    </tr>
    <tr>
      <td>Философия</td>
      <td>Незачет</td>
      <td></td>
    </tr>
  </table>
</body>
</html>
`;

test("parseReportHtml extracts courses, semesters, subjects and marks correctly", () => {
  const subjects = parseReportHtml(MOCK_REPORT_HTML);
  assert.equal(subjects.length, 6);

  assert.equal(subjects[0].subject, "Математический анализ");
  assert.equal(subjects[0].course, "1");
  assert.equal(subjects[0].semester, "1 семестр (2022/2023)");
  assert.equal(subjects[0].grade, "Отлично");
  assert.equal(subjects[0].gradeValue, 5);
  assert.equal(subjects[0].passed, true);
  assert.equal(subjects[0].isDebt, false);
  assert.equal(subjects[0].date, "15.01.2023");

  assert.equal(subjects[3].subject, "Программирование");
  assert.equal(subjects[3].grade, "Неудовлетворительно");
  assert.equal(subjects[3].gradeValue, 2);
  assert.equal(subjects[3].passed, false);
  assert.equal(subjects[3].isDebt, true);

  assert.equal(subjects[5].subject, "Философия");
  assert.equal(subjects[5].course, "1");
  assert.equal(subjects[5].semester, "2 семестр (2022/2023)");
  assert.equal(subjects[5].grade, "Незачет");
  assert.equal(subjects[5].passed, false);
  assert.equal(subjects[5].isDebt, true);
});

test("formatReportResults creates clear Markdown with summary and debts", () => {
  const subjects = parseReportHtml(MOCK_REPORT_HTML);
  const formatted = formatReportResults(subjects);

  assert.ok(formatted.includes("📊 **Сводка успеваемости**"));
  assert.ok(formatted.includes("Всего дисциплин: 6"));
  assert.ok(formatted.includes("Закрыто: 4/6 (66.7%)"));
  assert.ok(formatted.includes("Задолженностей (долгов): 2"));
  assert.ok(formatted.includes("Средний балл по экзаменам:"));
  assert.ok(formatted.includes("❌ **Программирование**"));
  assert.ok(formatted.includes("❌ **Философия**"));
  assert.ok(formatted.includes("✅ **Математический анализ**"));

  const debtsOnly = formatReportResults(subjects, { onlyDebts: true });
  assert.ok(debtsOnly.includes("⚠️ **Список академических задолженностей (2):**"));
  assert.ok(debtsOnly.includes("❌ **Программирование**"));
  assert.ok(debtsOnly.includes("❌ **Философия**"));
  assert.ok(!debtsOnly.includes("✅ **Математический анализ**"));
});

test("getStudentRecordBook fetches, parses and applies filters with mock fetch", async () => {
  const mockFetch = async (url, options = {}) => {
    if (options.method === "POST") {
      const body = options.body;
      if (body.includes("ReportViewer1%24ctl00%24ctl03%24ctl00=99999999") || body.includes("99999999")) {
        return {
          ok: true,
          status: 200,
          async text() { return "<html><body>Зачётная книжка не найдена</body></html>"; },
        };
      }
      return {
        ok: true,
        status: 200,
        async text() { return MOCK_REPORT_HTML; },
      };
    }
    // GET
    return {
      ok: true,
      status: 200,
      headers: { get: () => "ASP.NET_SessionId=test1234; path=/" },
      async text() {
        return `
          <input type="hidden" name="__VIEWSTATE" value="vs_test" />
          <input type="hidden" name="__VIEWSTATEGENERATOR" value="gen_test" />
          <input type="hidden" name="__EVENTVALIDATION" value="ev_test" />
        `;
      },
    };
  };

  // Full record book query
  const res = await getStudentRecordBook("20220001", { fetchFn: mockFetch });
  assert.equal(res.recordBook, "20220001");
  assert.equal(res.summary.totalSubjects, 6);
  assert.equal(res.summary.passedCount, 4);
  assert.equal(res.summary.debtsCount, 2);
  assert.equal(res.debts.length, 2);
  assert.equal(res.subjects.length, 6);
  assert.ok(res.formatted.includes("📊 **Сводка успеваемости**"));

  // Only debts filter
  const debtsRes = await getStudentRecordBook("20220001", { onlyDebts: true, fetchFn: mockFetch });
  assert.equal(debtsRes.summary.totalSubjects, 6);
  assert.equal(debtsRes.summary.debtsCount, 2);
  assert.equal(debtsRes.filteredCount, 2);
  assert.equal(debtsRes.subjects.length, 2);
  assert.equal(debtsRes.subjects[0].subject, "Программирование");
  assert.equal(debtsRes.subjects[1].subject, "Философия");

  // Course and semester filters
  const semRes = await getStudentRecordBook("20220001", { semester: "2 семестр", fetchFn: mockFetch });
  assert.equal(semRes.filteredCount, 2);
  assert.equal(semRes.subjects[0].subject, "Линейная алгебра");
  assert.equal(semRes.subjects[1].subject, "Философия");

  // Non-existent record book error
  await assert.rejects(
    async () => getStudentRecordBook("99999999", { fetchFn: mockFetch }),
    /не найдена в системе УрГУПС/
  );
});

test("AccountManager resolves recordBook from accounts and environment", () => {
  const env = {
    BB_ACCOUNT_STUDENT1_USERNAME: "stud1",
    BB_ACCOUNT_STUDENT1_PASSWORD: "pass1",
    BB_ACCOUNT_STUDENT1_RECORD_BOOK: "20220111",
    BB_ACCOUNT_STUDENT2_USERNAME: "20220222", // numeric username inferred as recordBook
    BB_ACCOUNT_STUDENT2_PASSWORD: "pass2",
    BB_USURT_DEFAULT_ACCOUNT: "student1",
  };

  const manager = AccountManager.fromConfig({ env });
  assert.equal(manager.getRecordBook("student1"), "20220111");
  assert.equal(manager.getRecordBook("student2"), "20220222");
  assert.equal(manager.getRecordBook(), "20220111"); // active account

  manager.close();
});

test("BbUsurtClient getReportGrades integrates with recordBook", async () => {
  const mockFetch = async (url, options = {}) => {
    if (options.method === "POST") {
      return { ok: true, status: 200, async text() { return MOCK_REPORT_HTML; } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "ASP.NET_SessionId=test1234; path=/" },
      async text() {
        return `
          <input type="hidden" name="__VIEWSTATE" value="vs_test" />
          <input type="hidden" name="__VIEWSTATEGENERATOR" value="gen_test" />
          <input type="hidden" name="__EVENTVALIDATION" value="ev_test" />
        `;
      },
    };
  };

  const client = new BbUsurtClient({ username: "20220001" });
  assert.equal(client.recordBook, "20220001");

  const result = await client.getReportGrades({ fetchFn: mockFetch });
  assert.equal(result.recordBook, "20220001");
  assert.equal(result.summary.debtsCount, 2);
  assert.equal(result.subjects.length, 6);

  // Client without recordBook throws descriptive error if none provided
  const emptyClient = new BbUsurtClient({ username: "custom_user" });
  await assert.rejects(
    async () => emptyClient.getReportGrades({ fetchFn: mockFetch }),
    /Укажите номер зачётной книжки/
  );
});
