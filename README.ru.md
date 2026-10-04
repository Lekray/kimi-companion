# Kimi Code Companion

Локальное расширение VS Code (`lekra.kimi-companion`). Дополняет официальное расширение Kimi Code (`moonshot-ai.kimi-code`) возможностями, которых в нём нет:

- **восстановление окон Kimi после «Developer: Reload Window»** — с их названиями, колонкой редактора и **историей диалога**;
- **кнопки**: значок Kimi в заголовке редактора (новое окно), карандаш рядом с ним (переименовать окно), «✨ Kimi Code» в статус-баре справа;
- **переименование окон** Kimi (`Kimi Code: Rename Window`);
- **автоназвание окон по теме диалога** (пока окно зовётся «Kimi Code» и в нём открыта сессия — берётся `title`/`lastPrompt` из `state.json` сессии);
- **«Kimi Code: Reopen Closed Window»** — переоткрывает последнее закрытое окно (помнит до 5);
- восстановление истории в **сайдбаре** Kimi.

Лог работы: Вид → Вывод → канал **«Kimi Code Companion»**.

## Почему нужны врезки в код Kimi

VS Code не даёт одному расширению доступа к webview-панелям другого (ни заголовок сменить, ни сессию узнать). Поэтому компаньон вносит маленькие правки в `dist` расширения Kimi — они регистрируют окна и хуки в `globalThis` (общая область процесса extension host).

## Врезки (6 штук), файл `moonshot-ai.kimi-code-*/dist/`

| # | Файл | Маркер | Что делает |
|---|------|--------|------------|
| 1 | extension.js | `__kimiCompanionNextTitle` | заголовок новой вкладки берётся из `globalThis.__kimiCompanionNextTitle` |
| 2 | extension.js | `/*__kimiCompanion__*/` | созданные панели кладутся в `globalThis.__kimiCompanionPanels` (+удаление при dispose) |
| 3 | extension.js | `__kimiCompanionNextColumn` | колонка новой вкладки из `globalThis.__kimiCompanionNextColumn` |
| 4 | extension.js | `/*__kimiCompanion2__*/` | хуки `__kimiCompanionGetSessionId / GetWebviewId / LoadSession` |
| 5 | extension.js | `__kimiCompanionGetSidebarId` | хук поиска webviewId сайдбара |
| 6 | webview.js | `__kimiCompanionLoadSessionInUi` | обработчик события `__kimiCompanionLoadSession` в вебвью — штатный `loadSessionHistory → loadSession` |

Оригиналы рядом: `extension.js.bak-kimi-companion`, `webview.js.bak-kimi-companion` (не перезаписывать — это эталон 0.8.1).

**Самолечение:** при каждой активации компаньон проверяет все маркеры и доставляет недостающее (например, после обновления Kimi), затем предлагает перезагрузку. Если якорь в новой версии не находится — предупреждение со списком маркеров: нужна ручная правка по таблице выше.

## Версия Kimi запиннена

В `~/.vscode/extensions/extensions.json` у `moonshot-ai.kimi-code` стоит `"pinned": true` — автообновление выключено, чтобы врезки не слетали в случайный момент. **Обновление Kimi — только осознанно**: снять пин → обновить → проверить якоря (таблица выше) → при расхождении поправить врезки → перезагрузить окно.

## Откат / удаление

1. Удалить папку `~/.vscode/extensions/lekra.kimi-companion-1.0.0`.
2. Вернуть оригиналы Kimi: `extension.js.bak-kimi-companion → extension.js`, `webview.js.bak-kimi-companion → webview.js` (в `dist` расширения Kimi). Либо удалить папку `moonshot-ai.kimi-code-*` и поставить расширение заново с маркетплейса.
3. Перезагрузить окно.

## Настройки

- `kimiCompanion.restoreTabOnStartup` (по умолчанию `true`) — восстанавливать окна после перезагрузки;
- `kimiCompanion.statusBarButton` (по умолчанию `true`) — кнопка в статус-баре.

## Грабли, которые уже выловлены

- **Кэш расширений** `~/.vscode/extensions/extensions.json` — при ручном переименовании/переносе папки расширения запись в кэше надо править синхронно (location, relativeLocation, version), иначе после перезагрузки расширение «исчезает» с ENOENT.
- Monkey-patch `vscode.window.*` из своего расширения **не действует** на чужие: у ESM-расширения (Kimi) свой экземпляр API. Поэтому вместо перехвата — врезки + `globalThis`.
- `tab.input.viewType` webview-вкладки Kimi ≠ `"kimiPanel"` (проверено на 1.139.1) — для детекции вкладок полагаться нельзя, используется реестр панелей.
- После правок `dist` Kimi проверять синтаксис: `node --check extension.js` (ESM) и `node -e "new (require('vm').Script)(...)"` для webview.js (script).
