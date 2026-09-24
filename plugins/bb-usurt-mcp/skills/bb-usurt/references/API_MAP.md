# Карта Blackboard API

Это карта наблюдавшихся запросов `https://bb.usurt.ru`. Значения пользовательских
идентификаторов, cookies, nonce, тело DWR-вызовов и данные учётной записи в
снимок не включены.

## Проверенный запрос поиска

| Действие | Метод | Путь | Тело |
|---|---|---|---|
| Источник живой формы на вкладке «Курсы» | `GET` | `/webapps/portal/execute/tabs/tabAction` | Параметр вкладки динамический |
| Поиск курсов | `POST` | `/webapps/blackboard/execute/viewCatalog` | `type=Course&command=NewSearch&searchText=...` |

В `captures/browser-observed.json` сохранена только безопасная форма запроса
`searchText=2026`. Поля были прочитаны из `FormData` живой формы при клике по
штатной кнопке вкладки «Курсы». SDK загружает эту форму, сохраняет порядок
полей и побайтно сверяет тело, URL, метод и `content type` перед отправкой.
Значения динамической вкладки и поля поиска в снимок не заносятся.

## Наблюдавшиеся маршруты

| Действие | Метод | Путь | Примечание |
|---|---|---|---|
| Список курсов | `GET` | `/webapps/portal/execute/tabs/tabAction` | Параметр `tab_tab_group_id` |
| Открытие курса | `GET` | `/webapps/blackboard/execute/launcher` | Используй живой href курса |
| Главная курса | `GET` | `/webapps/blackboard/execute/courseMain` | Blackboard перенаправляет по ссылке курса |
| Содержимое курса | `GET` | `/webapps/blackboard/content/listContent.jsp` | Используй href папки/раздела |
| Инструмент курса | `GET` | `/webapps/blackboard/content/launchLink.jsp` | Используй href из курса |
| Страница задания | `GET` | `/webapps/assignment/uploadAssignment` | Требуются текущие `content_id`, `course_id`, `group_id`, `mode` |
| Файл курса | `GET` | `/bbcswebdav/pid-<content-id>-dt-content-rid-<file-id>_1/xid-<file-id>_1` | Используй живой href из материала |
| Файл попытки задания | `GET` | `/webapps/assignment/download` | Параметры берутся из живой ссылки |
| Мои оценки | `GET` | `/webapps/bb-mygrades-BBLEARN/myGrades` | Требуются актуальные параметры курса |
| Activity Stream | `GET` | `/webapps/streamViewer/streamViewer` | Динамические параметры берутся из живой ссылки |
| Панель уведомлений | `GET` | `/webapps/portal/execute/tabs/tabAction` | Href с `tabId` и `tab_tab_group_id` берётся из живой ссылки |
| Уведомления DWR | `POST` | `/webapps/portal/dwr_open/call/plaincall/NautilusViewService.getEwsViewInfo.dwr` | `text/plain`; `page` содержит адрес панели с query, session IDs генерируются из текущей сессии |
| Зачисление | `GET` | `/webapps/blackboard/execute/enrollCourse` | Выполняй только после подтверждения |

Список заданий, тестов, файлов и форм строится по актуальным ссылкам и HTML.
Формы отправляются с их текущим action, method, enctype, порядком controls и
скрытыми значениями. Multipart сериализуется в порядке полей HTML; граница
генерируется заново с префиксом WebKit, поэтому полное тело загрузки зависит от
имени файла, содержимого и случайной границы.

## Границы проверки

Для поиска побайтно сопоставлены тело живой формы и SDK; полного wire-снимка
заголовков этой отправки нет. Для DWR сравниваются маршрут, метод, content type,
порядок и статические поля; session ID, script session ID и параметры вкладки
получаются из свежих ответов Blackboard. Начальная страница входа сверена по
значениям заголовков; CDP sample не сохраняет wire-порядок.

Маршрут чтения и скачивания файлов наблюдался в браузере. Тестовая форма и
форма загрузки файла не были доступны в проверенной странице задания; тест не
запускался, файл не отправлялся. Для этих операций MCP поддерживает только
актуальные same-origin HTML-формы, а точное соответствие конкретным Blackboard
маршрутам пока не подтверждено браузерным снимком.
