import { Readable } from "node:stream";
import { Session } from "httpcloak";
import { BROWSER_HEADER_PROFILE } from "./protocol.js";

function headerEntries(headers = {}) {
  return Object.entries(headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.map(String) : [String(value)]]);
}

class ResponseHeaders {
  #values;

  constructor(headers = {}) {
    this.#values = new Map(headerEntries(headers));
  }

  get(name) {
    const values = this.#values.get(String(name).toLowerCase());
    return values?.join(", ") ?? null;
  }

  getSetCookie() {
    return [...(this.#values.get("set-cookie") ?? [])];
  }
}

function streamBody(stream) {
  const chunks = (async function* () {
    try {
      for await (const chunk of stream) yield chunk;
    } finally {
      stream.close();
    }
  })();
  return Readable.toWeb(Readable.from(chunks));
}

function requestFetchHeaders(headers, fetchMode, url) {
  if (!fetchMode) return headers;
  const next = { ...headers };
  const setIfMissing = (name, value) => {
    if (!Object.keys(next).some(key => key.toLowerCase() === name.toLowerCase())) next[name] = value;
  };
  const referer = Object.entries(next).find(([name]) => name.toLowerCase() === "referer")?.[1];
  let site = "none";
  if (referer) {
    try { site = new URL(referer).origin === new URL(url).origin ? "same-origin" : "cross-site"; }
    catch { site = "none"; }
  }
  setIfMissing("Sec-Fetch-Site", site);
  setIfMissing("Sec-Fetch-Mode", fetchMode);
  const destination = fetchMode === "navigate" ? "document" : fetchMode === "no-cors" ? "script" : "empty";
  setIfMissing("Sec-Fetch-Dest", destination);
  if (fetchMode === "navigate") {
    setIfMissing("Sec-Fetch-User", "?1");
    setIfMissing("Upgrade-Insecure-Requests", "1");
  }
  return next;
}

export class HttpCloakResponse {
  constructor(response, { streaming = false } = {}) {
    this.status = response.statusCode;
    this.statusText = response.reason ?? "";
    this.ok = response.ok ?? (this.status >= 200 && this.status < 300);
    this.url = response.finalUrl ?? response.url ?? "";
    this.protocol = response.protocol ?? "";
    this.headers = new ResponseHeaders(response.headers);
    this.body = streaming
      ? streamBody(response)
      : Readable.toWeb(Readable.from(response.body?.length ? [response.body] : []));
    this.response = response;
    this.streaming = streaming;
  }

  async text() {
    if (!this.streaming) return this.response.text ?? this.response.body?.toString("utf8") ?? "";
    const chunks = [];
    for await (const chunk of this.response) chunks.push(chunk);
    this.response.close();
    return Buffer.concat(chunks).toString("utf8");
  }
}

export class HttpCloakTransport {
  constructor({
    session,
    preset = process.env.BB_USURT_BROWSER_PROFILE || "chrome-152-windows",
    httpVersion = process.env.BB_USURT_HTTP_VERSION || "h1",
  } = {}) {
    this.preset = preset;
    this.httpVersion = httpVersion;
    this.session = session ?? new Session({
      preset,
      httpVersion,
      allowRedirects: false,
      maxRedirects: 10,
      retry: 0,
      verify: true,
    });
    this.session.headers = { ...(this.session.headers ?? {}), ...BROWSER_HEADER_PROFILE };
  }

  get info() {
    return {
      name: "httpcloak",
      preset: this.preset,
      httpVersion: this.httpVersion,
      userAgent: this.session.headers?.["User-Agent"] ?? "",
      headerOrder: this.session.getHeaderOrder?.() ?? [],
    };
  }

  headersForRequest(headers = {}, fetchMode = "navigate", url) {
    return { ...(this.session.headers ?? {}), ...requestFetchHeaders(headers, fetchMode, url) };
  }

  async request(url, {
    method = "GET",
    headers = {},
    body,
    fetchMode = "navigate",
    allowRedirects = false,
    streaming = false,
  } = {}) {
    const options = {
      headers: requestFetchHeaders(headers, fetchMode, url),
      fetchMode,
      allowRedirects,
      disableConditionalCache: true,
    };
    if (body !== undefined) options.body = body;

    const response = streaming
      ? this.session.requestStream(method, url, options)
      : await this.session.request(method, url, options);
    return new HttpCloakResponse(response, { streaming });
  }

  cookieValue(name) {
    return this.session.getCookie?.(name)?.value ?? "";
  }

  cookieValueFor(name, url) {
    const target = new URL(url);
    const cookies = this.session.getCookiesDetailed?.();
    if (!Array.isArray(cookies)) return this.cookieValue(name);
    const cookie = cookies.find(item => {
      const domain = String(item.domain || "").replace(/^\./, "").toLowerCase();
      const domainMatches = !domain || target.hostname === domain || target.hostname.endsWith(`.${domain}`);
      const cookiePath = item.path || "/";
      const pathMatches = target.pathname === cookiePath || target.pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
      const secureMatches = !item.secure || target.protocol === "https:";
      return item.name === name && domainMatches && pathMatches && secureMatches;
    });
    return cookie?.value ?? "";
  }

  clearCookies() {
    this.session.clearCookies();
  }

  close() {
    this.session.close();
  }
}
