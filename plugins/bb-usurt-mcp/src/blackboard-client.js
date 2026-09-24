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
    else if ([BB_ROUTES.contentList, BB_ROUTES.contentTool].includes(route)) kind = "course-content";
    result.push({ kind, label, href: url.href, path: url.pathname });
  }
  return result;
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

export function buildDwrToolActivityRequest({ pageUrl, httpSessionId, scriptSessionId, batchId = 0, dwrBasePath = "/webapps/portal/dwr_open" }) {
  return buildDwrRequest({ pageUrl, httpSessionId, scriptSessionId, serviceName: "ToolActivityService", methodName: "getActivityForAllTools", dwrBasePath, batchId });
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
    return { authenticated: true, url: `${new URL(checkUrl).origin}${new URL(checkUrl).pathname}`, title: cleanText(checkHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") };
  }

  async ensureAuthenticated() {
    if (this.authenticated) return;
    if (!this.username || !this.password) throw new Error("Authentication is not initialized. Configure BB_USURT_USERNAME and BB_USURT_PASSWORD, then call bb_login.");
    await this.login();
  }

  async listCourses() {
    await this.ensureAuthenticated();
    const page = await this.#readPage(`${BB_ROUTES.courseTab}?tab_tab_group_id=_1_1`);
    const courses = parseLinks(page.text, page.url)
      .filter(link => link.kind === "course")
      .map(link => ({ ...link, courseId: new URL(link.href).searchParams.get("id") }));
    return { url: `${new URL(page.url).origin}${new URL(page.url).pathname}`, title: page.title, courses, request: this.lastTrace?.request };
  }

  async #readCatalogFormPage() {
    const portal = await this.#readPage(`${BB_ROUTES.courseTab}?tab_tab_group_id=_1_1`);
    const coursesTab = parseLinks(portal.text, portal.url).find(link =>
      link.path === BB_ROUTES.courseTab && /(?:^|\s)курсы(?:\s|$)/i.test(link.label),
    );
    if (!coursesTab) throw new Error("Could not find the live Blackboard Courses tab that contains the catalog form.");
    if (new URL(coursesTab.href).href === new URL(portal.url).href) return portal;
    return this.#readPage(coursesTab.href, { referer: portal.url });
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
    const courses = parseLinks(html, url).filter(link => link.kind === "course").map(link => ({ ...link, courseId: new URL(link.href).searchParams.get("id") }));
    return { status: response.status, url: `${new URL(url).origin}${new URL(url).pathname}`, title: cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""), courses, request: this.lastTrace?.request, browserParity: "Method, URL, content type and form body match the live Courses-tab form; body parity is byte-for-byte." };
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
    return url.pathname === BB_ROUTES.enrollment || /(?:take|start|begin|attempt|launch)test|assessment.*(?:start|take|attempt)/i.test(`${url.pathname}?${url.searchParams.toString()}`);
  }

  async enrollCourse(href, confirmed) {
    if (!confirmed) return { confirmationRequired: true, method: "GET", path: ensureSameOrigin(href, this.lastUrl).pathname, message: "Set confirmed=true to send the enrollment request to Blackboard." };
    await this.ensureAuthenticated();
    const url = ensureSameOrigin(href, this.lastUrl);
    if (url.pathname !== BB_ROUTES.enrollment) throw new Error("The supplied URL is not a Blackboard enrollment link.");
    const page = await this.#readPage(url.href, { referer: this.lastUrl });
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
    let portalActivity = null;
    if (!target) {
      const portal = await this.#readPage(`${BB_ROUTES.courseTab}?tab_tab_group_id=_1_1`);
      portalActivity = await this.#readToolActivity(portal);
      const link = parseLinks(portal.text, portal.url).find(item => item.kind === "activity");
      if (link) target = link.href;
      else target = BB_ROUTES.activityStream;
    }
    const page = await this.#readPage(ensureSameOrigin(target, this.lastUrl).href, { referer: this.lastUrl });
    let ews = null;
    if (new URL(page.url).pathname === BB_ROUTES.courseTab) ews = await this.#readEwsViewInfo(page);
    const dwr = portalActivity || ews ? { toolActivity: portalActivity, ews } : null;
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

  async #readToolActivity(page) {
    return this.#callDwrMethod(page, "ToolActivityService", "getActivityForAllTools", buildDwrToolActivityRequest);
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
