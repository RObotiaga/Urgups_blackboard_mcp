import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BB_ORIGIN, BB_ROUTES, assertRequestParity, buildCourseSearchRequest, canonicalRequest } from "./protocol.js";
import { HttpCloakTransport } from "./httpcloak-transport.js";

const assignmentWords = /задан|домашн|assignment/i;
const testWords = /тест|экзам|зач[её]т|assessment|test/i;
const fileExtension = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|rtf|jpg|jpeg|png|mp4)(?:$|[?#])/i;
const activityWords = /уведомлен|новости|активност|activity|notification|stream/i;
const announcementWords = /объявлен|announc|announcement/i;
const fileMimeTypes = new Map([
  [".pdf", "application/pdf"], [".txt", "text/plain"], [".rtf", "application/rtf"],
  [".doc", "application/msword"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"], [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"], [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".zip", "application/zip"], [".rar", "application/vnd.rar"], [".7z", "application/x-7z-compressed"],
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".svg", "image/svg+xml"], [".mp4", "video/mp4"], [".mp3", "audio/mpeg"],
]);

function multipartQuoted(value) {
  return String(value).replace(/[\r\n"]/g, character => character === '"' ? "%22" : "");
}

function createMultipartBoundary() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return `----WebKitFormBoundary${[...randomBytes(16)].map(byte => alphabet[byte % alphabet.length]).join("")}`;
}

export async function encodeBrowserMultipart(values, { boundary = createMultipartBoundary(), fileReader = readFile } = {}) {
  const chunks = [];
  for (const [name, value] of values) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    if (typeof value === "string") {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${multipartQuoted(name)}"\r\n\r\n${value.replace(/\r?\n/g, "\r\n")}\r\n`, "utf8"));
      continue;
    }
    const filePath = value.filePath;
    const filename = multipartQuoted(path.basename(filePath));
    const mimeType = fileMimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${multipartQuoted(name)}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf8"));
    chunks.push(await fileReader(filePath));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function cleanText(value = "") {
  return decodeEntities(value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function parseAttributes(source = "") {
  const result = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function parseLinks(html, pageUrl) {
  const result = [];
  const seen = new Set();
  const expression = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = expression.exec(html))) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.href || /^(?:javascript:|mailto:|#)/i.test(attributes.href)) continue;
    let url;
    try { url = new URL(attributes.href, pageUrl); } catch { continue; }
    if (url.origin !== BB_ORIGIN || seen.has(url.href)) continue;
    seen.add(url.href);
    const label = cleanText(match[2]) || attributes["aria-label"] || attributes.title || "";
    const route = url.pathname;
    let kind = "link";
    if (route === BB_ROUTES.courseLauncher && url.searchParams.get("type") === "Course") kind = "course";
    else if (route === BB_ROUTES.enrollment) kind = "enrollment";
    else if (/\/bbcswebdav\//i.test(route) || /\/download|\/attachment/i.test(route) || fileExtension.test(url.href)) kind = "file";
    else if (testWords.test(`${label} ${route}`) || /assessment|test/i.test(route)) kind = "test";
    else if (assignmentWords.test(`${label} ${route}`) || /assignment/i.test(route)) kind = "assignment";
    else if (route === BB_ROUTES.activityStream || activityWords.test(`${label} ${route}`)) kind = "activity";
    else if (announcementWords.test(`${label} ${route}`)) kind = "announcement";
    else if ([BB_ROUTES.contentList, BB_ROUTES.contentTool].includes(route)) kind = "course-content";
    result.push({ kind, label, href: url.href, path: url.pathname });
  }
  return result;
}

export function parseCourseCatalogEntries(html) {
  const entries = [];
  const seen = new Set();
  for (const [, row] of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const text = cleanText(row);
    const match = text.match(/Название курса:\s*(.*?)\s+Инструктор:\s*(.*?)(?:\s+Описание:|\s+Учебники:|$)/i);
    if (!match) continue;
    const courseName = match[1].trim();
    const instructor = match[2].trim();
    const key = `${courseName.toLocaleLowerCase()}\u0000${instructor.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const enrollmentAvailable = [...row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].some(([, attributes, label]) => {
      const parsed = parseAttributes(attributes);
      return /зачислить/i.test(`${cleanText(label)} ${parsed.title || ""}`);
    });
    entries.push({ kind: "course-catalog", label: courseName, courseName, instructor, enrollmentAvailable });
  }
  return entries;
}

function formControls(markup) {
  const controls = [];
  const token = /<input\b([^>]*)\/?\s*>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea\s*>|<select\b([^>]*)>([\s\S]*?)<\/select\s*>|<button\b([^>]*)>([\s\S]*?)<\/button\s*>/gi;
  let match;
  while ((match = token.exec(markup))) {
    let attributes;
    let control;
    if (match[1] !== undefined) {
      attributes = parseAttributes(match[1]);
      const type = (attributes.type || "text").toLowerCase();
      control = {
        tag: "input", type, name: attributes.name || "", value: attributes.value ?? (type === "checkbox" || type === "radio" ? "on" : ""),
        disabled: Object.hasOwn(attributes, "disabled"), checked: Object.hasOwn(attributes, "checked"),
        required: Object.hasOwn(attributes, "required"), label: attributes["aria-label"] || attributes.title || "", accept: attributes.accept || "",
      };
    } else if (match[2] !== undefined) {
      attributes = parseAttributes(match[2]);
      control = { tag: "textarea", type: "textarea", name: attributes.name || "", value: decodeEntities(match[3].replace(/\r?\n/g, "\n")), disabled: Object.hasOwn(attributes, "disabled"), label: attributes["aria-label"] || "" };
    } else if (match[4] !== undefined) {
      attributes = parseAttributes(match[4]);
      const options = [...match[5].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)].map(([, source, text]) => {
        const option = parseAttributes(source);
        return { value: option.value ?? cleanText(text), label: cleanText(text), selected: Object.hasOwn(option, "selected") };
      });
      const selected = options.filter(option => option.selected);
      control = { tag: "select", type: "select", name: attributes.name || "", value: (selected.length ? selected : options.slice(0, 1)).map(option => option.value), disabled: Object.hasOwn(attributes, "disabled"), required: Object.hasOwn(attributes, "required"), multiple: Object.hasOwn(attributes, "multiple"), options, label: attributes["aria-label"] || "" };
    } else {
      attributes = parseAttributes(match[6]);
      control = { tag: "button", type: (attributes.type || "submit").toLowerCase(), name: attributes.name || "", value: attributes.value ?? cleanText(match[7]), disabled: Object.hasOwn(attributes, "disabled"), label: cleanText(match[7]) };
    }
    if (control.name || control.tag === "button") controls.push(control);
  }
  return controls;
}

function parseForms(html, pageUrl) {
  const forms = [];
  const expression = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  let match;
  while ((match = expression.exec(html))) {
    const attributes = parseAttributes(match[1]);
    let action;
    try { action = new URL(attributes.action || pageUrl, pageUrl); } catch { continue; }
    if (action.origin !== BB_ORIGIN) continue;
    const controls = formControls(match[2]);
    forms.push({
      index: forms.length,
      action: action.href,
      method: (attributes.method || "GET").toUpperCase(),
      enctype: (attributes.enctype || "application/x-www-form-urlencoded").toLowerCase(),
      controls,
    });
  }
  return forms;
}

function parsePortalAjaxModule(html, marker) {
  const modules = [...html.matchAll(/<div\b[^>]*\bid=["']module:([^"']+)["'][^>]*>/gi)];
  for (let index = 0; index < modules.length; index++) {
    const start = modules[index].index;
    const end = modules[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    if (!block.includes(marker)) continue;
    const endpoint = block.match(/new Ajax\.Request\(\s*(['"])([^'"]+)\1/i)?.[2];
    const method = block.match(/method:\s*(['"])(get|post)\1/i)?.[2]?.toUpperCase();
    const encodedBody = block.match(/parameters:\s*(['"])((?:\\.|[^'"\\])*)\1/i)?.[2];
    if (!endpoint || !method || !encodedBody) throw new Error('The live Blackboard module request changed; refusing to guess its request.');
    const body = encodedBody.replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\([\\'"])/g, '$1');
    return { moduleId: modules[index][1], endpoint, method, body };
  }
  throw new Error('Could not find the expected live Blackboard module on the page.');
}

function parseXmlContents(xml) {
  const contents = xml.match(/<contents\b[^>]*>([\s\S]*?)<\/contents>/i)?.[1];
  if (contents === undefined) throw new Error('Blackboard module response did not contain the expected <contents> element.');
  const cdata = contents.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/i)?.[1];
  return cdata ?? decodeEntities(contents);
}

const russianMonths = new Map([
  ['января', '01'], ['февраля', '02'], ['марта', '03'], ['апреля', '04'], ['мая', '05'], ['июня', '06'],
  ['июля', '07'], ['августа', '08'], ['сентября', '09'], ['октября', '10'], ['ноября', '11'], ['декабря', '12'],
]);

function assignmentDueDate(text) {
  const match = text.match(/Дата выполнения\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})\s*г\.?\s*(\d{1,2}):(\d{2})/i);
  if (!match) return { dueDate: null, dueDateLabel: null };
  const [, day, month, year, hour, minute] = match;
  const dueDate = year + '-' + russianMonths.get(month.toLowerCase()) + '-' + day.padStart(2, '0') + 'T' + hour.padStart(2, '0') + ':' + minute;
  return { dueDate, dueDateLabel: day + ' ' + month + ' ' + year + ' г. ' + hour.padStart(2, '0') + ':' + minute };
}

function assignmentSubmissionStatus(page) {
  const text = page.text || '';
  const title = decodeEntities(page.title || '');
  const submitted = /Просмотреть историю отправки|Последняя оцененная попытка|Попытка\s*\(задержка\)/i.test(text + ' ' + title);
  const submissionForm = (page.forms || []).some(form => form.method === 'POST' && form.action === '/webapps/assignment/uploadAssignment');
  return {
    submissionStatus: submitted ? 'submitted' : submissionForm ? 'not-submitted' : 'unknown',
    canSubmit: submissionForm && !submitted,
  };
}

function describeForm(form) {
  const fields = form.controls.filter(control => control.name && control.type !== "submit" && control.type !== "button").map(control => ({
    name: control.name,
    type: control.type,
    label: control.label || undefined,
    options: control.options?.map(({ value, label }) => ({ value, label })),
    accept: control.accept || undefined,
    required: Boolean(control.required),
  }));
  return { index: form.index, method: form.method, action: new URL(form.action).pathname, contentType: form.enctype, fields, submitters: form.controls.filter(control => ["submit", "button"].includes(control.type) && !control.disabled).map(({ name, value, label }) => ({ name, value, label })) };
}

function redactedRequest(request) {
  const canonical = canonicalRequest(request);
  let fields = [];
  if (canonical.body && canonical.contentType === "application/x-www-form-urlencoded") fields = [...new URLSearchParams(canonical.body).keys()];
  else if (canonical.body && canonical.contentType === "text/plain" && new URL(canonical.url).pathname.includes("/dwr_open/call/")) {
    fields = canonical.body.split(/\r?\n/).filter(Boolean).map(line => line.slice(0, line.indexOf("=")));
  }
  else if (Array.isArray(request.formFields)) fields = request.formFields;
  const safeHeaders = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lowerName = name.toLowerCase();
    if (["cookie", "authorization", "proxy-authorization"].includes(lowerName)) continue;
    if (lowerName === "referer") {
      try {
        const referer = new URL(value);
        safeHeaders[name] = `${referer.origin}${referer.pathname}${referer.search ? `?${[...referer.searchParams.keys()].join("&")}` : ""}`;
      } catch { safeHeaders[name] = "[redacted]"; }
      continue;
    }
    safeHeaders[name] = lowerName === "content-type" ? String(value).split(";")[0] : value;
  }
  return {
    method: canonical.method,
    url: `${new URL(canonical.url).origin}${new URL(canonical.url).pathname}`,
    queryKeys: [...new URL(canonical.url).searchParams.keys()],
    contentType: canonical.contentType,
    bodyFields: fields,
    bodyBytes: request.bodyBytes ?? Buffer.byteLength(canonical.body),
    headers: safeHeaders,
    fetchMode: request.fetchMode ?? "navigate",
    ...(request.protocol ? { protocol: request.protocol } : {}),
    ...(request.fileCount ? { fileCount: request.fileCount } : {}),
    bodyEndsWithNewline: Boolean(canonical.body && /\r?\n$/.test(canonical.body)),
  };
}

function ensureSameOrigin(value, base = BB_ORIGIN) {
  const url = new URL(value, base);
  if (url.origin !== BB_ORIGIN) throw new Error("Only https://bb.usurt.ru requests are allowed.");
  return url;
}

function scriptSourceForDwr(markup, pageUrl) {
  for (const match of markup.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.src) continue;
    let url;
    try { url = new URL(attributes.src, pageUrl); } catch { continue; }
    if (url.origin === BB_ORIGIN && /\/dwr\/engine\.js$/i.test(url.pathname)) return url.href;
  }
  return null;
}

function dwrBasePathForService(markup, pageUrl, serviceName) {
  const expected = new RegExp(`/dwr_open/interface/${serviceName}\\.js$`, "i");
  for (const match of markup.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.src) continue;
    try {
      const scriptUrl = new URL(attributes.src, pageUrl);
      if (scriptUrl.origin !== BB_ORIGIN || !expected.test(scriptUrl.pathname)) continue;
      return scriptUrl.pathname.slice(0, scriptUrl.pathname.lastIndexOf("/interface/"));
    } catch { /* Ignore malformed script URLs. */ }
  }
  const page = new URL(pageUrl);
  if (page.pathname.startsWith("/webapps/portal/")) return "/webapps/portal/dwr_open";
  if (page.pathname.startsWith("/webapps/blackboard/")) return "/webapps/blackboard/dwr_open";
  return null;
}

export function parseDwrReply(responseText) {
  const marker = "dwr.engine._remoteHandleCallback(";
  const start = responseText.indexOf(marker);
  if (start < 0) throw new Error("Blackboard DWR response did not contain the expected callback.");
  let index = start + marker.length;
  let depth = 0;
  let quote = "";
  let escaped = false;
  const argumentsList = [];
  let argumentStart = index;
  for (; index < responseText.length; index++) {
    const character = responseText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (character === "{" || character === "[" || character === "(") depth++;
    else if (character === "}" || character === "]") depth--;
    else if (character === ")") {
      if (depth === 0) { argumentsList.push(responseText.slice(argumentStart, index).trim()); break; }
      depth--;
    } else if (character === "," && depth === 0) {
      argumentsList.push(responseText.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }
  if (argumentsList.length !== 3) throw new Error("Blackboard DWR callback had an unexpected argument shape.");
  const source = argumentsList[2];
  let cursor = 0;
  const skipSpace = () => { while (/\s/.test(source[cursor] || "")) cursor++; };
  const parseString = () => {
    const quoteChar = source[cursor++];
    let result = "";
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === quoteChar) return result;
      if (character !== "\\") { result += character; continue; }
      const escapedChar = source[cursor++];
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
      if (Object.hasOwn(escapes, escapedChar)) result += escapes[escapedChar];
      else if (escapedChar === "u") {
        const hex = source.slice(cursor, cursor + 4);
        if (!/^[\da-f]{4}$/i.test(hex)) throw new Error("Invalid Unicode escape in DWR reply.");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 4;
      } else if (escapedChar === "x") {
        const hex = source.slice(cursor, cursor + 2);
        if (!/^[\da-f]{2}$/i.test(hex)) throw new Error("Invalid hexadecimal escape in DWR reply.");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 2;
      } else if (escapedChar === "\n") { /* JavaScript line continuation */ }
      else if (escapedChar === "\r") { if (source[cursor] === "\n") cursor++; }
      else result += escapedChar;
    }
    throw new Error("Unterminated string in DWR reply.");
  };
  const parseValue = () => {
    skipSpace();
    const character = source[cursor];
    if (character === "\"" || character === "'") return parseString();
    if (character === "{") {
      cursor++;
      const result = Object.create(null);
      skipSpace();
      while (source[cursor] !== "}") {
        skipSpace();
        const key = source[cursor] === "\"" || source[cursor] === "'" ? parseString() : parseIdentifier();
        skipSpace();
        if (source[cursor++] !== ":") throw new Error("Invalid object in DWR reply.");
        result[key] = parseValue();
        skipSpace();
        if (source[cursor] === ",") { cursor++; skipSpace(); if (source[cursor] === "}") break; }
        else if (source[cursor] !== "}") throw new Error("Invalid object separator in DWR reply.");
      }
      cursor++;
      return result;
    }
    if (character === "[") {
      cursor++;
      const result = [];
      skipSpace();
      while (source[cursor] !== "]") {
        result.push(parseValue());
        skipSpace();
        if (source[cursor] === ",") { cursor++; skipSpace(); if (source[cursor] === "]") break; }
        else if (source[cursor] !== "]") throw new Error("Invalid array separator in DWR reply.");
      }
      cursor++;
      return result;
    }
    const identifier = parseIdentifier();
    if (identifier === "null") return null;
    if (identifier === "true") return true;
    if (identifier === "false") return false;
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(identifier)) return Number(identifier);
    throw new Error("Unsupported value in Blackboard DWR reply.");
  };
  const parseIdentifier = () => {
    skipSpace();
    const match = /^[A-Za-z_$][\w$]*|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(cursor));
    if (!match) throw new Error("Unexpected token in Blackboard DWR reply.");
    cursor += match[0].length;
    return match[0];
  };
  const value = parseValue();
  skipSpace();
  if (cursor !== source.length) throw new Error("Trailing data in Blackboard DWR reply.");
  return value;
}

export function buildDwrRequest({ pageUrl, httpSessionId, scriptSessionId, serviceName, methodName, dwrBasePath, batchId = 0 }) {
  if (!/^[A-Za-z_$][\w$]*$/.test(serviceName) || !/^[A-Za-z_$][\w$]*$/.test(methodName)) throw new Error("Invalid DWR service or method name.");
  const page = ensureSameOrigin(pageUrl);
  const basePath = dwrBasePath || dwrBasePathForService("", page.href, serviceName);
  if (!basePath || !basePath.startsWith("/webapps/")) throw new Error("The Blackboard DWR base path could not be determined from the live page.");
  const body = [
    "callCount=1",
    `page=${page.pathname}${page.search}`,
    `httpSessionId=${httpSessionId}`,
    `scriptSessionId=${scriptSessionId}`,
    `c0-scriptName=${serviceName}`,
    `c0-methodName=${methodName}`,
    "c0-id=0",
    "c0-param0=null:null",
    `batchId=${batchId}`,
    "",
  ].join("\n");
  return {
    method: "POST",
    url: new URL(`${basePath}/call/plaincall/${serviceName}.${methodName}.dwr`, BB_ORIGIN).href,
    contentType: "text/plain",
    body,
  };
}

export function buildDwrEwsViewInfoRequest({ pageUrl, httpSessionId, scriptSessionId, batchId = 0, dwrBasePath = "/webapps/portal/dwr_open" }) {
  return buildDwrRequest({ pageUrl, httpSessionId, scriptSessionId, serviceName: "NautilusViewService", methodName: "getEwsViewInfo", dwrBasePath, batchId });
}

export class BbUsurtClient {
  constructor({ transport = new HttpCloakTransport(), username = process.env.BB_USURT_USERNAME, password = process.env.BB_USURT_PASSWORD, downloadDir = process.env.BB_USURT_DOWNLOAD_DIR || path.resolve("downloads") } = {}) {
    this.transport = transport;
    this.username = username;
    this.password = password;
    this.downloadDir = path.resolve(downloadDir);
    this.authenticated = false;
    this.lastUrl = BB_ORIGIN;
    this.lastTrace = null;
    this.traceHistory = [];
    this.coursesCache = null;
    this.calendarContext = null;
    this.calendarEventsCache = null;
    this.contentIndexCache = null;
  }

  async request(input, { method = "GET", headers = {}, body, contentType, referer, fetchMode = "navigate", maxRedirects = 10, streaming = false, formFields, fileCount = 0 } = {}) {
    let url = ensureSameOrigin(input, this.lastUrl);
    let currentMethod = method.toUpperCase();
    let currentBody = body;
    let currentContentType = contentType;
    let currentReferer = referer ?? this.lastUrl;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
      const requestHeaders = { ...headers };
      const hasHeader = (name) => Object.keys(requestHeaders).some(key => key.toLowerCase() === name.toLowerCase());
      if (currentReferer && new URL(currentReferer).origin === BB_ORIGIN && !hasHeader("Referer")) requestHeaders.Referer = currentReferer;
      if (currentBody !== undefined && currentContentType && !hasHeader("Content-Type")) requestHeaders["Content-Type"] = currentContentType;
      const traceHeaders = this.transport.headersForRequest?.(requestHeaders, fetchMode, url.href) ?? { ...requestHeaders };
      const requestRecord = {
        method: currentMethod,
        url: url.href,
        contentType: Object.entries(requestHeaders).find(([name]) => name.toLowerCase() === "content-type")?.[1] || currentContentType || "",
        body: typeof currentBody === "string" ? currentBody : "",
        bodyBytes: typeof currentBody === "string" || Buffer.isBuffer(currentBody) ? Buffer.byteLength(currentBody) : 0,
        ...(formFields ? { formFields } : {}),
        ...(fileCount ? { fileCount } : {}),
        headers: traceHeaders,
        fetchMode,
      };
      const response = await this.transport.request(url.href, {
        method: currentMethod,
        headers: requestHeaders,
        body: currentBody,
        fetchMode,
        allowRedirects: false,
        streaming,
      });
      const trace = { request: redactedRequest({ ...requestRecord, protocol: response.protocol }), status: response.status };
      this.traceHistory.push(trace);
      this.lastTrace = trace;
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        this.lastUrl = response.url || url.href;
        return response;
      }
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel();
      const nextUrl = new URL(location, url);
      if (nextUrl.origin !== BB_ORIGIN) {
        this.lastUrl = url.href;
        return response;
      }
      if (redirectCount === maxRedirects) throw new Error("Too many redirects from Blackboard.");
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
        currentContentType = undefined;
      }
      currentReferer = url.href;
      url = nextUrl;
    }
    throw new Error("Blackboard request did not complete.");
  }

  close() {
    this.transport.close?.();
  }

  async #readPage(input, options = {}) {
    const response = await this.request(input, options);
    const text = await response.text();
    const url = response.url || this.lastUrl;
    const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    return { response, text, url, title: cleanText(title) };
  }

  async login(username = this.username, password = this.password) {
    if (!username || !password) throw new Error("Set BB_USURT_USERNAME and BB_USURT_PASSWORD for this MCP process.");
    const loginPage = await this.#readPage(BB_ROUTES.login, { referer: "", fetchMode: "navigate" });
    if (!loginPage.response.ok) throw new Error(`Blackboard login form returned HTTP ${loginPage.response.status}.`);
    const loginForm = parseForms(loginPage.text, loginPage.url).find(form => form.controls.some(control => control.name === "user_id") && form.controls.some(control => control.name === "password"));
    if (!loginForm) throw new Error("The login page no longer exposes the observed user_id/password form; this account may require a different sign-in flow.");
    const loginSubmitters = loginForm.controls.filter(control => control.type === "submit" && !control.disabled);
    const loginSubmitter = loginSubmitters.length === 1 ? loginSubmitters[0] : undefined;
    const pairs = [];
    for (const control of loginForm.controls) {
      if (!control.name || control.disabled || ["button", "file", "reset"].includes(control.type)) continue;
      if (control.type === "submit") { if (control === loginSubmitter) pairs.push([control.name, control.value]); continue; }
      if (control.type === "checkbox" || control.type === "radio") { if (control.checked) pairs.push([control.name, control.value]); continue; }
      const value = control.name === "user_id" ? username : control.name === "password" ? password : control.value;
      pairs.push([control.name, value]);
    }
    const body = new URLSearchParams(pairs).toString();
    const response = await this.request(loginForm.action, {
      method: loginForm.method,
      body,
      contentType: "application/x-www-form-urlencoded",
      referer: loginPage.url,
      headers: { Origin: BB_ORIGIN },
      fetchMode: "navigate",
    });
    const html = await response.text();
    const finalUrl = response.url || this.lastUrl;
    const stillHasLogin = /<input\b[^>]*name=["'](?:user_id|password)["']/i.test(html) && /webapps\/login/i.test(finalUrl);
    if (!response.ok || stillHasLogin || /invalid username|invalid password|неверн(?:ый|ые) (?:логин|парол)/i.test(html)) {
      this.authenticated = false;
      throw new Error("Blackboard did not accept the configured login. No credentials were saved.");
    }
    const check = await this.request(`${BB_ROUTES.courseTab}?tab_tab_group_id=_1_1`, { referer: finalUrl });
    const checkHtml = await check.text();
    const checkUrl = check.url || this.lastUrl;
    this.authenticated = !(/\/webapps\/login\//i.test(checkUrl) && /name=["']user_id["']/i.test(checkHtml));
    if (!this.authenticated) throw new Error("Blackboard returned to the login page; check whether this account requires an additional sign-in step.");
    this.coursesCache = null;
    this.calendarContext = null;
    this.calendarEventsCache = null;
    this.contentIndexCache = null;
    return { authenticated: true, url: `${new URL(checkUrl).origin}${new URL(checkUrl).pathname}`, title: cleanText(checkHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") };
  }

  async ensureAuthenticated() {
    if (this.authenticated) return;
    if (!this.username || !this.password) throw new Error("Authentication is not initialized. Configure BB_USURT_USERNAME and BB_USURT_PASSWORD, then call bb_login.");
    await this.login();
  }

  async #readCoursesTab() {
    const portal = await this.#readPage(BB_ROUTES.courseTab + "?tab_tab_group_id=_1_1");
    const coursesTab = parseLinks(portal.text, portal.url).find(link =>
      link.path === BB_ROUTES.courseTab && /(?:^|\s)курсы(?:\s|$)/i.test(link.label),
    );
    if (!coursesTab) throw new Error("Could not find the live Blackboard Courses tab.");
    if (new URL(coursesTab.href).href === new URL(portal.url).href) return portal;
    return this.#readPage(coursesTab.href, { referer: portal.url });
  }

  async listCourses({ refresh = false } = {}) {
    await this.ensureAuthenticated();
    if (refresh) this.contentIndexCache = null;
    if (!refresh && this.coursesCache && this.coursesCache.expiresAt > Date.now()) {
      return { ...this.coursesCache.result, courses: this.coursesCache.result.courses.map(course => ({ ...course })), cacheHit: true, requestCount: 0 };
    }
    const traceStart = this.traceHistory.length;
    const page = await this.#readCoursesTab();
    const module = parsePortalAjaxModule(page.text, "extid:learning/coursetab-courses:");
    const endpoint = new URL(module.endpoint, page.url);
    if (endpoint.origin !== BB_ORIGIN || endpoint.pathname !== BB_ROUTES.courseTab) throw new Error("The live course module points to an unexpected Blackboard endpoint; refusing to send it.");
    const parameters = new URLSearchParams(module.body);
    if (module.method !== "POST" || parameters.get("action") !== "refreshAjaxModule" || parameters.get("modId") !== module.moduleId) {
      throw new Error("The live course module request changed; refusing to send a different request.");
    }
    const response = await this.request(endpoint.href, {
      method: module.method,
      body: module.body,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      referer: page.url,
      headers: {
        "Content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: BB_ORIGIN,
        "X-Requested-With": "XMLHttpRequest",
        "X-Prototype-Version": "1.7",
        Accept: "text/javascript, text/html, application/xml, text/xml, */*",
      },
      fetchMode: "cors",
    });
    if (!response.ok) throw new Error("Blackboard course module returned HTTP " + response.status + ".");
    const moduleHtml = parseXmlContents(await response.text());
    const courses = parseLinks(moduleHtml, page.url)
      .filter(link => link.kind === "course")
      .map(link => ({ ...link, courseId: new URL(link.href).searchParams.get("id") }));
    const result = {
      url: new URL(page.url).origin + new URL(page.url).pathname,
      title: page.title,
      courses,
      request: this.lastTrace?.request,
      browserParity: "The module endpoint and ordered body come from the live Courses-tab Ajax.Request. CDP confirms the route, body shape/length, and safe headers; dynamic IDs, wire header order, and TLS fingerprint are not compared.",
      cacheHit: false,
      requestCount: this.traceHistory.length - traceStart,
    };
    this.coursesCache = { result, expiresAt: Date.now() + 90_000 };
    return { ...result, courses: result.courses.map(course => ({ ...course })) };
  }

  async #readCatalogFormPage() {
    return this.#readCoursesTab();
  }

  async searchCourses(query) {
    await this.ensureAuthenticated();
    const plan = buildCourseSearchRequest(query);
    const catalogPage = await this.#readCatalogFormPage();
    const catalogForm = parseForms(catalogPage.text, catalogPage.url).find(form =>
      new URL(form.action).pathname === BB_ROUTES.catalog && form.controls.some(control => control.name === "searchText"),
    );
    if (!catalogForm) throw new Error("The live Blackboard Courses tab no longer contains the expected catalog search form.");
    if (catalogForm.method !== "POST" || catalogForm.enctype !== "application/x-www-form-urlencoded") {
      throw new Error("The live Blackboard catalog form changed its method or encoding; refusing to send a different request.");
    }
    const fields = [];
    for (const control of catalogForm.controls) {
      if (!control.name || control.disabled || ["submit", "button", "reset", "file"].includes(control.type)) continue;
      if (control.type === "checkbox" || control.type === "radio") { if (control.checked) fields.push([control.name, control.value]); continue; }
      const values = control.tag === "select" ? control.value : [control.value];
      for (const value of values) fields.push([control.name, value]);
    }
    const overrides = { type: "Course", command: "NewSearch", searchText: String(query) };
    const body = new URLSearchParams(fields.map(([key, value]) => [key, Object.hasOwn(overrides, key) ? overrides[key] : value])).toString();
    assertRequestParity({ method: catalogForm.method, url: catalogForm.action, contentType: catalogForm.enctype, body }, plan);
    const response = await this.request(catalogForm.action, {
      method: catalogForm.method,
      body,
      contentType: catalogForm.enctype,
      referer: catalogPage.url,
      headers: { Origin: BB_ORIGIN },
    });
    const html = await response.text();
    const url = response.url || this.lastUrl;
    const catalogEntries = parseCourseCatalogEntries(html);
    const courses = catalogEntries.length
      ? catalogEntries
      : parseLinks(html, url).filter(link => link.kind === "course").map(link => ({ ...link, courseId: new URL(link.href).searchParams.get("id") }));
    return { status: response.status, url: `${new URL(url).origin}${new URL(url).pathname}`, title: cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""), courses, request: this.lastTrace?.request, browserParity: "Method, URL, content type and form body match the live Courses-tab form; body parity is byte-for-byte." };
  }

  async listAssignments({ courseYear, courseHref, availableOnly = true, limit = 500, maxFoldersPerCourse = 1 } = {}) {
    await this.ensureAuthenticated();
    const traceStart = this.traceHistory.length;
    if (!Number.isInteger(maxFoldersPerCourse) || maxFoldersPerCourse < 1 || maxFoldersPerCourse > 500) throw new Error("maxFoldersPerCourse must be an integer from 1 to 500.");
    const contentIndex = await this.scanCourseContent({ courseHref, courseYear, kind: "assignment", limit: 500, maxFoldersPerCourse });
    const courseResult = await this.listCourses();
    let courses = courseResult.courses;
    if (courseHref) {
      const target = ensureSameOrigin(courseHref, this.lastUrl).href;
      courses = courses.filter(course => new URL(course.href).href === target);
      if (!courses.length) throw new Error("The requested course link is not present in the current Blackboard Courses tab.");
    }
    if (courseYear) courses = courses.filter(course => course.label.includes(String(courseYear)));
    const assignments = [];
    const warnings = [...contentIndex.warnings];
    const foldersRead = contentIndex.foldersRead;
    const assignmentPath = "/webapps/assignment/uploadAssignment";
    if (contentIndex.truncated) warnings.push({ message: "Assignment links were capped at 500 before assignment pages were read." });
    for (const course of courses) {
      try {
        const courseId = course.courseId || new URL(course.href).searchParams.get("id");
        const assignmentLinks = contentIndex.items.filter(link => link.courseId === courseId && link.path === assignmentPath);
        for (const link of assignmentLinks) {
          const page = await this.getPage(link.href);
          const state = assignmentSubmissionStatus(page);
          if (availableOnly && !state.canSubmit) continue;
          const due = assignmentDueDate(page.text);
          assignments.push({
            course: course.label,
            courseId,
            title: link.label,
            href: link.href,
            dueDate: due.dueDate,
            dueDateLabel: due.dueDateLabel,
            submissionStatus: state.submissionStatus,
            canSubmit: state.canSubmit,
          });
        }
      } catch (error) {
        warnings.push({ course: course.label, message: error instanceof Error ? error.message : String(error) });
      }
    }
    assignments.sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, "ru");
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return a.course.localeCompare(b.course, "ru") || a.title.localeCompare(b.title, "ru");
    });
    const resultLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 500;
    return {
      coursesScanned: courses.length,
      foldersRead,
      requestCount: this.traceHistory.length - traceStart,
      availableOnly,
      totalAssignments: assignments.length,
      truncated: assignments.length > resultLimit,
      complete: warnings.length === 0 && assignments.length <= resultLimit,
      assignments: assignments.slice(0, resultLimit),
      warnings,
      note: "Assignment pages were read only. No files or forms were submitted, and no tests were started. Due dates are portal-local; assignments without a due date sort last.",
    };
  }

  async #assertEnrolledAssignment(href) {
    const url = ensureSameOrigin(href, this.lastUrl);
    if (url.pathname !== "/webapps/assignment/uploadAssignment") throw new Error("The supplied link is not a Blackboard assignment page.");
    const courseId = url.searchParams.get("course_id");
    const enrolledIds = new Set((await this.listCourses()).courses.map(course => course.courseId).filter(Boolean));
    if (!courseId || !enrolledIds.has(courseId)) throw new Error("This assignment does not belong to a course listed on your current Blackboard Courses tab.");
    return url;
  }

  async assignmentDetails(href) {
    await this.#assertEnrolledAssignment(href);
    const page = await this.getPage(href);
    if (new URL(page._pageUrl).pathname !== "/webapps/assignment/uploadAssignment") {
      throw new Error("The supplied link is not a Blackboard assignment page.");
    }
    const state = assignmentSubmissionStatus(page);
    const due = assignmentDueDate(page.text);
    return {
      url: page.url,
      title: page.title,
      text: page.text,
      dueDate: due.dueDate,
      dueDateLabel: due.dueDateLabel,
      submissionStatus: state.submissionStatus,
      canSubmit: state.canSubmit,
      forms: page.forms,
    };
  }

  async listMySubmissions({ courseYear, courseHref, limit = 500, maxFoldersPerCourse = 1 } = {}) {
    const result = await this.listAssignments({ courseYear, courseHref, availableOnly: false, limit, maxFoldersPerCourse });
    const { assignments, ...summary } = result;
    return {
      ...summary,
      submissions: assignments.map(({ course, courseId, title, href, dueDate, dueDateLabel, submissionStatus, canSubmit }) => ({
        course, courseId, title, href, dueDate, dueDateLabel, submissionStatus, canSubmit,
      })),
      note: "Blackboard exposes submission state on assignment pages. 'submitted' is inferred from the server-rendered page; 'unknown' means the page did not expose a recognizable status.",
    };
  }

  async submitAssignment({ href, fields = {}, filePath, submitterName, confirmed = false }) {
    await this.#assertEnrolledAssignment(href);
    const page = await this.getPage(href);
    if (new URL(page._pageUrl).pathname !== "/webapps/assignment/uploadAssignment") {
      throw new Error("The supplied link is not a Blackboard assignment page.");
    }
    const formIndex = page._forms.findIndex(form => form.method === "POST" && new URL(form.action).pathname === "/webapps/assignment/uploadAssignment");
    if (formIndex < 0) throw new Error("This assignment page does not expose a supported submission form.");
    const result = await this.submitForm({ page, formIndex, fields, filePath, submitterName, confirmed });
    return {
      ...result,
      note: confirmed
        ? "Blackboard received the form request; inspect the returned page and bb_assignment_details to verify the submission state."
        : "Preview only. Re-call with confirmed=true only after checking the course, assignment, fields, and file.",
    };
  }

  async scanCourseContent({ query = "", courseHref, courseYear, kind = "any", limit = 100, maxFoldersPerCourse = 1 } = {}) {
    await this.ensureAuthenticated();
    const traceStart = this.traceHistory.length;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500.");
    if (!Number.isInteger(maxFoldersPerCourse) || maxFoldersPerCourse < 1 || maxFoldersPerCourse > 500) throw new Error("maxFoldersPerCourse must be an integer from 1 to 500.");
    const allowedKinds = new Set(["any", "file", "assignment", "test", "announcement", "course-content"]);
    if (!allowedKinds.has(kind)) throw new Error("Unsupported content kind.");
    const result = await this.listCourses();
    let courses = result.courses;
    if (courseHref) {
      const target = ensureSameOrigin(courseHref, this.lastUrl).href;
      courses = courses.filter(course => new URL(course.href).href === target);
      if (!courses.length) throw new Error("Only courses present in the current Blackboard Courses tab can be scanned.");
    }
    if (courseYear) courses = courses.filter(course => course.label.includes(String(courseYear)));
    const matcher = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    const cacheKey = `${courses.map(course => course.courseId).sort().join(",")}|${maxFoldersPerCourse}`;
    let index = this.contentIndexCache?.key === cacheKey && this.contentIndexCache.expiresAt > Date.now() ? this.contentIndexCache : null;
    const cacheHit = Boolean(index);
    if (!index) {
      const items = new Map();
      const warnings = [];
      let foldersRead = 0;
      let pagesRead = 0;
      for (const course of courses) {
        try {
          const queue = [course.href];
          const seenPages = new Set();
          const queuedFolders = new Set();
          let courseFolderCount = 0;
          let folderLimitReached = false;
          while (queue.length && courseFolderCount <= maxFoldersPerCourse) {
            const pageHref = queue.shift();
            if (seenPages.has(pageHref)) continue;
            seenPages.add(pageHref);
            pagesRead++;
            const page = await this.getPage(pageHref);
            for (const link of parseLinks(page._rawHtml, page._pageUrl)) {
              if (link.path === BB_ROUTES.contentList && !seenPages.has(link.href) && !queuedFolders.has(link.href)) {
                if (courseFolderCount >= maxFoldersPerCourse) folderLimitReached = true;
                else {
                  queue.push(link.href);
                  queuedFolders.add(link.href);
                  courseFolderCount++;
                  foldersRead++;
                }
              }
              if (link.kind === "link" && announcementWords.test(`${link.label} ${link.path}`)) link.kind = "announcement";
              items.set(link.href, { ...link, course: course.label, courseId: course.courseId });
            }
          }
          if (queue.length || folderLimitReached) warnings.push({ course: course.label, message: "Folder scan limit reached; some items may be missing." });
        } catch (error) {
          warnings.push({ course: course.label, message: error instanceof Error ? error.message : String(error) });
        }
      }
      index = { key: cacheKey, items: [...items.values()], warnings, foldersRead, pagesRead, expiresAt: Date.now() + 300_000 };
      this.contentIndexCache = index;
    }
    const matches = index.items
      .filter(item => (kind === "any" || item.kind === kind) && (!matcher || matcher.test(item.label)))
      .sort((a, b) => a.course.localeCompare(b.course, "ru") || a.label.localeCompare(b.label, "ru"));
    return {
      coursesScanned: courses.length,
      foldersRead: index.foldersRead,
      pagesRead: index.pagesRead,
      indexCacheHit: cacheHit,
      requestCount: this.traceHistory.length - traceStart,
      total: matches.length,
      truncated: matches.length > limit,
      complete: index.warnings.length === 0 && matches.length <= limit,
      items: matches.slice(0, limit),
      warnings: index.warnings,
      note: "Scans only courses listed on the current Blackboard Courses tab. Search uses item link titles; content bodies are not opened or indexed. The shallow traversal checks at most one folder per course by default; raise maxFoldersPerCourse for deeper searches. The link index is cached in memory for five minutes to reuse the traversal across file, content, and announcement searches.",
    };
  }

  async #readCalendarEventFeed({ daysBack, daysAhead }) {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - daysBack);
    const end = new Date(); end.setHours(23, 59, 59, 999); end.setDate(end.getDate() + daysAhead);
    const range = { start: start.toISOString(), end: end.toISOString() };
    const cacheKey = `${start.getTime()}:${end.getTime()}`;
    if (this.calendarEventsCache?.key === cacheKey && this.calendarEventsCache.expiresAt > Date.now()) {
      return { ...this.calendarEventsCache, requestCount: 0, cacheHit: true, calendarContextCacheHit: true };
    }
    const traceStart = this.traceHistory.length;
    const calendarContextCacheHit = this.calendarContext?.expiresAt > Date.now();
    const calendarUrl = await this.#getCalendarPageUrl();
    const eventUrl = `${BB_ORIGIN}/webapps/calendar/calendarData/selectedCalendarEvents?start=${start.getTime()}&end=${end.getTime()}&course_id=&mode=personal`;
    const response = await this.request(eventUrl, { referer: calendarUrl, headers: { Accept: "*/*", "X-Requested-With": "XMLHttpRequest" }, fetchMode: "cors" });
    if (!response.ok) throw new Error(`Blackboard calendar events returned HTTP ${response.status}.`);
    let events;
    try { events = JSON.parse(await response.text()); } catch { throw new Error("Blackboard returned an unreadable calendar event list."); }
    if (!Array.isArray(events)) throw new Error("The Blackboard calendar response has an unexpected shape.");
    const result = {
      key: cacheKey,
      events,
      range,
      expiresAt: Date.now() + 15_000,
      requestCount: this.traceHistory.length - traceStart,
      cacheHit: false,
      calendarContextCacheHit,
    };
    this.calendarEventsCache = result;
    return result;
  }

  async listCalendarEvents({ daysBack = 30, daysAhead = 365 } = {}) {
    await this.ensureAuthenticated();
    for (const [name, value] of [["daysBack", daysBack], ["daysAhead", daysAhead]]) {
      if (!Number.isInteger(value) || value < 0 || value > 3660) throw new Error(`${name} must be an integer from 0 to 3660.`);
    }
    const feed = await this.#readCalendarEventFeed({ daysBack, daysAhead });
    const events = feed.events;
    return {
      total: events.length,
      range: feed.range,
      events: events.map(event => ({
        course: event.calendarNameLocalizable?.rawValue || event.calendarName || "",
        title: cleanText(event.title || "Без названия"),
        start: event.start || null,
        end: event.end || null,
        eventType: event.eventType || null,
        attemptable: event.attemptable === true,
        href: typeof event.url === "string" && event.url.startsWith("/") ? new URL(event.url, BB_ORIGIN).href : null,
      })).sort((a, b) => String(a.start || "").localeCompare(String(b.start || ""))),
      requestCount: feed.requestCount,
      cacheHit: feed.cacheHit,
      calendarContextCacheHit: feed.calendarContextCacheHit,
      note: "Uses the same selected-calendar feed as the Blackboard UI. Results follow the calendars selected in Blackboard settings.",
    };
  }

  async #getCalendarPageUrl() {
    if (this.calendarContext?.expiresAt > Date.now()) return this.calendarContext.url;
    const portal = await this.#readPage(`${BB_ROUTES.courseTab}?tab_tab_group_id=_1_1`);
    const calendarLink = parseLinks(portal.text, portal.url).find(link => /календар/i.test(link.label));
    if (!calendarLink) throw new Error("The live Blackboard portal does not expose its Calendar link.");
    const calendarPage = await this.#readPage(calendarLink.href, { referer: portal.url });
    if (!new Set(["/webapps/blackboard/execute/viewCalendar", "/webapps/calendar/viewPersonal"]).has(new URL(calendarPage.url).pathname)) throw new Error("The live Blackboard Calendar link points to an unexpected page.");
    this.calendarContext = { url: calendarPage.url, expiresAt: Date.now() + 60_000 };
    return calendarPage.url;
  }

  async readGrades({ courseHref } = {}) {
    await this.ensureAuthenticated();
    if (!courseHref) throw new Error("Provide courseHref to read grades for one enrolled course; omitting it would scan every course.");
    const courses = (await this.listCourses()).courses;
    let selected = courses;
    if (courseHref) {
      const target = ensureSameOrigin(courseHref, this.lastUrl).href;
      selected = courses.filter(course => new URL(course.href).href === target);
      if (!selected.length) throw new Error("Only courses listed on the current Blackboard Courses tab can be queried.");
    }
    const grades = [];
    const warnings = [];
    for (const course of selected) {
      try {
        const page = await this.getPage(course.href);
        const links = parseLinks(page._rawHtml, page._pageUrl);
        const href = links.find(link => new URL(link.href).pathname === BB_ROUTES.myGrades)?.href;
        if (!href) { warnings.push({ course: course.label, message: "No live My Grades link was exposed by this course page." }); continue; }
        const gradePage = await this.getPage(href);
        const rows = [...gradePage._rawHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(([, row]) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map(([, cell]) => cleanText(cell))).filter(row => row.length);
        grades.push({ course: course.label, title: gradePage.title, rows, text: gradePage.text });
      } catch (error) { warnings.push({ course: course.label, message: error instanceof Error ? error.message : String(error) }); }
    }
    return { coursesScanned: selected.length, grades, warnings, note: "Grade rows are extracted from server-rendered My Grades tables; layout variations may require an updated parser." };
  }

  async testDetails({ coursePageHref, testHref }) {
    const coursePageUrl = ensureSameOrigin(coursePageHref, this.lastUrl);
    const courseId = coursePageUrl.searchParams.get("course_id") || coursePageUrl.searchParams.get("id");
    const enrolledIds = new Set((await this.listCourses()).courses.map(course => course.courseId).filter(Boolean));
    if (!courseId || !enrolledIds.has(courseId)) throw new Error("Test details can only be read from a course listed on your current Blackboard Courses tab.");
    const page = await this.getPage(coursePageHref);
    const tests = parseLinks(page._rawHtml, page._pageUrl).filter(link => link.kind === "test");
    const selected = testHref ? tests.filter(link => link.href === ensureSameOrigin(testHref, page._pageUrl).href) : tests;
    if (testHref && !selected.length) throw new Error("The supplied test link was not present on the provided course page; no test was opened.");
    return { coursePage: page.url, tests: selected, count: selected.length, note: "Read from the course content page only. This tool never opens a test launch URL, creates an attempt, or starts a timer." };
  }

  async listAnnouncements({ courseHref, courseYear, limit = 100, maxFoldersPerCourse = 1 } = {}) {
    const result = await this.scanCourseContent({ courseHref, courseYear, kind: "announcement", limit, maxFoldersPerCourse });
    return { ...result, note: "Announcement links are discovered on currently enrolled course pages. Blackboard may expose announcements through a separate tool or feed not linked from course content." };
  }

  async listUpcomingAssignments({ daysBack = 0, daysAhead = 365 } = {}) {
    await this.ensureAuthenticated();
    for (const [name, value] of [["daysBack", daysBack], ["daysAhead", daysAhead]]) {
      if (!Number.isInteger(value) || value < 0 || value > 3660) throw new Error(`${name} must be an integer from 0 to 3660.`);
    }

    const feed = await this.#readCalendarEventFeed({ daysBack, daysAhead });
    const { events, range } = feed;

    const assignments = events
      .filter(event => typeof event?.eventType === "string" && assignmentWords.test(event.eventType))
      .map(event => ({
        course: event.calendarNameLocalizable?.rawValue || event.calendarName || "",
        title: cleanText(event.title || "Без названия"),
        dueDate: typeof event.start === "string" ? event.start : null,
        eventType: event.eventType,
        attemptable: event.attemptable === true,
        submissionStatus: "not reported by the global calendar",
      }))
      .filter(event => event.dueDate)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, "ru"));

    return {
      source: "Blackboard global calendar",
      coursePagesRead: 0,
      courseFoldersRead: 0,
      calendarsWithEvents: new Set(events.map(event => event?.calendarId).filter(id => id && !["PERSONAL", "INSTITUTION"].includes(id))).size,
      calendarEvents: events.length,
      requestCount: feed.requestCount,
      cacheHit: feed.cacheHit,
      calendarContextCacheHit: feed.calendarContextCacheHit,
      totalAssignments: assignments.length,
      range,
      assignments,
      note: "Uses the same selected-calendar event feed as the Blackboard UI. Results follow the calendars currently selected in Blackboard settings and include due-dated assignment events only; the calendar does not report submission status or undated assignments. attemptable reflects Blackboard's calendar flag, not a verified submission state.",
    };
  }

  async getPage(input, { confirm = false } = {}) {
    await this.ensureAuthenticated();
    const url = ensureSameOrigin(input, this.lastUrl);
    if (!confirm && this.#isActionRoute(url)) throw new Error("This link can start an attempt or change enrollment. Call the dedicated tool with confirmed=true.");
    const page = await this.#readPage(url.href, { referer: this.lastUrl });
    const links = parseLinks(page.text, page.url);
    const forms = parseForms(page.text, page.url);
    return {
      url: `${new URL(page.url).origin}${new URL(page.url).pathname}`,
      title: page.title,
      text: cleanText(page.text).slice(0, 12000),
      links,
      forms: forms.map(describeForm),
      request: this.lastTrace?.request,
      _rawHtml: page.text,
      _forms: forms,
      _pageUrl: page.url,
    };
  }

  #isActionRoute(url) {
    return url.pathname === BB_ROUTES.enrollment || /(?:launch|take|start|begin|attempt)(?:assessment|test)|(?:assessment|test).*(?:launch|start|take|attempt)/i.test(`${url.pathname}?${url.searchParams.toString()}`);
  }

  async enrollCourse(href, confirmed) {
    if (!confirmed) return { confirmationRequired: true, method: "GET", path: ensureSameOrigin(href, this.lastUrl).pathname, message: "Set confirmed=true to send the enrollment request to Blackboard." };
    await this.ensureAuthenticated();
    const url = ensureSameOrigin(href, this.lastUrl);
    if (url.pathname !== BB_ROUTES.enrollment) throw new Error("The supplied URL is not a Blackboard enrollment link.");
    const page = await this.#readPage(url.href, { referer: this.lastUrl });
    this.coursesCache = null;
    this.contentIndexCache = null;
    return { status: page.response.status, url: `${new URL(page.url).origin}${new URL(page.url).pathname}`, title: page.title, text: cleanText(page.text).slice(0, 4000), request: this.lastTrace?.request };
  }

  async startTest(href, confirmed) {
    const url = ensureSameOrigin(href, this.lastUrl);
    if (!confirmed) return { confirmationRequired: true, method: "GET", path: url.pathname, message: "Set confirmed=true to open the test. This can create a timed attempt." };
    await this.ensureAuthenticated();
    const page = await this.#readPage(url.href, { referer: this.lastUrl });
    return { status: page.response.status, url: `${new URL(page.url).origin}${new URL(page.url).pathname}`, title: page.title, forms: parseForms(page.text, page.url).map(describeForm), text: cleanText(page.text).slice(0, 8000), request: this.lastTrace?.request, _rawHtml: page.text, _pageUrl: page.url };
  }

  async readNotifications(href) {
    await this.ensureAuthenticated();
    const traceStart = this.traceHistory.length;
    let target = href;
    if (!target) {
      const portal = await this.#readPage(`${BB_ROUTES.courseTab}?tab_tab_group_id=_1_1`);
      const link = parseLinks(portal.text, portal.url).find(item => item.kind === "activity");
      if (link) target = link.href;
      else target = BB_ROUTES.activityStream;
    }
    const page = await this.#readPage(ensureSameOrigin(target, this.lastUrl).href, { referer: this.lastUrl });
    let ews = null;
    if (new URL(page.url).pathname === BB_ROUTES.courseTab) ews = await this.#readEwsViewInfo(page);
    const dwr = ews ? { ews } : null;
    return {
      status: page.response.status,
      url: `${new URL(page.url).origin}${new URL(page.url).pathname}`,
      title: page.title,
      text: cleanText(page.text).slice(0, 12000),
      links: parseLinks(page.text, page.url).filter(link => link.kind === "activity" || link.kind === "course-content"),
      dwr,
      requests: this.traceHistory.slice(traceStart),
      note: dwr ? "DWR replies are parsed as inert data; they are never evaluated as JavaScript." : "No matching DWR dashboard script was present; returned the server-rendered page.",
    };
  }

  async #callDwrMethod(page, serviceName, methodName, buildRequest) {
    const scriptUrl = scriptSourceForDwr(page.text, page.url);
    if (!scriptUrl) return null;
    const engineResponse = await this.request(scriptUrl, { referer: page.url, headers: { Accept: "*/*" }, fetchMode: "no-cors" });
    if (!engineResponse.ok) throw new Error(`Blackboard DWR engine script returned HTTP ${engineResponse.status}.`);
    const engine = await engineResponse.text();
    const originalSessionId = engine.match(/dwr\.engine\._origScriptSessionId\s*=\s*(["'])([^"']+)\1/)?.[2];
    const sessionCookieName = engine.match(/dwr\.engine\._sessionCookieName\s*=\s*(["'])([^"']+)\1/)?.[2];
    if (!originalSessionId || !sessionCookieName) throw new Error("The live DWR engine did not provide its script-session settings.");
    const httpSessionId = this.transport.cookieValueFor?.(sessionCookieName, page.url) ?? this.transport.cookieValue(sessionCookieName);
    if (!httpSessionId) throw new Error("The Blackboard DWR session cookie is not available in this HTTP session.");
    const dwrBasePath = dwrBasePathForService(page.text, page.url, serviceName);
    if (!dwrBasePath) return null;
    const request = buildRequest({
      pageUrl: page.url,
      httpSessionId,
      scriptSessionId: `${originalSessionId}${Math.floor(Math.random() * 1000)}`,
      dwrBasePath,
      batchId: 0,
    });
    const response = await this.request(request.url, {
      method: request.method,
      body: request.body,
      contentType: request.contentType,
      referer: page.url,
      headers: { Accept: "*/*", Origin: BB_ORIGIN },
      fetchMode: "cors",
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Blackboard notifications DWR call returned HTTP ${response.status}.`);
    let reply;
    try { reply = parseDwrReply(responseText); }
    catch {
      reply = { serialized: true, text: responseText.slice(0, 12000), note: "Unrecognized DWR response; text is returned as inert data, never evaluated." };
    }
    return { method: `${serviceName}.${methodName}`, reply };
  }

  async #readEwsViewInfo(page) {
    return this.#callDwrMethod(page, "NautilusViewService", "getEwsViewInfo", buildDwrEwsViewInfoRequest);
  }

  async downloadFile(href, filename) {
    await this.ensureAuthenticated();
    const url = ensureSameOrigin(href, this.lastUrl);
    const response = await this.request(url.href, { referer: this.lastUrl, streaming: true });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`File request returned HTTP ${response.status}.`);
    }
    const safeName = path.basename(filename || decodeURIComponent(url.pathname.split("/").pop() || "download")) || "download";
    const target = path.join(this.downloadDir, safeName);
    await mkdir(this.downloadDir, { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
    return { savedTo: target, contentType: response.headers.get("content-type"), request: this.lastTrace?.request };
  }

  async submitForm({ page, formIndex, fields = {}, filePath, submitterName, confirmed = false }) {
    if (!page?._forms || !page?._pageUrl) throw new Error("Open the Blackboard form first with bb_open_page and pass its pageId.");
    const form = page._forms[formIndex];
    if (!form) throw new Error(`Form index ${formIndex} is not present on that page.`);
    const submitters = form.controls.filter(control => ["submit", "button"].includes(control.type) && !control.disabled);
    if (!submitterName && submitters.length > 1) {
      return {
        confirmationRequired: true,
        selectionRequired: "submitterName",
        method: form.method,
        action: new URL(form.action).pathname,
        submitters: submitters.map(({ name, label }) => ({ name, label })),
        message: "Choose which submit button the browser form should activate, then request the preview again. Nothing was sent.",
      };
    }
    const submission = await this.#serializeForm(form, fields, filePath, submitterName);
    const preview = { method: submission.method, url: `${new URL(submission.url).origin}${new URL(submission.url).pathname}`, contentType: submission.contentType.split(";")[0], fieldNames: submission.fieldNames, fileCount: filePath ? 1 : 0, submissionMode: "native HTML form semantics" };
    if (!confirmed) return { confirmationRequired: true, preview, message: "Set confirmed=true to send this form to Blackboard." };
    await this.ensureAuthenticated();
    const response = await this.request(submission.url, {
      method: submission.method,
      headers: { ...submission.headers, ...(submission.method === "POST" ? { Origin: BB_ORIGIN } : {}) },
      body: submission.body,
      contentType: submission.contentType,
      referer: page._pageUrl,
      fetchMode: "navigate",
      formFields: submission.fieldNames,
      fileCount: filePath ? 1 : 0,
    });
    const html = await response.text();
    const finalUrl = response.url || this.lastUrl;
    return { status: response.status, url: `${new URL(finalUrl).origin}${new URL(finalUrl).pathname}`, title: cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""), text: cleanText(html).slice(0, 6000), request: this.lastTrace?.request, submitted: preview };
  }

  async #serializeForm(form, changes, filePath, submitterName) {
    const known = new Set(form.controls.filter(control => control.name && control.type !== "hidden").map(control => control.name));
    for (const name of Object.keys(changes)) if (!known.has(name)) throw new Error(`Field ${name} is not an editable named field in the selected Blackboard form.`);
    const fileControls = form.controls.filter(control => control.type === "file" && control.name && !control.disabled);
    if (filePath && fileControls.length !== 1) throw new Error("File submission requires exactly one enabled file input in the selected form.");
    const submitters = form.controls.filter(control => ["submit", "button"].includes(control.type) && !control.disabled);
    let selectedSubmitter;
    if (submitterName) selectedSubmitter = submitters.find(control => control.name === submitterName);
    else if (submitters.length === 1) selectedSubmitter = submitters[0];
    if (submitterName && !selectedSubmitter) throw new Error(`Submit control ${submitterName} is not present in this form.`);
    if (submitters.length > 1 && !selectedSubmitter) throw new Error("Choose submitterName because this form has multiple submit buttons.");

    const values = [];
    for (const control of form.controls) {
      if (!control.name || control.disabled || ["button", "reset"].includes(control.type)) continue;
      if (control.type === "submit") { if (control === selectedSubmitter) values.push([control.name, control.value]); continue; }
      if (control.type === "file") {
        if (control === fileControls[0] && filePath) values.push([control.name, { filePath }]);
        continue;
      }
      if (control.type === "checkbox" || control.type === "radio") {
        if (Object.hasOwn(changes, control.name)) {
          const wanted = Array.isArray(changes[control.name]) ? changes[control.name].map(String) : [String(changes[control.name])];
          if (wanted.includes(control.value)) values.push([control.name, control.value]);
        } else if (control.checked) values.push([control.name, control.value]);
        continue;
      }
      if (control.tag === "select" && control.multiple) {
        const wanted = Object.hasOwn(changes, control.name) ? (Array.isArray(changes[control.name]) ? changes[control.name].map(String) : [String(changes[control.name])]) : control.value;
        for (const value of wanted) if (control.options.some(option => option.value === value)) values.push([control.name, value]);
        continue;
      }
      const value = Object.hasOwn(changes, control.name) ? changes[control.name] : control.tag === "select" ? control.value[0] ?? "" : control.value;
      if (Array.isArray(value)) for (const item of value) values.push([control.name, String(item)]);
      else values.push([control.name, String(value ?? "")]);
    }
    const url = new URL(form.action);
    const contentType = form.enctype;
    const method = form.method;
    let body;
    let outgoingContentType;
    if (method === "GET") {
      for (const [name, value] of values) if (typeof value === "string") url.searchParams.append(name, value);
    } else if (contentType === "multipart/form-data") {
      const multipart = await encodeBrowserMultipart(values);
      body = multipart.body;
      outgoingContentType = multipart.contentType;
    } else if (contentType === "text/plain") {
      const lines = values.filter(([, value]) => typeof value === "string").map(([name, value]) => `${name}=${value}`);
      body = lines.length ? `${lines.join("\r\n")}\r\n` : "";
      outgoingContentType = "text/plain";
    } else {
      body = new URLSearchParams(values.filter(([, value]) => typeof value === "string")).toString();
      outgoingContentType = "application/x-www-form-urlencoded";
    }
    return { method, url: url.href, body, contentType: outgoingContentType || (contentType === "multipart/form-data" ? "multipart/form-data" : contentType), headers: {}, fieldNames: [...new Set(values.map(([name]) => name))] };
  }
}

export function summarizePage(html, url) {
  return { title: cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""), links: parseLinks(html, url), forms: parseForms(html, url).map(describeForm), text: cleanText(html).slice(0, 12000) };
}

export function parseBlackboardLinks(html, url = BB_ORIGIN) {
  return parseLinks(html, url);
}
