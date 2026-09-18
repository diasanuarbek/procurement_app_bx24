/**
 * Модуль интеграции с Bitrix24 REST API
 * Поддерживает:
 * 1. Работу внутри фрейма Битрикс24 через официальную библиотеку BX24.js
 * 2. Работу через входящий вебхук (для удобного тестирования прямо в браузере без установки)
 */

class Bitrix24Api {
    constructor(config) {
        this.config = config || loadAppConfig();
        this.isBx24 = typeof BX24 !== "undefined";
        this.unitOptionsMap = new Map(); // Карта "название ед. изм." -> ID в Битриксе
        this.currentUser = null;
        this.serverFields = null; // Поля, полученные от crm.item.fields
        this.resolvedKeys = {
            title: "title",
            productName: this.config.fields?.productName || "UF_CRM_53_PRODUCT_NAME",
            quantity: this.config.fields?.quantity || "UF_CRM_53_QUANTITY",
            unit: this.config.fields?.unit || "UF_CRM_53_UNIT",
            cause: this.config.fields?.cause || "UF_CRM_53_CAUSE",
            files: this.config.fields?.files || "UF_CRM_53_FILES",
            additions: this.config.fields?.additions || "UF_CRM_53_ADDITIONS",
            applicant: this.config.fields?.applicant || "UF_CRM_53_1783939121",
            comments: "COMMENTS"
        };
    }

    /**
     * Запись значения поля во все возможные варианты написания ключей для REST API смарт-процесса
     */
    addFieldVariations(targetObj, rawKey, value) {
        if (!rawKey || value === undefined || value === null) return;
        targetObj[rawKey] = value;
        targetObj[rawKey.toUpperCase()] = value;
        targetObj[rawKey.toLowerCase()] = value;

        // Обработка UF_CRM_XX_...
        const match = String(rawKey).match(/^UF_CRM_(\d+)_(.+)$/i);
        if (match) {
            const num = match[1];
            const rest = match[2]; // e.g. PRODUCT_NAME

            // ufCrm53_PRODUCT_NAME / ufCrm53_product_name
            targetObj[`ufCrm${num}_${rest}`] = value;
            targetObj[`ufCrm${num}_${rest.toLowerCase()}`] = value;

            // ufCrm_53_PRODUCT_NAME / ufCrm_53_product_name
            targetObj[`ufCrm_${num}_${rest}`] = value;
            targetObj[`ufCrm_${num}_${rest.toLowerCase()}`] = value;

            // camelCase: ufCrm53ProductName
            const camelRest = rest.toLowerCase().replace(/_([a-z])/g, (_, g) => g.toUpperCase());
            const capitalizedCamelRest = camelRest.charAt(0).toUpperCase() + camelRest.slice(1);
            targetObj[`ufCrm${num}${capitalizedCamelRest}`] = value;
            targetObj[`ufCrm_${num}${capitalizedCamelRest}`] = value;
        }
    }

    /**
     * Инициализация API
     */
    async init() {
        return new Promise((resolve) => {
            let finished = false;
            const finish = () => {
                if (!finished) {
                    finished = true;
                    resolve(true);
                }
            };

            // Защитный таймаут (1.5 сек): если открыто вне Битрикса или BX24.init не отвечает,
            // не блокируем работу приложения и пробуем вебхук/демо
            const timeoutId = setTimeout(async () => {
                console.warn("Таймаут ожидания BX24.init. Переключение в автономный/вебхук режим.");
                try {
                    await this.getCurrentUser();
                    await this.loadSmartProcessMetadata();
                } catch (e) {}
                finish();
            }, 1500);

            if (this.isBx24 && typeof BX24 !== "undefined" && BX24.init) {
                try {
                    BX24.init(async () => {
                        clearTimeout(timeoutId);
                        console.log("BX24 JS SDK успешно инициализирован");
                        try {
                            BX24.fitWindow();
                        } catch (e) {}
                        try {
                            await this.getCurrentUser();
                            await this.loadSmartProcessMetadata();
                        } catch (e) {
                            console.warn("Ошибка при получении данных в BX24.init:", e);
                        }
                        finish();
                    });
                } catch (err) {
                    clearTimeout(timeoutId);
                    console.warn("Ошибка вызова BX24.init:", err);
                    finish();
                }
            } else {
                clearTimeout(timeoutId);
                console.log("Режим работы без фрейма BX24 (вебхук или автономно)");
                Promise.all([this.getCurrentUser(), this.loadSmartProcessMetadata()]).finally(finish);
            }
        });
    }

    /**
     * Получение текущего пользователя (заявителя) с гарантированным определением ФИО
     */
    async getCurrentUser() {
        if (this.currentUser && this.currentUser.fullName) {
            return this.currentUser;
        }

        let user = null;

        // 1. Пробуем получить через user.current
        try {
            const res = await this.callMethod("user.current", {});
            const data = (res && res.result) ? res.result : res;
            if (data && (data.NAME || data.LAST_NAME || data.ID)) {
                user = data;
            }
        } catch (e) {
            console.warn("user.current не вернул пользователя (возможно, нет прав 'user' или вебхук):", e.message);
        }

        // 2. Если user.current не вернул ФИО, ищем ID в окружении и запрашиваем через user.get
        if (!user || (!user.NAME && !user.LAST_NAME)) {
            try {
                let targetUserId = null;

                // Проверяем параметры URL (?USER_ID=... или ?user_id=...)
                try {
                    const urlParams = new URLSearchParams(window.location.search);
                    targetUserId = urlParams.get("USER_ID") || urlParams.get("user_id") || urlParams.get("userId");
                } catch (e) {}

                // Если во фрейме BX24
                if (!targetUserId && this.isBx24 && typeof BX24 !== "undefined" && BX24.getAuth) {
                    const auth = BX24.getAuth();
                    if (auth && (auth.user_id || auth.USER_ID)) {
                        targetUserId = auth.user_id || auth.USER_ID;
                    }
                }

                // Если через вебхук - парсим ID пользователя из URL вебхука (/rest/1/xxxx/)
                if (!targetUserId && this.config.webhookUrl) {
                    const match = this.config.webhookUrl.match(/\/rest\/(\d+)\//);
                    if (match && match[1]) {
                        targetUserId = match[1];
                    }
                }

                if (targetUserId) {
                    const res = await this.callMethod("user.get", { ID: targetUserId });
                    const list = (res && res.result) ? res.result : (Array.isArray(res) ? res : [res]);
                    if (Array.isArray(list) && list.length > 0 && list[0]) {
                        user = list[0];
                    }
                }
            } catch (e2) {
                console.warn("user.get также не вернул данные:", e2.message);
            }
        }

        if (user) {
            // Формируем красивое ФИО (Фамилия Имя Отчество)
            const parts = [user.LAST_NAME, user.NAME, user.SECOND_NAME].filter(Boolean);
            if (parts.length === 0 && user.NAME) parts.push(user.NAME);

            user.fullName = parts.length > 0 
                ? parts.join(" ") 
                : (user.EMAIL ? user.EMAIL : `Сотрудник ID ${user.ID}`);

            this.currentUser = user;
            console.log("Успешно определен заявитель (ФИО):", user.fullName, user);
            return this.currentUser;
        }

        return null;
    }

    /**
     * Проверка доступности подключения
     */
    async testConnection() {
        try {
            const res = await this.callMethod("user.current", {});
            return {
                success: true,
                user: res.result || res
            };
        } catch (error) {
            return {
                success: false,
                error: error.message || "Ошибка подключения к Битрикс24"
            };
        }
    }

    /**
     * Загрузка метаданных полей смарт-процесса и сопоставление реальных названий ключей
     */
    async loadSmartProcessMetadata() {
        try {
            const fieldsRes = await this.callMethod("crm.item.fields", {
                entityTypeId: this.config.entityTypeId
            });

            const fields = fieldsRes.result ? fieldsRes.result.fields : (fieldsRes.fields || {});
            this.serverFields = fields;
            console.log("Все поля смарт-процесса из Битрикс24 (crm.item.fields):", fields);

            // Сопоставляем реальные ключи полей в смарт-процессе
            this.resolvedKeys = {
                title: this.findRealFieldKey("TITLE", fields) || "title",
                productName: this.findRealFieldKey(this.config.fields.productName, fields) || this.config.fields.productName,
                quantity: this.findRealFieldKey(this.config.fields.quantity, fields) || this.config.fields.quantity,
                unit: this.findRealFieldKey(this.config.fields.unit, fields) || this.config.fields.unit,
                cause: this.findRealFieldKey(this.config.fields.cause || "UF_CRM_53_CAUSE", fields) || this.config.fields.cause,
                files: this.findRealFieldKey(this.config.fields.files || "UF_CRM_53_FILES", fields) || this.config.fields.files,
                additions: this.findRealFieldKey(this.config.fields.additions || "UF_CRM_53_ADDITIONS", fields) || this.config.fields.additions,
                applicant: this.findRealFieldKey(this.config.fields.applicant || "UF_CRM_53_1783939121", fields) || (this.config.fields.applicant || "UF_CRM_53_1783939121"),
                comments: this.findRealFieldKey("COMMENTS", fields) || "comments"
            };

            console.log("Итоговые сопоставленные ключи полей:", this.resolvedKeys);

            // Ищем поле единиц измерения для загрузки вариантов списка
            const unitKey = this.resolvedKeys.unit;
            const unitField = fields[unitKey] || fields[this.config.fields.unit];

            if (unitField && unitField.items) {
                this.unitOptionsMap.clear();
                const loadedUnits = [];

                if (Array.isArray(unitField.items)) {
                    unitField.items.forEach(item => {
                        const id = item.ID || item.id;
                        const val = item.VALUE || item.value || item.NAME || item.name;
                        if (id && val) {
                            this.unitOptionsMap.set(String(val).toLowerCase().trim(), id);
                            loadedUnits.push({ id: id, value: val });
                        }
                    });
                } else if (typeof unitField.items === "object") {
                    for (const [id, val] of Object.entries(unitField.items)) {
                        const label = (typeof val === "object") ? (val.VALUE || val.value) : val;
                        if (id && label) {
                            this.unitOptionsMap.set(String(label).toLowerCase().trim(), id);
                            loadedUnits.push({ id: id, value: label });
                        }
                    }
                }

                if (loadedUnits.length > 0) {
                    console.log("Загружены ID списка единиц измерения из Битрикс24:", loadedUnits);
                    return loadedUnits;
                }
            }
        } catch (e) {
            console.warn("Не удалось автоматически прочитать поля через crm.item.fields:", e);
        }

        return this.config.defaultUnits;
    }

    /**
     * Алиас для обратной совместимости
     */
    async loadUnitOptions() {
        return this.loadSmartProcessMetadata();
    }

    /**
     * Умный поиск реального названия ключа поля среди полей смарт-процесса
     */
    findRealFieldKey(configuredKey, fieldsDict) {
        if (!fieldsDict || typeof fieldsDict !== "object") return configuredKey;
        const keys = Object.keys(fieldsDict);
        if (keys.length === 0) return configuredKey;

        // 1. Точное совпадение
        if (fieldsDict[configuredKey]) return configuredKey;

        const targetLower = configuredKey.toLowerCase();
        const targetClean = targetLower.replace(/[^a-z0-9]/g, "");

        // 2. Регистронезависимое совпадение
        const matchCase = keys.find(k => k.toLowerCase() === targetLower);
        if (matchCase) return matchCase;

        // 3. Совпадение без спецсимволов и подчеркиваний (например, ufcrm8productname)
        const matchClean = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, "") === targetClean);
        if (matchClean) return matchClean;

        // 4. Поиск по смысловой части (PRODUCT_NAME, QUANTITY, UNIT, CAUSE, FILES)
        if (targetLower.includes("product")) {
            const m = keys.find(k => k.toLowerCase().includes("product") || k.toLowerCase().includes("tovar"));
            if (m) return m;
        }
        if (targetLower.includes("quant")) {
            const m = keys.find(k => k.toLowerCase().includes("quant") || k.toLowerCase().includes("kolvo") || k.toLowerCase().includes("qty"));
            if (m) return m;
        }
        if (targetLower.includes("unit")) {
            const m = keys.find(k => k.toLowerCase().includes("unit") || k.toLowerCase().includes("izm"));
            if (m) return m;
        }
        if (targetLower.includes("cause")) {
            const m = keys.find(k => k.toLowerCase().includes("cause") || k.toLowerCase().includes("obosn"));
            if (m) return m;
        }
        if (targetLower.includes("file")) {
            const m = keys.find(k => k.toLowerCase().includes("file") || k.toLowerCase().includes("spec"));
            if (m) return m;
        }
        if (targetLower.includes("addition")) {
            const m = keys.find(k => k.toLowerCase().includes("addition") || k.toLowerCase().includes("primech") || k.toLowerCase().includes("note"));
            if (m) return m;
        }

        // 5. Поиск по заголовку поля (title / formLabel)
        for (const k of keys) {
            const f = fieldsDict[k];
            const title = ((f.title || f.formLabel || f.listLabel || "") + "").toLowerCase();
            if (targetLower.includes("product") && (title.includes("товар") || title.includes("наименование") || title.includes("продукт"))) {
                return k;
            }
            if (targetLower.includes("quant") && (title.includes("колич") || title.includes("кол-во"))) {
                return k;
            }
            if (targetLower.includes("unit") && (title.includes("единиц") || title.includes("измер"))) {
                return k;
            }
            if (targetLower.includes("cause") && (title.includes("обоснован") || title.includes("причин") || title.includes("цель"))) {
                return k;
            }
            if (targetLower.includes("file") && (title.includes("файл") || title.includes("документ") || title.includes("специфик"))) {
                return k;
            }
            if (targetLower.includes("addition") && (title.includes("примечан") || title.includes("ссылк") || title.includes("дополн"))) {
                return k;
            }
        }

        return configuredKey;
    }

    /**
     * Пакетное создание заявок в смарт-процессе
     * @param {Array} itemsList - массив строк [{ productName, unit, quantity, note, files }]
     * @param {Object} commonData - общие данные заявки (обоснование, желаемый срок и т.д.)
     * @param {Function} onProgress - колбэк прогресса (completed, total)
     */
    async createProcurementItems(itemsList, commonData = {}, onProgress = null) {
        if (!itemsList || itemsList.length === 0) {
            return [];
        }

        const entityTypeId = this.config.entityTypeId;
        const total = itemsList.length;
        let completed = 0;
        const results = [];

        // Формируем команды для добавления каждого элемента
        const commands = {};

        // Заявитель (сотрудник, подающий заявку)
        let applicantId = null;
        if (commonData.applicantId) {
            applicantId = commonData.applicantId;
        } else if (commonData.assignedById) {
            applicantId = commonData.assignedById;
        } else if (this.currentUser && this.currentUser.ID) {
            applicantId = this.currentUser.ID;
        }

        itemsList.forEach((item, index) => {
            const cmdKey = `add_item_${index}`;

            // Поиск ID варианта списка (единица измерения)
            let unitValue = item.unit;
            const unitLower = (item.unit + "").toLowerCase().trim();
            if (this.unitOptionsMap.has(unitLower)) {
                unitValue = this.unitOptionsMap.get(unitLower);
                console.log(`Ед. изм. "${item.unit}" преобразована в ID списка: ${unitValue}`);
            }

            // Формируем комментарий / примечание
            let fullComment = [];
            if (item.note) fullComment.push(`Примечание к позиции: ${item.note}`);

            // Основные распознанные ключи
            const pKey = this.resolvedKeys.productName || this.config.fields.productName;
            const qKey = this.resolvedKeys.quantity || this.config.fields.quantity;
            const uKey = this.resolvedKeys.unit || this.config.fields.unit;
            const cKey = this.resolvedKeys.cause || this.config.fields.cause;
            const fKey = this.resolvedKeys.files || this.config.fields.files;
            const aKey = this.resolvedKeys.additions || this.config.fields.additions;
            const appKey = this.resolvedKeys.applicant || this.config.fields.applicant || "UF_CRM_53_1783939121";
            const tKey = this.resolvedKeys.title || "title";
            const parsedQty = parseFloat(item.quantity) || 0;

            const fields = {
                // Системный заголовок элемента смарт-процесса
                [tKey]: item.productName,
                title: item.productName,
                TITLE: item.productName
            };

            // 1. Товар / наименование
            this.addFieldVariations(fields, pKey, item.productName);
            if (this.config.fields.productName) this.addFieldVariations(fields, this.config.fields.productName, item.productName);

            // 2. Количество
            this.addFieldVariations(fields, qKey, parsedQty);
            if (this.config.fields.quantity) this.addFieldVariations(fields, this.config.fields.quantity, parsedQty);

            // 3. Единица измерения
            this.addFieldVariations(fields, uKey, unitValue);
            if (this.config.fields.unit) this.addFieldVariations(fields, this.config.fields.unit, unitValue);

            // 4. Обоснование покупки
            if (commonData.justification) {
                this.addFieldVariations(fields, cKey, commonData.justification);
                if (this.config.fields.cause) this.addFieldVariations(fields, this.config.fields.cause, commonData.justification);
            }

            // 5. Примечание / ссылка (UF_CRM_53_ADDITIONS)
            if (item.note) {
                if (aKey) this.addFieldVariations(fields, aKey, item.note);
                if (this.config.fields.additions) this.addFieldVariations(fields, this.config.fields.additions, item.note);
            }

            // 6. Файлы / тех. спецификация (множественное)
            if (item.files && item.files.length > 0) {
                const filesPayload = item.files.map(f => [f.name, f.base64]);
                this.addFieldVariations(fields, fKey, filesPayload);
                if (this.config.fields.files) this.addFieldVariations(fields, this.config.fields.files, filesPayload);
            }

            // Заявитель: записываем в поле UF_CRM_53_1783939121 (привязка к сотруднику), а НЕ в ответственный
            if (applicantId) {
                const appKey = this.resolvedKeys.applicant || this.config.fields.applicant || "UF_CRM_53_1783939121";
                this.addFieldVariations(fields, appKey, applicantId);
                if (this.config.fields.applicant) {
                    this.addFieldVariations(fields, this.config.fields.applicant, applicantId);
                }
            }

            // Воронка: передаем categoryId если задан в commonData или в config
            const catId = (commonData.categoryId !== undefined && commonData.categoryId !== null) 
                ? commonData.categoryId 
                : this.config.categoryId;
            if (catId !== null && catId !== undefined && Number(catId) >= 0) {
                fields.categoryId = Number(catId);
                fields.CATEGORY_ID = Number(catId);
            }

            // Комментарии / примечание
            if (fullComment.length > 0) {
                const commentText = fullComment.join("\n");
                fields.comments = commentText;
                fields.COMMENTS = commentText;
            }

            commands[cmdKey] = {
                method: "crm.item.add",
                params: {
                    entityTypeId: entityTypeId,
                    fields: fields
                }
            };
        });

        console.log("Отправка пакета в crm.item.add:", commands);

        // Отправка пакетов (Bitrix24 поддерживает до 50 команд в одном batch-запросе)
        const cmdKeys = Object.keys(commands);
        const batchSize = 50;

        for (let i = 0; i < cmdKeys.length; i += batchSize) {
            const sliceKeys = cmdKeys.slice(i, i + batchSize);
            const batchChunk = {};
            sliceKeys.forEach(k => { batchChunk[k] = commands[k]; });

            try {
                const batchResult = await this.callBatch(batchChunk);
                console.log("Ответ batch от Битрикс24:", batchResult);

                sliceKeys.forEach((key, sliceIdx) => {
                    const originalIdx = i + sliceIdx;
                    const item = itemsList[originalIdx];
                    const res = batchResult[key];

                    if (res && res.item && res.item.id) {
                        results.push({
                            index: originalIdx + 1,
                            productName: item.productName,
                            quantity: item.quantity,
                            unit: item.unit,
                            success: true,
                            id: res.item.id,
                            url: this.getItemUrl(res.item.id)
                        });
                    } else if (res && typeof res === "number") {
                        results.push({
                            index: originalIdx + 1,
                            productName: item.productName,
                            quantity: item.quantity,
                            unit: item.unit,
                            success: true,
                            id: res,
                            url: this.getItemUrl(res)
                        });
                    } else {
                        const errorMsg = (res && res.error_description) || (res && res.error) || "Неизвестная ошибка";
                        results.push({
                            index: originalIdx + 1,
                            productName: item.productName,
                            quantity: item.quantity,
                            unit: item.unit,
                            success: false,
                            error: errorMsg
                        });
                    }

                    completed++;
                    if (onProgress) onProgress(completed, total);
                });
            } catch (err) {
                console.error("Ошибка выполнения batch-запроса:", err);
                sliceKeys.forEach((key, sliceIdx) => {
                    const originalIdx = i + sliceIdx;
                    const item = itemsList[originalIdx];
                    results.push({
                        index: originalIdx + 1,
                        productName: item.productName,
                        quantity: item.quantity,
                        unit: item.unit,
                        success: false,
                        error: err.message || "Ошибка отправки пакета"
                    });
                    completed++;
                    if (onProgress) onProgress(completed, total);
                });
            }
        }

        return results;
    }

    /**
     * Ссылка на карточку созданного элемента смарт-процесса в Битрикс24
     */
    getItemUrl(itemId) {
        const domain = this.config.portalDomain || "b24.alageum.com";
        return `https://${domain}/crm/type/${this.config.entityTypeId}/details/${itemId}/`;
    }

    /**
     * Универсальный вызов метода REST API
     */
    async callMethod(method, params = {}) {
        // 1. Если запущено во фрейме Битрикс24
        if (this.isBx24 && typeof BX24 !== "undefined" && BX24.callMethod) {
            return new Promise((resolve, reject) => {
                BX24.callMethod(method, params, (result) => {
                    if (result.error()) {
                        reject(new Error(result.error().getError().error_description || result.error().toString()));
                    } else {
                        resolve(result.data());
                    }
                });
            });
        }

        // 2. Если указан входящий вебхук
        if (this.config.webhookUrl) {
            let baseUrl = this.config.webhookUrl.trim();
            if (!baseUrl.endsWith("/")) baseUrl += "/";
            const url = `${baseUrl}${method}`;

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params)
            });

            const data = await response.json();
            if (data.error) {
                throw new Error(data.error_description || data.error);
            }
            return data;
        }

        throw new Error("Не настроено подключение к Битрикс24 (отсутствует библиотека BX24 или URL вебхука)");
    }

    /**
     * Универсальный вызов Batch
     */
    async callBatch(commands) {
        // 1. Через фрейм BX24
        if (this.isBx24 && typeof BX24 !== "undefined" && BX24.callBatch) {
            return new Promise((resolve, reject) => {
                const formattedCmds = {};
                for (let k in commands) {
                    formattedCmds[k] = [commands[k].method, commands[k].params];
                }

                BX24.callBatch(formattedCmds, (res) => {
                    const output = {};
                    for (let k in formattedCmds) {
                        const r = res[k];
                        if (r.error()) {
                            output[k] = { error: r.error().getError().error_description || r.error().toString() };
                        } else {
                            output[k] = r.data();
                        }
                    }
                    resolve(output);
                });
            });
        }

        // 2. Через вебхук
        if (this.config.webhookUrl) {
            let baseUrl = this.config.webhookUrl.trim();
            if (!baseUrl.endsWith("/")) baseUrl += "/";
            const url = `${baseUrl}batch.json`;

            const cmdObj = {};
            for (let k in commands) {
                cmdObj[k] = commands[k].method + "?" + this.buildQueryString(commands[k].params);
            }

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ halt: 0, cmd: cmdObj })
            });

            const data = await response.json();
            if (data.error) {
                throw new Error(data.error_description || data.error);
            }
            return (data.result && data.result.result) ? data.result.result : {};
        }

        throw new Error("Не настроено подключение к Битрикс24");
    }

    /**
     * Хелпер сериализации параметров в query string
     */
    buildQueryString(params, prefix = "") {
        const query = [];
        for (const p in params) {
            if (Object.prototype.hasOwnProperty.call(params, p)) {
                const k = prefix ? `${prefix}[${p}]` : p;
                const v = params[p];
                if (v !== null && typeof v === "object") {
                    query.push(this.buildQueryString(v, k));
                } else if (v !== undefined) {
                    query.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
                }
            }
        }
        return query.join("&");
    }
}
