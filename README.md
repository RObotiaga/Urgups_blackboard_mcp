# Urgups Blackboard MCP

Независимый Node.js SDK и MCP-сервер для учебного портала [bb.usurt.ru](https://bb.usurt.ru/), а также skill для разработки подобных интеграций по внутренним веб API. Blackboard-запросы выполняются отдельной HTTP-сессией; открытая вкладка и браузерный профиль для работы клиента не нужны.

## Содержание

- [Плагины](#плагины)
- [Возможности Blackboard MCP](#возможности-blackboard-mcp)
- [Установка](#установка)
  - [Локальный плагин](#локальный-плагин)
  - [Claude Code marketplace](#claude-code-marketplace)
  - [Проверка и настройка](#проверка-и-настройка)
- [Сопоставление с браузером](#сопоставление-с-браузером)
- [Skill для внутренних веб API](#skill-для-внутренних-веб-api)
- [Структура репозитория](#структура-репозитория)
- [Практики оформления skill и MCP](#практики-оформления-skill-и-mcp)

## Плагины

| Плагин | Назначение |
|---|---|
| [bb-usurt-mcp](plugins/bb-usurt-mcp) | SDK, MCP и skill для bb.usurt.ru |
| [internal-web-api-builder](plugins/internal-web-api-builder/skills/internal-web-api-builder/SKILL.md) | Переиспользуемый skill для разработки независимых SDK и MCP по наблюдаемым запросам веб-приложений |

## Возможности Blackboard MCP

- Проверка состояния сессии и вход через штатную форму Blackboard.
- Просмотр своих курсов, поиск курсов каталога и открытие курса.
- Просмотр материалов курса, папок, заданий и тестов.
- Чтение панели уведомлений и скачивание файлов.
- Зачисление, начало теста и отправка формы или файла. Перед записью инструмент показывает план; выполнение требует явного подтверждения.

### MCP-инструменты

| Инструменты | Действие |
|---|---|
| **bb_login**, **bb_status** | Вход и состояние отдельной HTTP-сессии |
| **bb_courses**, **bb_search_courses** | Список курсов и поиск по каталогу |
| **bb_open_course**, **bb_open_page**, **bb_list_course_items** | Курс, страницы, материалы и вложенные папки |
| **bb_read_notifications** | Чтение уведомлений Blackboard |
| **bb_download_file** | Скачивание файла по ссылке Blackboard |
| **bb_enroll_course** | План или подтверждённое зачисление |
| **bb_start_test** | План или подтверждённый запуск попытки |
| **bb_submit_form** | Просмотр формы либо подтверждённая отправка ответа или файла |

## Установка

Требуется Node.js 22 или новее. Единственная runtime-зависимость SDK — HTTPcloak; установи её через lock-файл командой npm ci.

### Локальный плагин

Локальный checkout — рекомендуемый путь: можно установить зависимость и хранить конфигурацию рядом с проектом.

~~~powershell
git clone https://github.com/RObotiaga/Urgups_blackboard_mcp.git
cd Urgups_blackboard_mcp/plugins/bb-usurt-mcp
npm ci
Copy-Item config/.env.example config/.env
~~~

Заполни config/.env в локальном редакторе, затем запусти плагин из его каталога:

~~~powershell
claude --plugin-dir .
~~~

Плагин предоставляет skill и MCP-сервер. В Claude Code инструменты будут иметь имена с префиксом плагина; точные имена указаны в таблице выше.

### Claude Code marketplace

Репозиторий включает marketplace-манифест:

~~~text
/plugin marketplace add RObotiaga/Urgups_blackboard_mcp
/plugin install bb-usurt-mcp@urgups-blackboard-mcp
/plugin install internal-web-api-builder@urgups-blackboard-mcp
~~~

Для запуска Blackboard MCP-сервера требуется Node.js 22+ и установленный пакет HTTPcloak. Установка плагина из marketplace сама по себе не выполняет npm ci; для локальной установки с готовыми зависимостями используй способ выше или настрой запуск сервера по инструкции в [README плагина](plugins/bb-usurt-mcp/README.md). Плагин internal-web-api-builder содержит инструкции и не требует npm-зависимостей.

### Проверка и настройка

Параметры входа хранятся локально в config/.env; не отправляй пароль в чат и не добавляй этот файл в Git. При первом запуске вызови bb_status, затем bb_login. Сервер не использует cookies открытого браузера.

Подробности авторизации, каталога загрузок и транспорта: [настройка подключения](plugins/bb-usurt-mcp/config/README.md).

Запуск standalone MCP-сервера из каталога плагина:

~~~powershell
npm start
~~~

Для подключения к другому MCP-хосту укажи команду node и аргумент src/mcp-server.js, используя абсолютный путь к каталогу плагина. Сервер читает локальный config/.env относительно своего файла.

## Сопоставление с браузером

Для поиска курсов SDK сначала загружает актуальную форму вкладки «Курсы», затем сверяет метод, URL, content type и байты тела с безопасным браузерным эталоном. SDK останавливается, если живая форма изменилась. Для DWR-уведомлений сопоставлены маршрут, тип содержимого, порядок полей и статические значения; session ID и параметры вкладки берутся из текущей сессии.

В тестовом браузерном снимке заголовки сверены только для начального GET страницы входа. Полная побайтовая идентичность HTTPS-сессии, TLS-отпечатка, порядка wire-заголовков и динамических значений не заявляется. Формы отправки файла и прохождения теста не были зафиксированы в снимке, поэтому эти маршруты используют только актуальные same-origin формы и не имеют подтверждённой побайтовой parity-сверки.

Безопасные эталоны и карта запросов: [captures](plugins/bb-usurt-mcp/captures) и [API_MAP.md](plugins/bb-usurt-mcp/skills/bb-usurt/references/API_MAP.md).

## Skill для внутренних веб API

[internal-web-api-builder](plugins/internal-web-api-builder/skills/internal-web-api-builder/SKILL.md) описывает маршрут от обследования UI и HAR/CDP до отдельного HTTP-клиента, MCP-инструментов и проверки запросов. Он содержит [справочник по захвату и сверке](plugins/internal-web-api-builder/skills/internal-web-api-builder/references/CAPTURE_PARITY.md), [рекомендации по устройству SDK/MCP/skill](plugins/internal-web-api-builder/skills/internal-web-api-builder/references/SDK_MCP_SKILL.md) и [шаблон матрицы доказательств](plugins/internal-web-api-builder/skills/internal-web-api-builder/assets/API_EVIDENCE_TEMPLATE.md).

Для локального запуска в Claude Code из корня checkout:

~~~powershell
claude --plugin-dir ./plugins/internal-web-api-builder
~~~

Каталог skill можно также скопировать в пользовательский каталог skills Codex. Для захвата трафика потребуется доступ к браузеру, HAR или другому источнику наблюдений; сам skill не запускает браузер.

## Структура репозитория

~~~text
.
├── .claude-plugin/
│   └── marketplace.json
├── docs/
│   └── author-skill-practices.md
└── plugins/
    ├── bb-usurt-mcp/
    │   ├── .claude-plugin/plugin.json
    │   ├── .mcp.json
    │   ├── config/
    │   ├── captures/
    │   ├── skills/bb-usurt/
    │   ├── src/
    │   └── test/
    └── internal-web-api-builder/
        ├── .claude-plugin/plugin.json
        └── skills/internal-web-api-builder/
~~~

## Практики оформления skill и MCP

Прочитанные рекомендации автора и их применение к этому проекту собраны в [docs/author-skill-practices.md](docs/author-skill-practices.md). Основные решения: skill ведёт по сценарию, MCP описывает операции, подробная API-карта загружается по необходимости, конфигурация и секреты отделены от инструкций, а изменяющие действия требуют предварительного плана и подтверждения.
