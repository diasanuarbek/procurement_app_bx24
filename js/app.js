/**
 * Главный скрипт приложения "Заявки на закуп в смарт-процесс"
 * Настройки зафиксированы в config.js.
 * Поддерживает:
 * - Ввод позиций закупа
 * - Прикрепление файлов (тех. спецификаций) к каждой строке [UF_CRM_8_FILES]
 * - Запись обоснования закупки в [UF_CRM_8_CAUSE]
 */

let api = null;
let appConfig = null;
let availableUnits = [];
let currentUser = null;

document.addEventListener("DOMContentLoaded", async () => {
    appConfig = loadAppConfig();
    api = new Bitrix24Api(appConfig);

    // Инициализация API
    await api.init();

    // Загрузка пользователя
    try {
        currentUser = await api.getCurrentUser();
    } catch (e) {
        console.warn("Пользователь не определен:", e);
    }

    // Загрузка единиц измерения
    try {
        availableUnits = await api.loadUnitOptions();
    } catch (e) {
        availableUnits = appConfig.defaultUnits;
    }

    // Обновляем бейдж заявителя в шапке
    updateApplicantBadge();

    // Добавляем 3 стартовые строки
    addTableRow();
    addTableRow();
    addTableRow();

    // Навешиваем слушатели событий
    setupEventListeners();
});

/**
 * Отображение текущего заявителя в шапке
 */
function updateApplicantBadge() {
    const badge = document.getElementById("applicant-badge");
    if (!badge) return;

    if (currentUser && (currentUser.fullName || currentUser.NAME || currentUser.LAST_NAME)) {
        const fullName = currentUser.fullName || 
            [currentUser.LAST_NAME, currentUser.NAME, currentUser.SECOND_NAME].filter(Boolean).join(" ") || 
            currentUser.NAME || 
            currentUser.EMAIL || 
            `Сотрудник ID ${currentUser.ID}`;

        badge.innerHTML = `<span class="dot-online"></span> Заявитель: <strong>${escapeHtml(fullName)}</strong>`;
        badge.title = `Заявитель: ${fullName}${currentUser.ID ? ' (ID: ' + currentUser.ID + ')' : ''}`;
    } else if (api && api.isBx24) {
        badge.innerHTML = `<span class="dot-online"></span> Заявитель: <strong>Текущий сотрудник</strong>`;
        badge.title = "Текущий авторизованный сотрудник Битрикс24";
    } else {
        badge.innerHTML = `<span class="dot-online"></span> Заявитель: <strong>Сотрудник компании</strong>`;
    }
}

/**
 * Навешивание основных обработчиков событий
 */
function setupEventListeners() {
    // Кнопка "+ Добавить позицию"
    document.getElementById("btn-add-row").addEventListener("click", () => addTableRow());

    // Кнопка "Очистить все"
    document.getElementById("btn-clear-all").addEventListener("click", clearAllRows);

    // Кнопка "Вставить из Excel"
    document.getElementById("btn-paste-excel").addEventListener("click", () => openModal("modal-paste"));

    // Кнопка "Применить вставку из Excel"
    document.getElementById("btn-apply-paste").addEventListener("click", applyExcelPaste);

    // Отправка формы (кнопка внизу)
    document.getElementById("btn-submit-requests").addEventListener("click", submitProcurementRequests);

    // Закрытие модальных окон
    document.querySelectorAll(".modal-close, .modal-cancel").forEach(el => {
        el.addEventListener("click", (e) => {
            const modal = e.target.closest(".modal-overlay");
            if (modal) closeModal(modal.id);
        });
    });

    // Быстрые варианты обоснования закупки
    document.querySelectorAll(".quick-tag").forEach(tagBtn => {
        tagBtn.addEventListener("click", () => {
            const tagText = tagBtn.getAttribute("data-tag");
            const justInput = document.getElementById("common-justification");
            if (justInput && tagText) {
                justInput.value = tagText;
                justInput.focus();
            }
        });
    });

    // Обработка глобального Ctrl+V для быстрой вставки из Excel в таблицу
    document.addEventListener("paste", handleGlobalPaste);
}

/**
 * Генерация HTML выпадающего списка единиц измерения
 */
function getUnitOptionsHtml(selectedUnit = "") {
    const units = (availableUnits && availableUnits.length > 0) ? availableUnits : appConfig.defaultUnits;
    let html = "";
    units.forEach(u => {
        const val = u.value;
        const isSelected = (val.toLowerCase() === selectedUnit.toLowerCase()) ? "selected" : "";
        html += `<option value="${val}" ${isSelected}>${val}</option>`;
    });
    return html;
}

/**
 * Добавление новой строки в таблицу
 */
function addTableRow(data = {}) {
    const tbody = document.getElementById("items-table-body");
    const rowCount = tbody.querySelectorAll("tr").length + 1;

    const tr = document.createElement("tr");
    tr.className = "item-row";

    // Хранилище прикрепленных файлов для текущей строки
    tr._attachedFiles = Array.isArray(data.files) ? [...data.files] : [];

    const defaultUnit = data.unit || (availableUnits[0] ? availableUnits[0].value : "штук");

    tr.innerHTML = `
        <td class="col-idx">${rowCount}</td>
        <td class="col-name">
            <input type="text" class="form-control input-name" placeholder="Например: Бумага А4 SvetoCopy" value="${escapeHtml(data.name || "")}" required>
        </td>
        <td class="col-unit">
            <select class="form-control input-unit">
                ${getUnitOptionsHtml(defaultUnit)}
            </select>
        </td>
        <td class="col-qty">
            <input type="number" class="form-control input-qty" placeholder="1" min="0.001" step="any" value="${data.quantity || 1}" required>
        </td>
        <td class="col-files">
            <div class="file-upload-wrapper">
                <label class="btn-attach" title="Прикрепить тех. спецификацию или коммерческое предложение">
                    📎 <span class="attach-label">Прикрепить</span>
                    <input type="file" class="input-row-files" multiple style="display:none">
                </label>
                <div class="row-files-list"></div>
            </div>
        </td>
        <td class="col-note">
            <input type="text" class="form-control input-note" placeholder="Ссылка или примечание" value="${escapeHtml(data.note || "")}">
        </td>
        <td class="col-actions">
            <div class="row-actions">
                <button type="button" class="btn-row-copy" title="Дублировать строку">📋</button>
                <button type="button" class="btn-row-del" title="Удалить строку">✕</button>
            </div>
        </td>
    `;

    // Слушатель выбора файлов
    const fileInput = tr.querySelector(".input-row-files");
    const uploadWrapper = tr.querySelector(".file-upload-wrapper");

    const processFiles = async (files) => {
        for (const f of files) {
            try {
                const base64Data = await readFileAsBase64(f);
                tr._attachedFiles.push({
                    name: f.name,
                    base64: base64Data,
                    size: f.size
                });
            } catch (err) {
                console.error("Ошибка чтения файла:", err);
            }
        }
        renderRowFiles(tr);
    };

    fileInput.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files);
        await processFiles(files);
        fileInput.value = ""; // сброс значения
    });

    // Drag & Drop файлов прямо на ячейку
    uploadWrapper.addEventListener("dragover", (e) => {
        e.preventDefault();
        uploadWrapper.classList.add("dragover");
    });
    uploadWrapper.addEventListener("dragleave", () => {
        uploadWrapper.classList.remove("dragover");
    });
    uploadWrapper.addEventListener("drop", async (e) => {
        e.preventDefault();
        uploadWrapper.classList.remove("dragover");
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            await processFiles(Array.from(e.dataTransfer.files));
        }
    });

    // Отрисовываем файлы, если они уже были (например, при дублировании)
    renderRowFiles(tr);

    // Слушатель удаления строки
    tr.querySelector(".btn-row-del").addEventListener("click", () => {
        tr.remove();
        reindexRows();
        updateStats();
    });

    // Слушатель дублирования строки
    tr.querySelector(".btn-row-copy").addEventListener("click", () => {
        const currentData = {
            name: tr.querySelector(".input-name").value,
            unit: tr.querySelector(".input-unit").value,
            quantity: tr.querySelector(".input-qty").value,
            note: tr.querySelector(".input-note").value,
            files: [...tr._attachedFiles]
        };
        addTableRow(currentData);
    });

    // Слушатели пересчета
    tr.querySelector(".input-qty").addEventListener("input", updateStats);
    tr.querySelector(".input-name").addEventListener("input", updateStats);

    tbody.appendChild(tr);
    reindexRows();
    updateStats();

    return tr;
}

/**
 * Отрисовка прикрепленных файлов для конкретной строки
 */
function renderRowFiles(tr) {
    const filesListEl = tr.querySelector(".row-files-list");
    const attachLabel = tr.querySelector(".attach-label");
    if (!filesListEl || !attachLabel) return;

    filesListEl.innerHTML = "";

    tr._attachedFiles.forEach((f, fIdx) => {
        const tag = document.createElement("span");
        tag.className = "file-tag";
        tag.title = `${f.name} (${formatFileSize(f.size)})`;
        tag.innerHTML = `📄 ${escapeHtml(shortenFileName(f.name))} <span class="file-tag-remove" title="Удалить файл">✕</span>`;

        tag.querySelector(".file-tag-remove").addEventListener("click", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            tr._attachedFiles.splice(fIdx, 1);
            renderRowFiles(tr);
        });

        filesListEl.appendChild(tag);
    });

    const count = tr._attachedFiles.length;
    attachLabel.textContent = count > 0 ? `Файлы (${count})` : "Прикрепить";
}

/**
 * Чтение файла в Base64
 */
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const res = reader.result;
            const base64 = res.includes(",") ? res.split(",")[1] : res;
            resolve(base64);
        };
        reader.onerror = err => reject(err);
        reader.readAsDataURL(file);
    });
}

/**
 * Форматирование размера файла
 */
function formatFileSize(bytes) {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Сокращение имени файла для аккуратного отображения
 */
function shortenFileName(name, maxLen = 14) {
    if (!name || name.length <= maxLen) return name;
    const ext = name.includes(".") ? "." + name.split(".").pop() : "";
    const base = name.substring(0, name.length - ext.length);
    return base.substring(0, maxLen - ext.length - 3) + "..." + ext;
}

/**
 * Перенумерация строк
 */
function reindexRows() {
    const rows = document.querySelectorAll("#items-table-body tr");
    rows.forEach((row, idx) => {
        const idxCell = row.querySelector(".col-idx");
        if (idxCell) idxCell.textContent = idx + 1;
    });
}

/**
 * Очистить все строки и оставить одну чистую
 */
function clearAllRows() {
    if (confirm("Вы уверены, что хотите очистить все позиции?")) {
        document.getElementById("items-table-body").innerHTML = "";
        addTableRow();
        updateStats();
    }
}

/**
 * Обновление счетчиков внизу и на тулбаре
 */
function updateStats() {
    const rows = document.querySelectorAll("#items-table-body tr");
    let filledCount = 0;
    let totalQty = 0;

    rows.forEach(r => {
        const name = r.querySelector(".input-name").value.trim();
        const qty = parseFloat(r.querySelector(".input-qty").value) || 0;
        if (name) {
            filledCount++;
            totalQty += qty;
        }
    });

    const btnSubmit = document.getElementById("btn-submit-requests");
    const countDisplay = document.getElementById("total-rows-count");

    if (countDisplay) {
        countDisplay.textContent = filledCount;
    }

    if (btnSubmit) {
        btnSubmit.innerHTML = `🚀 Отправить заявки в закуп (${filledCount} поз.)`;
        btnSubmit.disabled = (filledCount === 0);
    }
}

/**
 * Обработка вставки из буфера обмена (Excel / Sheets)
 */
function handleGlobalPaste(e) {
    if (e.target.id === "paste-textarea" || e.target.id === "common-justification") {
        return;
    }

    const clipboardData = e.clipboardData || window.clipboardData;
    const pastedData = clipboardData.getData("Text");

    if (pastedData && (pastedData.includes("\t") || pastedData.includes("\n"))) {
        const parsed = parseTabularData(pastedData);
        if (parsed.length > 0) {
            e.preventDefault();
            insertRowsFromData(parsed);
        }
    }
}

/**
 * Парсер строк из Excel
 */
function parseTabularData(text) {
    const lines = text.trim().split(/\r\n|\n|\r/);
    const results = [];

    lines.forEach(line => {
        if (!line.trim()) return;

        let parts = line.split("\t");
        if (parts.length === 1 && line.includes(";")) {
            parts = line.split(";");
        }

        const name = (parts[0] || "").trim();
        if (!name) return;

        let unit = (parts[1] || "").trim().toLowerCase();
        let qty = parseFloat((parts[2] || "1").replace(",", ".")) || 1;
        let note = (parts[3] || "").trim();

        const unitsList = (availableUnits && availableUnits.length > 0) ? availableUnits : appConfig.defaultUnits;
        const matchedUnit = unitsList.find(u => u.value.toLowerCase() === unit);

        if (matchedUnit) {
            unit = matchedUnit.value;
        } else {
            const maybeQty = parseFloat(unit.replace(",", "."));
            if (!isNaN(maybeQty)) {
                qty = maybeQty;
                unit = unitsList[0].value;
                note = (parts[2] || "").trim();
            } else {
                unit = unitsList[0].value;
            }
        }

        results.push({
            name: name,
            unit: unit,
            quantity: qty,
            note: note,
            files: []
        });
    });

    return results;
}

/**
 * Применение вставки из модального окна Excel
 */
function applyExcelPaste() {
    const textarea = document.getElementById("paste-textarea");
    const text = textarea.value.trim();
    if (!text) {
        alert("Вставьте скопированные данные из таблицы в поле ввода.");
        return;
    }

    const parsed = parseTabularData(text);
    if (parsed.length === 0) {
        alert("Не удалось распознать строки. Убедитесь, что каждая строка содержит наименование.");
        return;
    }

    insertRowsFromData(parsed);
    textarea.value = "";
    closeModal("modal-paste");
}

/**
 * Вставка распознанных строк в таблицу
 */
function insertRowsFromData(dataList) {
    const rows = document.querySelectorAll("#items-table-body tr");
    rows.forEach(r => {
        const name = r.querySelector(".input-name").value.trim();
        if (!name) r.remove();
    });

    dataList.forEach(item => {
        addTableRow(item);
    });

    updateStats();
}

/**
 * Сбор данных из таблицы
 */
function collectTableItems() {
    const rows = document.querySelectorAll("#items-table-body tr");
    const items = [];

    rows.forEach(r => {
        const name = r.querySelector(".input-name").value.trim();
        const unit = r.querySelector(".input-unit").value;
        const qty = parseFloat(r.querySelector(".input-qty").value) || 0;
        const note = r.querySelector(".input-note").value.trim();
        const files = r._attachedFiles || [];

        if (name && qty > 0) {
            items.push({
                productName: name,
                unit: unit,
                quantity: qty,
                note: note,
                files: files
            });
        }
    });

    return items;
}

/**
 * Отправка заявок в смарт-процесс отдела закупа
 */
async function submitProcurementRequests() {
    const items = collectTableItems();
    if (items.length === 0) {
        alert("Заполните хотя бы одну позицию (наименование и количество > 0).");
        return;
    }

    // Собираем общие данные (обоснование покупки пойдет в UF_CRM_53_CAUSE)
    const justificationEl = document.getElementById("common-justification");
    const commonData = {
        justification: justificationEl ? justificationEl.value.trim() : "",
        categoryId: appConfig.categoryId || null,
        // Заявитель (пишется в UF_CRM_53_1783939121, а ответственный остается по умолчанию)
        applicantId: (currentUser && currentUser.ID) ? currentUser.ID : null
    };

    // Открываем модальное окно прогресса
    openModal("modal-progress");
    const progressFill = document.getElementById("progress-bar-fill");
    const progressLabel = document.getElementById("progress-label-text");
    const resultsContainer = document.getElementById("progress-results-list");
    const btnDone = document.getElementById("btn-progress-done");

    btnDone.style.display = "none";
    resultsContainer.innerHTML = "";
    progressFill.style.width = "0%";
    progressLabel.textContent = `Отправка ${items.length} заявок в смарт-процесс...`;

    try {
        const results = await api.createProcurementItems(items, commonData, (completed, total) => {
            const percent = Math.round((completed / total) * 100);
            progressFill.style.width = `${percent}%`;
            progressLabel.textContent = `Создано ${completed} из ${total} заявок (${percent}%)`;
        });

        // Отображение результатов
        let successCount = 0;
        results.forEach(res => {
            if (res.success) successCount++;
            const div = document.createElement("div");
            div.className = `result-item ${res.success ? "success" : "error"}`;

            if (res.success) {
                div.innerHTML = `
                    <div>
                        <strong>#${res.index}</strong>: ${escapeHtml(res.productName)} (${res.quantity} ${escapeHtml(res.unit)}) — 
                        <a href="${res.url}" target="_blank" class="result-link">Заявка #${res.id} в смарт-процессе ↗</a>
                    </div>
                    <span class="badge badge-success">Создано</span>
                `;
            } else {
                div.innerHTML = `
                    <div>
                        <strong>#${res.index}</strong>: ${escapeHtml(res.productName)} (${escapeHtml(res.error)})
                    </div>
                    <span class="badge badge-error">Ошибка</span>
                `;
            }
            resultsContainer.appendChild(div);
        });

        progressLabel.innerHTML = `Готово! Успешно создано <strong>${successCount}</strong> из <strong>${items.length}</strong> заявок в отдел закупа.`;
        btnDone.style.display = "inline-flex";

        // Если все успешно — очищаем таблицу для новых заявок
        if (successCount === items.length) {
            document.getElementById("items-table-body").innerHTML = "";
            document.getElementById("common-justification").value = "";
            addTableRow();
            updateStats();
        }

    } catch (err) {
        console.error("Ошибка при создании заявок:", err);
        progressLabel.innerHTML = `<span style="color:red">Ошибка: ${escapeHtml(err.message)}</span>`;
        btnDone.style.display = "inline-flex";
    }
}

/**
 * Управление модальными окнами
 */
function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add("active");
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove("active");
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
