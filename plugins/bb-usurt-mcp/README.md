# bb.usurt.ru SDK + MCP

Независимый Node.js SDK и MCP-сервер для Blackboard. Сервер отправляет обычные HTTPS-запросы из отдельной HTTP-сессии; Chromium, Playwright и открытая вкладка не используются.

## Возможности

| Инструмент | Действие |
|---|---|
| bb_login, bb_status | Вход и состояние сессии |
| bb_courses, bb_search_courses | Список и поиск курсов |
| bb_open_course, bb_open_page, bb_list_course_items | Страницы курсов, папки и материалы |
| bb_read_notifications | Чтение уведомлений |
| bb_download_file | Скачивание файла курса |
| bb_enroll_course | Просмотр плана или зачисление после подтверждения |
| bb_start_test | Просмотр плана или запуск попытки после подтверждения |
| bb_submit_form | Просмотр формы или отправка ответа/файла после подтверждения |

SDK экспортирует BbUsurtClient из src/index.js. MCP-сервер регистрирует те же операции, что описаны в SKILL.md и карте API.

## Запуск

Требуется Node.js 22+. HTTPcloak — единственная runtime-зависимость, она обеспечивает отдельный HTTP-транспорт с профилем Chrome; это не браузер и не запускает JS сайта.

Из этого каталога выполни:

~~~powershell
npm ci
Copy-Item config/.env.example config/.env
~~~

Заполни BB_USURT_USERNAME и BB_USURT_PASSWORD в config/.env локально, затем:

~~~powershell
npm start
~~~

Для Claude Code используй плагин из локального checkout после npm ci:

~~~powershell
claude --plugin-dir .
~~~

Файл .mcp.json использует CLAUDE_PLUGIN_ROOT и запускает src/mcp-server.js. При установке плагина из marketplace зависимости автоматически не устанавливаются; сначала выполни npm ci в каталоге установленного плагина либо используй локальный checkout.

Подробная настройка учётной записи и транспорта: [config/README.md](config/README.md). Пароль, cookies и локальный .env не добавляй в Git.

## SDK

~~~js
import { BbUsurtClient } from "./src/index.js";

const bb = new BbUsurtClient({
  username: process.env.BB_USURT_USERNAME,
  password: process.env.BB_USURT_PASSWORD,
});
await bb.login();
const courses = await bb.listCourses();
const results = await bb.searchCourses("2026");
~~~

MCP и SDK используют тот же клиент. Для подключений к другому MCP-хосту укажи node как команду и абсолютный путь к src/mcp-server.js как аргумент. Каталог config/.env вычисляется относительно расположения SDK.

## Сопоставление с браузером

Каталог поиска загружает актуальную форму вкладки «Курсы» и перед отправкой сравнивает метод, URL, content type и тело с безопасным эталоном. Для уведомлений DWR сверяются путь, content type, порядок полей и статические значения; параметры текущей сессии остаются динамическими.

Значения HTTP-заголовков сравнивались только на захваченном начальном GET формы входа. В браузерном снимке отсутствуют wire-порядок заголовков и полный транспортный захват поиска; TLS fingerprint профиля также отличается по версии Chrome. Поэтому полная идентичность HTTPS-сессии не заявляется. Страницы теста и формы загрузки файла в снимке нет; их запросы формируются по текущей same-origin форме.

Подробности: [captures/browser-observed.json](captures/browser-observed.json) и [карта API](skills/bb-usurt/references/API_MAP.md).
