import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BbUsurtClient, parseBlackboardLinks } from "./blackboard-client.js";
import { BB_ORIGIN } from "./protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const envFile = path.join(root, "config", ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const client = new BbUsurtClient({ downloadDir: process.env.BB_USURT_DOWNLOAD_DIR || path.join(root, "downloads") });
const pages = new Map();
const pageTtlMs = 20 * 60 * 1000;
const serverInfo = { name: "bb-usurt", version: "0.1.0" };
const modernVersion = "2026-07-28";
const legacyVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

const toolDefinitions = [
  {
    name: "bb_login",
    description: "Открывает штатную форму входа Blackboard и создаёт HTTP-сессию из BB_USURT_USERNAME и BB_USURT_PASSWORD. Секреты не принимаются аргументами MCP и не сохраняются в файлах проекта.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_status",
    description: "Показывает состояние HTTP-сессии Blackboard и последнюю безопасную сводку запроса.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_courses",
    description: "Список текущих курсов из вкладки «Курсы». Результат кэшируется на 90 секунд; передай refresh=true, если нужно перечитать вкладку сейчас.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean", default: false } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_search_courses",
    description: "Ищет курсы в каталоге по тексту в названии или данных преподавателя и возвращает название, инструктора и наличие действия «Зачислить». Вызывай по отдельному запросу пользователя искать новые курсы. Метод, URL, кодировка, порядок полей и тело сверяются с живой формой.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_open_course",
    description: "Открывает зачисленный курс по точной ссылке href из bb_courses и возвращает ссылки его разделов.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_open_page",
    description: "Читает страницу Blackboard по ссылке с того же сайта. Возвращает текст, формы и ссылки с типами course-content, assignment, test, file, activity. Зачисление и запуск теста требуют специальных инструментов.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_list_assignments",
    description: "Собирает задания из разделов текущих курсов, открывает их страницы только для чтения и возвращает срок и статус отправки. По умолчанию показывает задания, для которых портал показывает форму отправки. courseYear фильтрует названия курсов, например 2026.",
    inputSchema: {
      type: "object",
      properties: {
        courseYear: { type: "string", minLength: 1 },
        courseHref: { type: "string", format: "uri" },
        availableOnly: { type: "boolean", default: true },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 500 },
        maxFoldersPerCourse: { type: "integer", minimum: 1, maximum: 500, default: 1 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_list_upcoming_assignments",
    description: "Быстрый список заданий из глобального календаря Blackboard: повторяет общий запрос событий интерфейса, не открывая страницы курсов и папок. Учитывает выбранные календари; показывает задания с датой, но не сообщает статус отправки и не включает задания без срока.",
    inputSchema: {
      type: "object",
      properties: {
        daysBack: { type: "integer", minimum: 0, maximum: 3660, default: 0 },
        daysAhead: { type: "integer", minimum: 0, maximum: 3660, default: 365 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_list_course_items",
    description: "Открывает страницу курса или папку материалов и выводит ссылки на задания, тесты, файлы и подразделы. Для вложенных папок вызови инструмент повторно с их href.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_assignment_details",
    description: "Читает детали одного задания по ссылке из текущего содержимого курса: срок, доступность отправки, статус и актуальные поля формы. Не отправляет работу.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_list_my_submissions",
    description: "Список заданий на текущих курсах с доступным Blackboard статусом отправки. По умолчанию читает не более одной папки на курс; увеличь maxFoldersPerCourse для более полного, но более дорогого обхода.",
    inputSchema: { type: "object", properties: { courseYear: { type: "string" }, courseHref: { type: "string", format: "uri" }, limit: { type: "integer", minimum: 1, maximum: 500 }, maxFoldersPerCourse: { type: "integer", minimum: 1, maximum: 500, default: 1 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_submit_assignment",
    description: "Готовит или отправляет ответ/файл в форму задания. Сначала вызови без confirmed для проверки курса, задания, полей и файла; confirmed=true отправляет. Если есть несколько кнопок отправки, сначала выбери submitterName из preview. Повторная отправка может создать новую попытку.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" }, fields: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] } }, filePath: { type: "string" }, submitterName: { type: "string" }, confirmed: { type: "boolean" } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "bb_search_course_files",
    description: "Ищет файлы только в зачисленных курсах и сканирует не более одной папки каждого курса по умолчанию. Индекс кэшируется на пять минут и используется поиском материалов/объявлений; для скачивания передай href в bb_download_file.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, courseYear: { type: "string" }, courseHref: { type: "string", format: "uri" }, limit: { type: "integer", minimum: 1, maximum: 500 }, maxFoldersPerCourse: { type: "integer", minimum: 1, maximum: 500, default: 1 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_list_calendar_events",
    description: "Читает события выбранных календарей Blackboard за диапазон дат по общей ленте событий интерфейса.",
    inputSchema: { type: "object", properties: { daysBack: { type: "integer", minimum: 0, maximum: 3660 }, daysAhead: { type: "integer", minimum: 0, maximum: 3660 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_read_grades",
    description: "Открывает штатную ссылку «Мои оценки» только в указанном зачисленном курсе, чтобы не обходить все курсы.",
    inputSchema: { type: "object", properties: { courseHref: { type: "string", format: "uri" } }, required: ["courseHref"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_test_details",
    description: "Показывает тесты, ссылки на которые есть на странице содержимого курса. Не открывает ссылку запуска и не начинает попытку.",
    inputSchema: { type: "object", properties: { coursePageHref: { type: "string", format: "uri" }, testHref: { type: "string", format: "uri" } }, required: ["coursePageHref"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_search_course_content",
    description: "Ищет все виды материалов по названию в папках содержимого текущих курсов; по умолчанию сканирует не более одной папки на курс. Индекс ссылок кэшируется на пять минут; используй один поиск и фильтруй результаты вместо последовательных поисков файлов и объявлений.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, courseYear: { type: "string" }, courseHref: { type: "string", format: "uri" }, limit: { type: "integer", minimum: 1, maximum: 500 }, maxFoldersPerCourse: { type: "integer", minimum: 1, maximum: 500, default: 1 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_list_announcements",
    description: "Ищет ссылки на объявления в папках содержимого текущих курсов; повторный поиск материалов/файлов/объявлений повторно использует индекс в памяти пять минут. Если объявления доступны только в отдельной ленте, результат может быть неполным.",
    inputSchema: { type: "object", properties: { courseYear: { type: "string" }, courseHref: { type: "string", format: "uri" }, limit: { type: "integer", minimum: 1, maximum: 500 }, maxFoldersPerCourse: { type: "integer", minimum: 1, maximum: 500, default: 1 } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_read_notifications",
    description: "Читает панель уведомлений и её штатный DWR-вызов NautilusViewService.getEwsViewInfo. Идентификаторы сессии извлекаются из текущей HTTP-сессии и не возвращаются.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_download_file",
    description: "Скачивает файл по href Blackboard в BB_USURT_DOWNLOAD_DIR (по умолчанию <пакет>/downloads). Имя файла берётся из аргумента или URL.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" }, filename: { type: "string" } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bb_enroll_course",
    description: "Предлагает или выполняет GET по штатной ссылке зачисления. Первый вызов без confirmed=true возвращает предварительный план. Если Blackboard показывает отдельную форму подтверждения, её можно отправить через bb_submit_form.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" }, confirmed: { type: "boolean", default: false } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "bb_start_test",
    description: "Открывает точную ссылку теста. Сначала возвращает план; confirmed=true может создать timed attempt и запустить отсчёт.",
    inputSchema: { type: "object", properties: { href: { type: "string", format: "uri" }, confirmed: { type: "boolean", default: false } }, required: ["href"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "bb_submit_form",
    description: "Показывает план отправки или отправляет HTML-форму Blackboard. Hidden nonce и значения сессии берутся из актуальной страницы; передавай в fields только ответы. confirmed=true обязательно для фактической отправки. Если в форме несколько кнопок, выбери submitterName из preview. filePath нужен только для отправки файла.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", format: "uuid" },
        formIndex: { type: "integer", minimum: 0 },
        fields: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, default: {} },
        filePath: { type: "string" },
        submitterName: { type: "string" },
        confirmed: { type: "boolean", default: false },
      },
      required: ["pageId", "formIndex"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

function rememberPage(page) {
  const pageId = randomUUID();
  pages.set(pageId, { page, expiresAt: Date.now() + pageTtlMs });
  return pageId;
}

function pageById(pageId) {
  const entry = pages.get(pageId);
  if (!entry || entry.expiresAt < Date.now()) {
    pages.delete(pageId);
    throw new Error("Ссылка на страницу истекла. Открой страницу Blackboard ещё раз.");
  }
  return entry.page;
}

function cleanPages() {
  for (const [id, entry] of pages) if (entry.expiresAt < Date.now()) pages.delete(id);
}

function exposePage(page, pageId = rememberPage(page)) {
  const { _rawHtml, _forms, _pageUrl, ...publicPage } = page;
  return { ...publicPage, pageId };
}

const handlers = {
  async bb_login() { return client.login(); },
  async bb_status() {
    return {
      origin: BB_ORIGIN,
      authenticatedInThisProcess: client.authenticated,
      credentialsConfigured: Boolean(client.username && client.password),
      transport: client.transport.info,
      lastRequest: client.lastTrace?.request ?? null,
      note: "Cookies хранятся только в памяти текущего процесса.",
    };
  },
  async bb_courses({ refresh = false } = {}) { return client.listCourses({ refresh }); },
  async bb_search_courses({ query }) { return client.searchCourses(query); },
  async bb_list_assignments({ courseYear, courseHref, availableOnly = true, limit = 500, maxFoldersPerCourse = 1 }) { return client.listAssignments({ courseYear, courseHref, availableOnly, limit, maxFoldersPerCourse }); },
  async bb_list_upcoming_assignments({ daysBack = 0, daysAhead = 365 } = {}) { return client.listUpcomingAssignments({ daysBack, daysAhead }); },
  async bb_open_course({ href }) { return exposePage(await client.getPage(href)); },
  async bb_open_page({ href }) { return exposePage(await client.getPage(href)); },
  async bb_list_course_items({ href }) {
    const page = await client.getPage(href);
    const links = parseBlackboardLinks(page._rawHtml, page._pageUrl);
    return { page: exposePage(page), items: links.filter(link => ["assignment", "test", "file", "announcement", "course-content"].includes(link.kind)) };
  },
  async bb_assignment_details({ href }) { return client.assignmentDetails(href); },
  async bb_list_my_submissions({ courseYear, courseHref, limit = 500, maxFoldersPerCourse = 1 }) { return client.listMySubmissions({ courseYear, courseHref, limit, maxFoldersPerCourse }); },
  async bb_submit_assignment({ href, fields = {}, filePath, submitterName, confirmed = false }) { return client.submitAssignment({ href, fields, filePath, submitterName, confirmed }); },
  async bb_search_course_files({ query = "", courseYear, courseHref, limit = 100, maxFoldersPerCourse = 1 }) { return client.scanCourseContent({ query, courseYear, courseHref, kind: "file", limit, maxFoldersPerCourse }); },
  async bb_list_calendar_events({ daysBack = 30, daysAhead = 365 } = {}) { return client.listCalendarEvents({ daysBack, daysAhead }); },
  async bb_read_grades({ courseHref } = {}) { return client.readGrades({ courseHref }); },
  async bb_test_details({ coursePageHref, testHref }) { return client.testDetails({ coursePageHref, testHref }); },
  async bb_search_course_content({ query = "", courseYear, courseHref, limit = 100, maxFoldersPerCourse = 1 }) { return client.scanCourseContent({ query, courseYear, courseHref, kind: "any", limit, maxFoldersPerCourse }); },
  async bb_list_announcements({ courseYear, courseHref, limit = 100, maxFoldersPerCourse = 1 }) { return client.listAnnouncements({ courseYear, courseHref, limit, maxFoldersPerCourse }); },
  async bb_read_notifications({ href }) { return client.readNotifications(href); },
  async bb_download_file({ href, filename }) { return client.downloadFile(href, filename); },
  async bb_enroll_course({ href, confirmed = false }) {
    const result = await client.enrollCourse(href, confirmed);
    return result._rawHtml ? exposePage(result) : result;
  },
  async bb_start_test({ href, confirmed = false }) {
    const result = await client.startTest(href, confirmed);
    return result._rawHtml ? exposePage(result) : result;
  },
  async bb_submit_form({ pageId, formIndex, fields = {}, filePath, submitterName, confirmed = false }) {
    return client.submitForm({ page: pageById(pageId), formIndex, fields, filePath, submitterName, confirmed });
  },
};

function validate(value, schema, pathName = "arguments") {
  const errors = [];
  const check = (item, rule, at) => {
    if (rule.anyOf) {
      const passes = rule.anyOf.some(candidate => validateValue(item, candidate));
      if (!passes) errors.push(`${at} должен соответствовать одному из разрешённых типов`);
      return;
    }
    if (rule.type === "object") {
      if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${at} должен быть объектом`); return; }
      for (const key of rule.required || []) if (!Object.hasOwn(item, key)) errors.push(`${at}.${key} обязателен`);
      const properties = rule.properties || {};
      for (const key of Object.keys(item)) {
        const childRule = properties[key];
        if (childRule) check(item[key], childRule, `${at}.${key}`);
        else if (rule.additionalProperties === false) errors.push(`${at}.${key} не разрешён`);
        else if (rule.additionalProperties && typeof rule.additionalProperties === "object") check(item[key], rule.additionalProperties, `${at}.${key}`);
      }
      return;
    }
    if (rule.type === "array") {
      if (!Array.isArray(item)) { errors.push(`${at} должен быть массивом`); return; }
      item.forEach((entry, index) => check(entry, rule.items, `${at}[${index}]`));
      return;
    }
    if (rule.type === "string") {
      if (typeof item !== "string") { errors.push(`${at} должен быть строкой`); return; }
      if (rule.minLength && item.length < rule.minLength) errors.push(`${at} не должен быть пустым`);
      if (rule.format === "uri") { try { new URL(item); } catch { errors.push(`${at} должен быть абсолютным URL`); } }
      if (rule.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)) errors.push(`${at} должен быть UUID`);
      return;
    }
    if (rule.type === "boolean" && typeof item !== "boolean") errors.push(`${at} должен быть boolean`);
    if (rule.type === "integer" && (!Number.isInteger(item) || item < (rule.minimum ?? -Infinity) || item > (rule.maximum ?? Infinity))) errors.push(`${at} должен быть целым числом от ${rule.minimum ?? "−∞"} до ${rule.maximum ?? "+∞"}`);
  };
  const validateValue = (item, rule) => {
    const before = errors.length;
    check(item, rule, pathName);
    const ok = errors.length === before;
    errors.length = before;
    return ok;
  };
  check(value, schema, pathName);
  return errors;
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function modernResult(result) {
  return {
    ...result,
    resultType: "complete",
    _meta: { ...(result?._meta || {}), "io.modelcontextprotocol/serverInfo": serverInfo },
  };
}

function resultEnvelope(request, result, { modern = false } = {}) {
  return { jsonrpc: "2.0", id: request.id, result: modern ? modernResult(result) : result };
}

function rpcError(request, code, message, data, { modern = false } = {}) {
  const response = jsonRpcError(request.id, code, message, data);
  if (modern) response.error.data = { ...(typeof data === "object" && data ? data : {}), resultType: "error", _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } };
  return response;
}

let initialized = false;
let negotiatedLegacyVersion = legacyVersions[0];

async function dispatch(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return null;
  const hasId = Object.hasOwn(request, "id");
  const requestVersion = request.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  const modern = requestVersion === modernVersion;
  if (!hasId) {
    if (request.method === "notifications/initialized") initialized = true;
    return null;
  }
  if (request.method === "server/discover") {
    if (!modern) return rpcError(request, -32022, "Unsupported protocol version", { supported: [modernVersion] });
    return resultEnvelope(request, {
      supportedVersions: [modernVersion],
      capabilities: { tools: { listChanged: false } },
      instructions: "Use bb-usurt tools to work with the signed-in Blackboard account. Mutations require confirmed=true.",
      ttlMs: 0,
      cacheScope: "private",
    }, { modern: true });
  }
  if (request.method === "initialize") {
    const asked = request.params?.protocolVersion;
    negotiatedLegacyVersion = legacyVersions.includes(asked) ? asked : legacyVersions[0];
    initialized = true;
    return resultEnvelope(request, {
      protocolVersion: negotiatedLegacyVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      instructions: "Use bb-usurt tools to work with the signed-in Blackboard account. Mutations require confirmed=true.",
    });
  }
  if (requestVersion && !modern) return rpcError(request, -32022, "Unsupported protocol version", { supported: [modernVersion, ...legacyVersions] });
  if (!modern && !initialized) return rpcError(request, -32002, "Server is not initialized. Send initialize or server/discover first.");

  if (request.method === "ping") return resultEnvelope(request, {}, { modern });
  if (request.method === "tools/list") {
    const result = { tools: toolDefinitions };
    if (modern) { result.ttlMs = 0; result.cacheScope = "private"; }
    return resultEnvelope(request, result, { modern });
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const definition = toolDefinitions.find(item => item.name === name);
    if (!definition || !handlers[name]) return rpcError(request, -32602, `Unknown tool: ${String(name)}`, undefined, { modern });
    const args = request.params?.arguments ?? {};
    const errors = validate(args, definition.inputSchema);
    if (errors.length) return resultEnvelope(request, { isError: true, content: [{ type: "text", text: `Input validation error: ${errors.join("; ")}` }] }, { modern });
    try {
      cleanPages();
      const value = await handlers[name](args);
      return resultEnvelope(request, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }, { modern });
    } catch (error) {
      return resultEnvelope(request, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }, { modern });
    }
  }
  if (request.method === "notifications/cancelled" || request.method === "notifications/progress") return null;
  return rpcError(request, -32601, `Method not found: ${request.method}`, undefined, { modern });
}

let input = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 16 * 1024 * 1024) {
    console.error("MCP input buffer exceeded 16 MB; closing stdin.");
    process.stdin.destroy(new Error("MCP input limit exceeded."));
    return;
  }
  let newline;
  while ((newline = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    queue = queue.then(async () => {
      let request;
      try { request = JSON.parse(line); }
      catch { writeMessage(jsonRpcError(null, -32700, "Parse error")); return; }
      const response = await dispatch(request);
      if (response) writeMessage(response);
    }).catch(error => console.error("MCP request failed:", error?.message || String(error)));
  }
});
function shutdown(exitCode = 0) {
  client.close();
  process.exit(exitCode);
}
process.stdin.on("end", () => { queue.finally(() => shutdown(0)); });
process.stdin.on("error", error => { console.error("MCP stdin failed:", error.message); shutdown(1); });
process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));
console.error("bb-usurt MCP server ready on stdio (HTTPcloak transport; no browser runtime)");
