export const BB_ORIGIN = "https://bb.usurt.ru";

export const BROWSER_HEADER_PROFILE = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "ru",
});

export const BB_ROUTES = Object.freeze({
  login: "/webapps/login/",
  courseTab: "/webapps/portal/execute/tabs/tabAction",
  catalog: "/webapps/blackboard/execute/viewCatalog",
  courseLauncher: "/webapps/blackboard/execute/launcher",
  courseMain: "/webapps/blackboard/execute/courseMain",
  contentList: "/webapps/blackboard/content/listContent.jsp",
  contentTool: "/webapps/blackboard/content/launchLink.jsp",
  enrollment: "/webapps/blackboard/execute/enrollCourse",
  myGrades: "/webapps/bb-mygrades-BBLEARN/myGrades",
  activityStream: "/webapps/streamViewer/streamViewer",
});

export function buildCourseSearchRequest(query, origin = BB_ORIGIN) {
  if (typeof query !== "string") throw new TypeError("Course search query must be a string.");
  return {
    method: "POST",
    url: new URL(BB_ROUTES.catalog, origin).href,
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams([
      ["type", "Course"],
      ["command", "NewSearch"],
      ["searchText", query],
    ]).toString(),
  };
}

export function canonicalRequest(request, origin = BB_ORIGIN) {
  const url = new URL(request.url, origin);
  const headers = request.headers ?? {};
  const contentType = request.contentType ?? headers["content-type"] ?? headers["Content-Type"] ?? "";
  return {
    method: String(request.method ?? "GET").toUpperCase(),
    url: url.href,
    contentType: String(contentType).split(";")[0].trim().toLowerCase(),
    body: request.body ?? "",
  };
}

export function compareRequestParity(actual, expected, origin = BB_ORIGIN) {
  const left = canonicalRequest(actual, origin);
  const right = canonicalRequest(expected, origin);
  const differences = [];
  for (const field of ["method", "url", "contentType", "body"]) {
    if (left[field] !== right[field]) differences.push({ field, actual: left[field], expected: right[field] });
  }
  return { ok: differences.length === 0, differences, actual: left, expected: right };
}

export function assertRequestParity(actual, expected, origin = BB_ORIGIN) {
  const result = compareRequestParity(actual, expected, origin);
  if (!result.ok) throw new Error(`Browser request mismatch in: ${result.differences.map(({ field }) => field).join(", ")}`);
  return result;
}
