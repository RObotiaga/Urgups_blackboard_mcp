export const REPORT_USURT_URL = "https://report.usurt.ru/uspev.aspx";

export const GRADE_KEYWORDS = [
  "отлично",
  "хорошо",
  "удовлетворительно",
  "неудовлетворительно",
  "зачтено",
  "незачет",
  "недопуск",
  "не явился",
];

export const SESSION_EXPIRED_MARKERS = [
  "asp.net session has expired",
  "сессия asp.net истекла",
];

/**
 * Парсит текстовое значение оценки в структурированные поля.
 * Совместимо с логикой rating_scraper.py из bb_schedule.
 */
export function parseGrade(gradeText = "") {
  const gradeLower = String(gradeText).trim().toLowerCase();
  let gradeValue = null;
  let isExam = false;
  let passed = true;

  if (gradeLower.includes("отлично")) {
    gradeValue = 5;
    isExam = true;
  } else if (gradeLower.includes("хорошо")) {
    gradeValue = 4;
    isExam = true;
  } else if (
    gradeLower.includes("удовлетворительно") &&
    !gradeLower.split("удовлетворительно")[0].endsWith("не")
  ) {
    gradeValue = 3;
    isExam = true;
  } else if (gradeLower.includes("неудовлетворительно")) {
    gradeValue = 2;
    isExam = true;
    passed = false;
  } else if (
    gradeLower.includes("незачет") ||
    gradeLower.includes("недопуск") ||
    gradeLower.includes("не явился")
  ) {
    passed = false;
  }

  return { gradeValue, isExam, passed, isDebt: !passed };
}

export function cleanCellText(text = "") {
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Извлекает скрытые поля ASP.NET и ReportViewer из HTML страницы.
 */
export function extractAspFields(html = "") {
  const fields = {};
  const re = /<input\b([^>]*)>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[1];
    const nameMatch = tag.match(/name=["']([^"']+)["']/i);
    const valMatch = tag.match(/value=["']([^"']*)["']/i);
    const typeMatch = tag.match(/type=["']([^"']+)["']/i);

    if (nameMatch) {
      const name = nameMatch[1];
      const type = typeMatch ? typeMatch[1].toLowerCase() : "";
      const value = valMatch ? valMatch[1] : "";

      if (
        type === "hidden" ||
        name === "__VIEWSTATE" ||
        name === "__VIEWSTATEGENERATOR" ||
        name === "__EVENTVALIDATION" ||
        name === "__EVENTTARGET" ||
        name === "__EVENTARGUMENT" ||
        name.startsWith("ReportViewer1")
      ) {
        fields[name] = value;
      }
    }
  }

  return fields;
}

export function isSessionExpired(html = "") {
  const lower = html.toLowerCase();
  return SESSION_EXPIRED_MARKERS.some(marker => lower.includes(marker));
}

/**
 * Парсит HTML таблицы ReportViewer в структурированный список предметов и оценок.
 * Совместимо с форматом _parse_html_results() из rating_scraper.py в bb_schedule.
 */
export function parseReportHtml(html = "") {
  const rowMatches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  const results = [];

  let currentYear = "";
  let currentCourse = "";
  let currentSemesterNum = "";
  let justSeenYear = false;
  let justSeenCourse = false;

  for (const rowMatch of rowMatches) {
    const cellMatches = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)];
    const cellTexts = cellMatches.map(c => cleanCellText(c[1]));
    const nonEmpty = cellTexts.filter(Boolean);

    if (!nonEmpty.length) continue;

    // Заголовки семестра/года/курса в строках из одной непустой ячейки
    if (nonEmpty.length === 1) {
      const text = nonEmpty[0];

      if (/^\d{4}\/\d{4}$/.test(text)) {
        currentYear = text;
        justSeenYear = true;
        justSeenCourse = false;
        continue;
      }

      if (/^\d+$/.test(text) || text.toLowerCase().includes("семестр") || text.toLowerCase().includes("курс")) {
        if (justSeenYear) {
          currentCourse = text.replace(/\s*курс/i, "").trim();
          justSeenYear = false;
          justSeenCourse = true;
          continue;
        } else if (justSeenCourse) {
          currentSemesterNum = text.replace(/\s*семестр/i, "").trim();
          justSeenCourse = false;
          continue;
        } else {
          currentSemesterNum = text.replace(/\s*семестр/i, "").trim();
          continue;
        }
      }
    }

    // Поиск ключевых слов оценок
    let gradeIndex = -1;
    let gradeText = "";
    for (let idx = 0; idx < cellTexts.length; idx++) {
      const cell = cellTexts[idx];
      if (GRADE_KEYWORDS.some(kw => cell.toLowerCase().includes(kw))) {
        gradeIndex = idx;
        gradeText = cell;
        break;
      }
    }

    if (gradeIndex === -1) continue;

    // Парсинг предмета: может быть "Предмет (Оценка)" или предмет в ячейках до оценки
    const kwPattern = GRADE_KEYWORDS.join("|");
    const regex = new RegExp(`(.+)\\s+\\((${kwPattern})\\)\\s*$`, "i");
    const match = regex.exec(gradeText);

    let subject = "";
    let grade = "";
    if (match) {
      subject = match[1].trim();
      grade = match[2].trim();
    } else {
      subject = cellTexts.slice(0, gradeIndex).filter(Boolean).join(" ");
      grade = gradeText;
    }

    if (subject.includes("Дисциплина") || !subject.trim()) continue;

    // Дата — ячейка сразу после оценки
    const dateVal = gradeIndex < cellTexts.length - 1 ? cellTexts[gradeIndex + 1] : "";
    const parsed = parseGrade(grade);
    const semStr = /^\d+$/.test(currentSemesterNum) ? `${currentSemesterNum} семестр` : currentSemesterNum;
    const semesterLabel = currentYear ? `${semStr} (${currentYear})` : semStr;

    results.push({
      course: currentCourse,
      semester: semesterLabel,
      subject,
      grade,
      date: dateVal,
      gradeValue: parsed.gradeValue,
      isExam: parsed.isExam,
      passed: parsed.passed,
      isDebt: parsed.isDebt,
    });
  }

  return results;
}

/**
 * Форматирует сводку результатов в человекочитаемый Markdown (по аналогии с formatter.py в bb_schedule).
 */
export function formatReportResults(allData = [], { onlyDebts = false, filteredData = null } = {}) {
  if (!allData.length) return "Результаты не найдены.";

  const displayData = filteredData ?? (onlyDebts ? allData.filter(d => !d.passed) : allData);
  if (!displayData.length) {
    return onlyDebts
      ? "🎉 Академических задолженностей нет! Все дисциплины успешно сданы."
      : "Результаты не найдены.";
  }

  const allTotal = allData.length;
  const allPassed = allData.filter(d => d.passed).length;
  const allDebts = allData.filter(d => !d.passed).length;
  const passRate = allTotal > 0 ? ((allPassed / allTotal) * 100).toFixed(1) : "0.0";

  const examGrades = allData.filter(d => d.gradeValue !== null).map(d => d.gradeValue);
  const avgGrade = examGrades.length > 0
    ? (examGrades.reduce((sum, g) => sum + g, 0) / examGrades.length).toFixed(2)
    : null;

  const lines = [];
  lines.push("📊 **Сводка успеваемости**");
  lines.push(`Всего дисциплин: ${allTotal}`);
  lines.push(`Закрыто: ${allPassed}/${allTotal} (${passRate}%)`);
  lines.push(`Задолженностей (долгов): ${allDebts}`);
  if (avgGrade) {
    lines.push(`Средний балл по экзаменам: ${avgGrade}`);
  }
  lines.push("");

  if (onlyDebts) {
    lines.push(`⚠️ **Список академических задолженностей (${displayData.length}):**`);
  }

  // Группировка по курсам и семестрам
  const courses = {};
  for (const item of displayData) {
    const courseKey = item.course ? `${item.course} курс` : "Курс не указан";
    const semKey = item.semester || "Семестр не указан";

    if (!courses[courseKey]) courses[courseKey] = {};
    if (!courses[courseKey][semKey]) courses[courseKey][semKey] = [];
    courses[courseKey][semKey].push(item);
  }

  const sortedCourseKeys = Object.keys(courses).sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)?.[0] || "999", 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || "999", 10);
    return numA - numB;
  });

  for (const cKey of sortedCourseKeys) {
    lines.push(`\n🎓 **${cKey}**`);
    const sems = courses[cKey];
    for (const [sKey, items] of Object.entries(sems)) {
      lines.push(`📅 *${sKey}*`);
      for (const item of items) {
        const icon = item.passed ? "✅" : "❌";
        const dateSuffix = item.date ? ` (${item.date})` : "";
        lines.push(`${icon} **${item.subject}**`);
        lines.push(`   🔹 ${item.grade}${dateSuffix}`);
      }
    }
  }

  return lines.join("\n");
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Выполняет сетевой запрос к https://report.usurt.ru/uspev.aspx и получает HTML отчёта.
 */
export async function fetchReportHtml(recordBookNumber, { fetchFn = fetch, userAgent = DEFAULT_USER_AGENT } = {}) {
  const recordBook = String(recordBookNumber).trim();
  if (!recordBook) throw new Error("Номер зачётной книжки не может быть пустым.");

  const headers = {
    "User-Agent": userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8",
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    // 1. GET-запрос для получения ASP.NET токенов и сессии
    const getResp = await fetchFn(REPORT_USURT_URL, { headers });
    if (!getResp.ok) {
      throw new Error(`Ошибка загрузки страницы ведомостей УрГУПС: HTTP ${getResp.status}`);
    }

    const setCookie = getResp.headers.get("set-cookie");
    const getHtml = await getResp.text();

    const aspFields = extractAspFields(getHtml);
    if (!aspFields.__VIEWSTATE) {
      throw new Error("Не удалось получить токены формы ASP.NET (__VIEWSTATE) с report.usurt.ru.");
    }

    // 2. POST-запрос с номером зачётки
    const postData = new URLSearchParams();
    for (const [key, val] of Object.entries(aspFields)) {
      postData.set(key, val);
    }
    postData.set("ReportViewer1$ctl00$ctl03$ctl00", recordBook);
    postData.set("ReportViewer1$ctl00$ctl00", "Просмотр");

    const postHeaders = {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://report.usurt.ru",
      "Referer": REPORT_USURT_URL,
    };
    if (setCookie) {
      postHeaders["Cookie"] = setCookie.split(";")[0];
    }

    const postResp = await fetchFn(REPORT_USURT_URL, {
      method: "POST",
      headers: postHeaders,
      body: postData.toString(),
    });

    if (!postResp.ok) {
      throw new Error(`Ошибка отправки запроса зачётки: HTTP ${postResp.status}`);
    }

    const postHtml = await postResp.text();

    if (isSessionExpired(postHtml)) {
      continue;
    }

    return postHtml;
  }

  throw new Error("Сессия ASP.NET истекла при повторной попытке запроса к report.usurt.ru.");
}

/**
 * Получает результаты успеваемости и задолженностей студента по номеру зачётки.
 */
export async function getStudentRecordBook(
  recordBookNumber,
  { onlyDebts = false, course = null, semester = null, fetchFn = fetch, userAgent = DEFAULT_USER_AGENT } = {}
) {
  const recordBook = String(recordBookNumber).trim();
  const html = await fetchReportHtml(recordBook, { fetchFn, userAgent });

  const htmlLower = html.toLowerCase();
  if (htmlLower.includes("не найден") || (!html.includes("Дисциплина") && html.includes("Error"))) {
    throw new Error(`Зачётная книжка "${recordBook}" не найдена в системе УрГУПС.`);
  }

  const allSubjects = parseReportHtml(html);
  if (!allSubjects.length) {
    if (!html.includes("Дисциплина")) {
      throw new Error(`Для зачётной книжки "${recordBook}" данные об успеваемости отсутствуют или не найдены.`);
    }
  }

  // Общая сводка (по всем дисциплинам)
  const allTotal = allSubjects.length;
  const passedItems = allSubjects.filter(s => s.passed);
  const debts = allSubjects.filter(s => !s.passed);
  const passRate = allTotal > 0 ? ((passedItems.length / allTotal) * 100).toFixed(1) : "0.0";

  const examGrades = allSubjects.filter(s => s.gradeValue !== null).map(s => s.gradeValue);
  const averageGrade = examGrades.length > 0
    ? Number((examGrades.reduce((sum, g) => sum + g, 0) / examGrades.length).toFixed(2))
    : null;

  // Фильтрация
  let filteredSubjects = allSubjects;

  if (onlyDebts) {
    filteredSubjects = filteredSubjects.filter(s => !s.passed);
  }

  if (course) {
    const cStr = String(course).trim().replace(/\s*курс/i, "");
    filteredSubjects = filteredSubjects.filter(s => s.course === cStr);
  }

  if (semester) {
    const sStr = String(semester).trim().toLowerCase();
    filteredSubjects = filteredSubjects.filter(s => s.semester.toLowerCase().includes(sStr));
  }

  const formatted = formatReportResults(allSubjects, {
    onlyDebts,
    filteredData: filteredSubjects,
  });

  return {
    recordBook,
    sourceUrl: REPORT_USURT_URL,
    summary: {
      totalSubjects: allTotal,
      passedCount: passedItems.length,
      debtsCount: debts.length,
      passRate: `${passRate}%`,
      averageGrade,
      examsCount: examGrades.length,
    },
    debts,
    subjects: filteredSubjects,
    filteredCount: filteredSubjects.length,
    formatted,
  };
}
