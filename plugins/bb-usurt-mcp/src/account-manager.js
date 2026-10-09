import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BbUsurtClient } from "./blackboard-client.js";
import { HttpCloakTransport } from "./httpcloak-transport.js";
import { BB_ORIGIN } from "./protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

export function normalizeTitle(title = "") {
  return String(title)
    .toLowerCase()
    .replace(/[«»""''`]/g, "")
    .replace(/№/g, " ")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCourse(course = "") {
  return String(course)
    .toLowerCase()
    .replace(/^\d{4}[_\s-]+\d+[:\s]*/, "")
    .replace(/[«»""''`]/g, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractContentId(href = "") {
  try {
    return new URL(href, BB_ORIGIN).searchParams.get("content_id") || null;
  } catch {
    return null;
  }
}

export function matchAssignments(list1 = [], list2 = []) {
  const matchedPairs = [];
  const unmatched1 = [];
  const remaining2 = [...list2];

  for (const item1 of list1) {
    const contentId1 = extractContentId(item1.href);
    const courseId1 = item1.courseId;

    let matchIdx = -1;

    // 1. Try exact content_id + courseId match
    if (contentId1 && courseId1) {
      matchIdx = remaining2.findIndex(item2 => {
        const cId2 = extractContentId(item2.href);
        const crsId2 = item2.courseId;
        return cId2 === contentId1 && crsId2 === courseId1;
      });
    }

    // 2. Try exact content_id match
    if (matchIdx === -1 && contentId1) {
      matchIdx = remaining2.findIndex(item2 => extractContentId(item2.href) === contentId1);
    }

    // 3. Fallback: match by normalized title and course
    if (matchIdx === -1) {
      const normTitle1 = normalizeTitle(item1.title);
      const normCourse1 = normalizeCourse(item1.course);
      matchIdx = remaining2.findIndex(item2 => {
        const normTitle2 = normalizeTitle(item2.title);
        const normCourse2 = normalizeCourse(item2.course);
        return normTitle1 && normTitle1 === normTitle2 && normCourse1 === normCourse2;
      });
    }

    // 4. Fallback: match by normalized title alone if uniquely matched
    if (matchIdx === -1) {
      const normTitle1 = normalizeTitle(item1.title);
      const candidates = remaining2
        .map((item2, idx) => ({ item2, idx }))
        .filter(({ item2 }) => normalizeTitle(item2.title) === normTitle1);
      if (candidates.length === 1) {
        matchIdx = candidates[0].idx;
      }
    }

    if (matchIdx !== -1) {
      const [item2] = remaining2.splice(matchIdx, 1);
      matchedPairs.push({ item1, item2 });
    } else {
      unmatched1.push(item1);
    }
  }

  const unmatched2 = remaining2;
  return { matchedPairs, unmatched1, unmatched2 };
}

export class AccountManager {
  constructor({
    accounts = [],
    defaultAccount = null,
    downloadDir = process.env.BB_USURT_DOWNLOAD_DIR || path.join(packageRoot, "downloads"),
    transportFactory = () => new HttpCloakTransport(),
  } = {}) {
    this.downloadDir = downloadDir;
    this.transportFactory = transportFactory;
    this.accounts = new Map();
    this.activeAccountId = null;
    this.fallbackClient = null;

    if (Array.isArray(accounts)) {
      for (const entry of accounts) this.addAccount(entry);
    } else if (accounts && typeof accounts === "object") {
      for (const [id, entry] of Object.entries(accounts)) {
        this.addAccount({ id, ...entry });
      }
    }

    if (defaultAccount && this.hasAccount(defaultAccount)) {
      this.setActiveAccount(defaultAccount);
    } else if (this.accounts.size > 0 && !this.activeAccountId) {
      this.activeAccountId = this.accounts.keys().next().value;
    }
  }

  static fromConfig({
    env = process.env,
    configDir = path.join(packageRoot, "config"),
    downloadDir = env.BB_USURT_DOWNLOAD_DIR || path.join(packageRoot, "downloads"),
    transportFactory = () => new HttpCloakTransport(),
  } = {}) {
    const manager = new AccountManager({ downloadDir, transportFactory });

    // 1. Check accounts.json / .accounts.json
    for (const filename of ["accounts.json", ".accounts.json"]) {
      const filePath = path.join(configDir, filename);
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, "utf8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item && item.username) {
                manager.addAccount({
                  id: item.id || item.username,
                  username: item.username,
                  password: item.password,
                  recordBook: item.recordBook,
                  downloadDir: item.downloadDir,
                });
              }
            }
          } else if (parsed && typeof parsed === "object") {
            for (const [id, item] of Object.entries(parsed)) {
              if (item && item.username) {
                manager.addAccount({
                  id: item.id || id,
                  username: item.username,
                  password: item.password,
                  recordBook: item.recordBook,
                  downloadDir: item.downloadDir,
                });
              }
            }
          }
        } catch (error) {
          console.error(`Не удалось прочитать ${filePath}:`, error.message);
        }
      }
    }

    // 2. Check BB_ACCOUNTS / BB_USURT_ACCOUNTS environment variable (JSON string)
    const jsonEnv = env.BB_ACCOUNTS || env.BB_USURT_ACCOUNTS;
    if (jsonEnv) {
      try {
        const parsed = JSON.parse(jsonEnv);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.username) {
              manager.addAccount({
                id: item.id || item.username,
                username: item.username,
                password: item.password,
                recordBook: item.recordBook,
              });
            }
          }
        } else if (parsed && typeof parsed === "object") {
          for (const [id, item] of Object.entries(parsed)) {
            if (item && item.username) {
              manager.addAccount({
                id: item.id || id,
                username: item.username,
                password: item.password,
                recordBook: item.recordBook,
              });
            }
          }
        }
      } catch (error) {
        console.error("Не удалось разобрать BB_ACCOUNTS:", error.message);
      }
    }

    // 3. Scan environment variables matching BB_ACCOUNT_<NAME>_USERNAME
    for (const key of Object.keys(env)) {
      const match = key.match(/^BB_ACCOUNT_([A-Za-z0-9_]+)_USERNAME$/i);
      if (match) {
        const rawId = match[1];
        const accountId = rawId.toLowerCase();
        const username = env[key];
        const passKey = Object.keys(env).find(k => k.toLowerCase() === `bb_account_${accountId}_password`);
        const password = passKey ? env[passKey] : "";
        const recKey = Object.keys(env).find(k => k.toLowerCase() === `bb_account_${accountId}_record_book`);
        const recordBook = recKey ? env[recKey] : undefined;
        if (username) {
          manager.addAccount({ id: accountId, username, password, recordBook });
        }
      }
    }

    // 4. Check legacy BB_USURT_USERNAME / BB_USURT_PASSWORD
    if (env.BB_USURT_USERNAME && env.BB_USURT_PASSWORD) {
      const legacyUsername = env.BB_USURT_USERNAME;
      const alreadyRegistered = [...manager.accounts.values()].some(
        acc => acc.username.toLowerCase() === legacyUsername.toLowerCase()
      );
      if (!alreadyRegistered && !manager.hasAccount("default")) {
        manager.addAccount({
          id: "default",
          username: legacyUsername,
          password: env.BB_USURT_PASSWORD,
          recordBook: env.BB_USURT_RECORD_BOOK,
        });
      }
    }

    // 5. Select default active account
    const preferredDefault = env.BB_USURT_DEFAULT_ACCOUNT || env.BB_DEFAULT_ACCOUNT;
    if (preferredDefault && manager.hasAccount(preferredDefault)) {
      manager.setActiveAccount(preferredDefault);
    } else if (manager.hasAccount("default")) {
      manager.setActiveAccount("default");
    } else if (manager.accounts.size > 0 && !manager.activeAccountId) {
      manager.activeAccountId = manager.accounts.keys().next().value;
    }

    return manager;
  }

  get size() {
    return this.accounts.size;
  }

  hasAccount(identifier) {
    return Boolean(this.getAccount(identifier));
  }

  addAccount({ id, username, password, recordBook, transport, client, downloadDir }) {
    const rawId = String(id || username || "default").trim();
    if (!rawId) throw new Error("Укажите идентификатор или логин аккаунта.");
    const key = rawId.toLowerCase();

    const effectiveRecordBook =
      recordBook ||
      client?.recordBook ||
      (username && /^\d{5,12}$/.test(String(username).trim()) ? String(username).trim() : null);

    const effectiveClient =
      client ??
      new BbUsurtClient({
        username,
        password,
        recordBook: effectiveRecordBook,
        downloadDir: downloadDir || this.downloadDir,
        transport: transport ?? this.transportFactory(),
      });

    const entry = {
      id: rawId,
      username: username || effectiveClient.username || rawId,
      recordBook: effectiveRecordBook,
      client: effectiveClient,
    };

    this.accounts.set(key, entry);

    if (!this.activeAccountId) {
      this.activeAccountId = rawId;
    }

    return entry;
  }

  getRecordBook(identifier) {
    const entry = this.getAccount(identifier);
    if (entry?.recordBook) return entry.recordBook;
    if (entry?.username && /^\d{5,12}$/.test(String(entry.username).trim())) {
      return String(entry.username).trim();
    }
    const envVal = process.env.BB_USURT_RECORD_BOOK;
    if (envVal && (!identifier || identifier === "default" || identifier === this.activeAccountId)) {
      return envVal.trim();
    }
    return null;
  }

  getAccount(identifier) {
    if (!identifier) {
      if (this.activeAccountId) {
        return this.accounts.get(this.activeAccountId.toLowerCase()) || null;
      }
      if (this.accounts.size === 1) {
        return this.accounts.values().next().value || null;
      }
      return null;
    }

    const key = String(identifier).trim().toLowerCase();
    if (this.accounts.has(key)) return this.accounts.get(key);

    for (const entry of this.accounts.values()) {
      if (entry.username.toLowerCase() === key) return entry;
    }

    return null;
  }

  getClient(identifier) {
    const entry = this.getAccount(identifier);
    if (entry) return entry.client;

    if (identifier) {
      const available = this.listAccountIds().join(", ") || "отсутствуют";
      throw new Error(`Аккаунт "${identifier}" не найден. Доступные аккаунты: [${available}].`);
    }

    if (this.accounts.size === 0) {
      if (!this.fallbackClient) {
        this.fallbackClient = new BbUsurtClient({
          downloadDir: this.downloadDir,
          transport: this.transportFactory(),
        });
      }
      return this.fallbackClient;
    }

    const available = this.listAccountIds().join(", ") || "отсутствуют";
    throw new Error(`Активный аккаунт не выбран. Укажи аргумент account или выбери активный через bb_switch_account. Доступные аккаунты: [${available}].`);
  }

  getActiveAccount() {
    return this.getAccount(this.activeAccountId);
  }

  setActiveAccount(identifier) {
    const entry = this.getAccount(identifier);
    if (!entry) {
      const available = this.listAccountIds().join(", ") || "отсутствуют";
      throw new Error(`Невозможно переключить на аккаунт "${identifier}": аккаунт не найден. Доступные аккаунты: [${available}].`);
    }
    this.activeAccountId = entry.id;
    return {
      success: true,
      activeAccount: entry.id,
      username: entry.username,
      message: `Активный аккаунт переключён на "${entry.id}" (${entry.username}).`,
    };
  }

  listAccountIds() {
    return [...this.accounts.values()].map(a => a.id);
  }

  getAccountId(client) {
    for (const entry of this.accounts.values()) {
      if (entry.client === client) return entry.id;
    }
    return null;
  }

  listAccountsSummary() {
    const active = this.getActiveAccount();
    return {
      activeAccount: active?.id ?? null,
      totalAccounts: this.accounts.size,
      accounts: [...this.accounts.values()].map(acc => ({
        id: acc.id,
        username: acc.username,
        authenticated: acc.client.authenticated,
        isActive: acc.id.toLowerCase() === (active?.id || "").toLowerCase(),
      })),
    };
  }

  async loginAll() {
    if (this.accounts.size === 0) {
      throw new Error("Нет настроенных аккаунтов Blackboard. Настройте config/.env или config/accounts.json.");
    }
    const results = [];
    for (const entry of this.accounts.values()) {
      try {
        const res = await entry.client.login();
        results.push({
          id: entry.id,
          username: entry.username,
          authenticated: true,
          status: "ok",
          url: res.url,
          title: res.title,
        });
      } catch (err) {
        results.push({
          id: entry.id,
          username: entry.username,
          authenticated: false,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      total: this.accounts.size,
      successful: results.filter(r => r.authenticated).length,
      results,
    };
  }

  async compareSubmissions({
    account1,
    account2,
    courseYear,
    courseHref,
    maxFoldersPerCourse = 1,
    limit = 500,
  } = {}) {
    if (!account1 || !account2) {
      throw new Error("Укажите оба аккаунта для сравнения (account1 и account2).");
    }

    const acc1 = this.getAccount(account1);
    const acc2 = this.getAccount(account2);
    if (!acc1) {
      throw new Error(`Аккаунт account1="${account1}" не найден. Доступные: [${this.listAccountIds().join(", ")}].`);
    }
    if (!acc2) {
      throw new Error(`Аккаунт account2="${account2}" не найден. Доступные: [${this.listAccountIds().join(", ")}].`);
    }
    if (acc1.id.toLowerCase() === acc2.id.toLowerCase()) {
      throw new Error("Для сравнения заданий укажите два разных аккаунта.");
    }

    const client1 = acc1.client;
    const client2 = acc2.client;

    await client1.ensureAuthenticated();
    await client2.ensureAuthenticated();

    const [res1, res2] = await Promise.all([
      client1.listAssignments({ courseYear, courseHref, availableOnly: false, limit, maxFoldersPerCourse }),
      client2.listAssignments({ courseYear, courseHref, availableOnly: false, limit, maxFoldersPerCourse }),
    ]);

    const list1 = res1.assignments || [];
    const list2 = res2.assignments || [];

    const { matchedPairs, unmatched1, unmatched2 } = matchAssignments(list1, list2);

    const needsSubmissionByAccount2 = [];
    const needsSubmissionByAccount1 = [];
    const bothSubmitted = [];
    const neitherSubmitted = [];

    for (const { item1, item2 } of matchedPairs) {
      const isSub1 = item1.submissionStatus === "submitted";
      const isSub2 = item2.submissionStatus === "submitted";

      if (isSub1 && !isSub2) {
        needsSubmissionByAccount2.push({
          title: item2.title || item1.title,
          course: item2.course || item1.course,
          courseId: item2.courseId || item1.courseId,
          dueDate: item2.dueDate || item1.dueDate,
          dueDateLabel: item2.dueDateLabel || item1.dueDateLabel,
          account1Status: item1.submissionStatus,
          account2Status: item2.submissionStatus,
          account2CanSubmit: item2.canSubmit,
          account2Href: item2.href,
          account1Href: item1.href,
        });
      } else if (!isSub1 && isSub2) {
        needsSubmissionByAccount1.push({
          title: item1.title || item2.title,
          course: item1.course || item2.course,
          courseId: item1.courseId || item2.courseId,
          dueDate: item1.dueDate || item2.dueDate,
          dueDateLabel: item1.dueDateLabel || item2.dueDateLabel,
          account1Status: item1.submissionStatus,
          account2Status: item2.submissionStatus,
          account1CanSubmit: item1.canSubmit,
          account1Href: item1.href,
          account2Href: item2.href,
        });
      } else if (isSub1 && isSub2) {
        bothSubmitted.push({
          title: item1.title,
          course: item1.course,
          courseId: item1.courseId,
          dueDate: item1.dueDate,
          dueDateLabel: item1.dueDateLabel,
          account1Href: item1.href,
          account2Href: item2.href,
        });
      } else {
        neitherSubmitted.push({
          title: item2.title || item1.title,
          course: item2.course || item1.course,
          courseId: item2.courseId || item1.courseId,
          dueDate: item2.dueDate || item1.dueDate,
          dueDateLabel: item2.dueDateLabel || item1.dueDateLabel,
          account1CanSubmit: item1.canSubmit,
          account2CanSubmit: item2.canSubmit,
          account1Href: item1.href,
          account2Href: item2.href,
        });
      }
    }

    const onlyInAccount1 = unmatched1.map(item => ({
      title: item.title,
      course: item.course,
      courseId: item.courseId,
      dueDate: item.dueDate,
      dueDateLabel: item.dueDateLabel,
      submissionStatus: item.submissionStatus,
      canSubmit: item.canSubmit,
      href: item.href,
    }));

    const onlyInAccount2 = unmatched2.map(item => ({
      title: item.title,
      course: item.course,
      courseId: item.courseId,
      dueDate: item.dueDate,
      dueDateLabel: item.dueDateLabel,
      submissionStatus: item.submissionStatus,
      canSubmit: item.canSubmit,
      href: item.href,
    }));

    const acc1SubmittedCount = list1.filter(a => a.submissionStatus === "submitted").length;
    const acc2SubmittedCount = list2.filter(a => a.submissionStatus === "submitted").length;

    const summaryText =
      `Сравнение аккаунтов "${acc1.id}" и "${acc2.id}": ` +
      `у "${acc1.id}" отправлено ${acc1SubmittedCount} из ${list1.length} заданий, ` +
      `у "${acc2.id}" отправлено ${acc2SubmittedCount} из ${list2.length} заданий. ` +
      `Найдено ${needsSubmissionByAccount2.length} заданий, отправленных у "${acc1.id}", но НЕ отправленных у "${acc2.id}" (требуют отправки). ` +
      `Найдено ${needsSubmissionByAccount1.length} заданий, отправленных у "${acc2.id}", но НЕ отправленных у "${acc1.id}".`;

    return {
      summary: summaryText,
      account1: {
        id: acc1.id,
        username: acc1.username,
        totalAssignments: list1.length,
        submittedCount: acc1SubmittedCount,
        notSubmittedCount: list1.length - acc1SubmittedCount,
      },
      account2: {
        id: acc2.id,
        username: acc2.username,
        totalAssignments: list2.length,
        submittedCount: acc2SubmittedCount,
        notSubmittedCount: list2.length - acc2SubmittedCount,
      },
      needsSubmissionByAccount2,
      needsSubmissionByAccount1,
      bothSubmitted,
      neitherSubmitted,
      onlyInAccount1,
      onlyInAccount2,
      warnings: [...(res1.warnings || []), ...(res2.warnings || [])],
    };
  }

  close() {
    for (const entry of this.accounts.values()) {
      try {
        entry.client.close();
      } catch {}
    }
    if (this.fallbackClient) {
      try {
        this.fallbackClient.close();
      } catch {}
    }
  }
}
