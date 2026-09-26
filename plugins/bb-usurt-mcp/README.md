# bb.usurt.ru SDK + MCP

Независимый Node.js SDK и MCP-сервер для Blackboard. Сервер отправляет обычные HTTPS-запросы из отдельной HTTP-сессии; Chromium, Playwright и открытая вкладка не используются.

## Возможности

| Инструмент | Действие |
|---|---|
| bb_login, bb_status | Вход и состояние сессии |
| bb_courses, bb_search_courses | Список и поиск курсов |
| bb_list_assignments | Доступные к отправке задания с курсами, сроками и статусами |
| bb_list_upcoming_assignments | Быстрый список заданий с датами из общего календаря Blackboard |
| bb_assignment_details, bb_list_my_submissions, bb_submit_assignment | Детали задания, доступный статус отправки, план/подтверждённая отправка |
| bb_open_course, bb_open_page, bb_list_course_items | Страницы курсов, папки и материалы |
| bb_search_course_files, bb_search_course_content | Поиск по названиям материалов только в разделах зачисленных курсов |
| bb_list_calendar_events, bb_read_grades, bb_test_details, bb_list_announcements | События календаря, оценки, ссылки на тесты без запуска, объявления из содержимого курсов |
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
const assignments = await bb.listAssignments({ courseYear: "2026" });
const upcoming = await bb.listUpcomingAssignments({ daysAhead: 365 });
~~~

`listUpcomingAssignments()` использует общий поток событий Blackboard Calendar: он читает список календарей и делает один запрос за заданиями в указанном диапазоне, не открывая курсы и папки. По умолчанию это задания с датой от сегодня до 365 дней вперёд. Календарь не сообщает статус отправки и не включает задания без срока.

`listAssignments()` остаётся подробным режимом: он обходит ссылки разделов выбранных курсов и читает страницы заданий, чтобы определить доступность формы отправки и статус сдачи. По умолчанию проверяется одна папка на курс; если `complete` равно false или есть warnings, ограничь область через `courseYear`/`courseHref` либо увеличь `maxFoldersPerCourse`. Для сроков без статусов сначала используй быстрый календарный список.

Для поиска материалов, файлов и объявлений используется один общий индекс ссылок, ограниченный одной папкой на курс по умолчанию и кэшируемый пять минут. Сначала используй `bb_search_course_content` и фильтруй его результаты; `courseYear` или `courseHref` заметно сужают обход. Для полного обхода увеличь `maxFoldersPerCourse` и проверь warnings. Список курсов кэшируется на 90 секунд, календарный контекст на 60 секунд, ответ календаря для того же диапазона на 15 секунд.

MCP и SDK используют тот же клиент. Для подключений к другому MCP-хосту укажи node как команду и абсолютный путь к src/mcp-server.js как аргумент. Каталог config/.env вычисляется относительно расположения SDK.

## Сопоставление с браузером

Список курсов читает параметры AJAX-запроса модуля «Список курсов» из текущей вкладки Blackboard и повторяет их с той же HTTP-сессией. Метод, endpoint и упорядоченное тело берутся из текущего ответа; wire-порядок заголовков этого запроса не зафиксирован.

Быстрый список заданий повторяет запрос календаря браузера к `calendarData/selectedCalendarEvents`: совпадают метод, путь, порядок query-параметров и сверенные значения `Accept`, `X-Requested-With`, User-Agent и Client Hints. На одинаковом диапазоне браузер и SDK получили HTTP 200, по четыре события и одинаковый набор полей JSON; порядок полей в JSON различался. Границы дат задаются MCP; cookies в снимок не попадают.

Каталог поиска загружает актуальную форму вкладки «Курсы» и перед отправкой сравнивает метод, URL, content type и тело с безопасным эталоном. Для панели уведомлений живая сверка подтвердила одинаковые маршрут, метод, content type, порядок полей, значения доступных заголовков и размер тела DWR (289 байт); cookie и значения текущей сессии не сохраняются.

Значения HTTP-заголовков сравнивались только на захваченном начальном GET формы входа. В браузерном снимке отсутствуют wire-порядок заголовков и полный транспортный захват поиска; TLS fingerprint профиля также отличается по версии Chrome. Поэтому полная идентичность HTTPS-сессии не заявляется. Страницы теста и формы загрузки файла в снимке нет; их запросы формируются по текущей same-origin форме.

Подробности: [captures/browser-observed.json](captures/browser-observed.json) и [карта API](skills/bb-usurt/references/API_MAP.md).
