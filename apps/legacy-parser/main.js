(() => {
  const inputEl = document.getElementById("inputText");
  const parseBtn = document.getElementById("parseBtn");
  const exportBtn = document.getElementById("exportBtn");
  const aiNormalizeBtn = document.getElementById("aiNormalizeBtn");
  const aiOrderInput = document.getElementById("aiOrderInput");
  const aiReorderBtn = document.getElementById("aiReorderBtn");
  const aiAuditBtn = document.getElementById("aiAuditBtn");
  const exportNameInput = document.getElementById("exportNameInput");
  const tableContainer = document.getElementById("tableContainer");
  const statusChip = document.getElementById("statusChip");
  const statusText = document.getElementById("statusText");
  const summaryPill = document.getElementById("summaryPill");
  const clearInputBtn = document.getElementById("clearInputBtn");
  const messageArea = document.getElementById("messageArea");
  const logList = document.getElementById("logList");
  const clearLogBtn = document.getElementById("clearLogBtn");

  const modalBackdrop = document.getElementById("modalBackdrop");
  const modalIndicator = document.getElementById("modalIndicator");
  const modalTitle = document.getElementById("modalTitle");
  const modalBody = document.getElementById("modalBody");
  const modalTag = document.getElementById("modalTag");
  const modalTagText = document.getElementById("modalTagText");
  const modalCloseBtn = document.getElementById("modalCloseBtn");
  const modalOkBtn = document.getElementById("modalOkBtn");

  /** @type {{name: string, phone: string, idcard: string, documentType?: string, country?: string, price?: string, position?: string, address: string, extra: string, groupId?: number}[]} */
  let currentRows = [];
  /** @type {string[]} */
  let currentErrors = [];
  /** @type {{time: string, summary: string, details?: string[]}[]} */
  let logs = [];
  let nextGroupId = 1;
  let previewPinnedColumns = [0, 1, 2];
  let draftTimer = null;
  let lastOriginalInputText = "";
  let originalInputBatches = [];
  let pendingOriginalInputText = "";
  let pendingNormalizedText = "";
  const DRAFT_KEY = "ticket_parser_preview_draft_v1";
  const apiBase = String(window.AI_API_BASE_URL || "").replace(/\/$/, "");
  const ticketApi = {
    normalize: `${apiBase}/api/ticket/normalize`,
    reorder: `${apiBase}/api/ticket/reorder`,
    audit: `${apiBase}/api/ticket/audit`,
  };

  function setExportEnabled(enabled) {
    exportBtn.disabled = !enabled;
    if (aiAuditBtn) aiAuditBtn.disabled = !enabled;
    if (enabled) {
      exportBtn.classList.add("ready");
      if (aiAuditBtn) aiAuditBtn.classList.add("ready");
    } else {
      exportBtn.classList.remove("ready");
      if (aiAuditBtn) aiAuditBtn.classList.remove("ready");
    }
  }

  function appendLog(summary, details) {
    if (!summary) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const time = `${hh}:${mm}:${ss}`;
    logs.push({
      time,
      summary,
      details: details && details.length ? [...details] : undefined,
    });
    if (logs.length > 200) {
      logs = logs.slice(logs.length - 200);
    }
    renderLogs();
  }

  function renderLogs() {
    if (!logs.length) {
      logList.innerHTML = '<div class="log-item">暂无日志。</div>';
      return;
    }
    const html = logs
      .map((log, index) => {
        const summary = `[${log.time}] ${log.summary}`;
        const hasDetails = log.details && log.details.length;
        return `
        <div class="log-item" data-log-index="${index}">
          <div class="log-summary">
            ${escapeHtml(summary)}
            ${
              hasDetails
                ? `<button type="button" class="log-toggle" data-log-index="${index}">详情</button>`
                : ""
            }
          </div>
          ${
            hasDetails
              ? `<div class="log-details" data-log-details="${index}" style="display:none;">
                  ${log.details.map((d) => `<div>${escapeHtml(d)}</div>`).join("")}
                 </div>`
              : ""
          }
        </div>`;
      })
      .join("");

    logList.innerHTML = html;

    const toggles = logList.querySelectorAll(".log-toggle");
    toggles.forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = btn.getAttribute("data-log-index");
        if (idx == null) return;
        const panel = logList.querySelector(`.log-details[data-log-details="${idx}"]`);
        if (!panel) return;
        const isHidden = panel.style.display === "none" || !panel.style.display;
        panel.style.display = isHidden ? "block" : "none";
        btn.textContent = isHidden ? "收起" : "详情";
      });
    });
  }

  function setStatus(text, type) {
    statusText.textContent = text;
    if (!type) return;
    statusChip.style.borderColor =
      type === "error"
        ? "rgba(248,113,113,0.9)"
        : type === "success"
        ? "rgba(52,211,153,0.9)"
        : "rgba(55,65,81,0.9)";
  }

  function openModal({ title, html, kind, tag }) {
    modalTitle.textContent = title;
    modalBody.innerHTML = html;
    modalIndicator.className = "modal-indicator " + (kind === "error" ? "error" : "success");
    modalIndicator.textContent = kind === "error" ? "!" : "✓";

    if (tag) {
      modalTag.style.display = "inline-flex";
      modalTagText.textContent = tag;
    } else {
      modalTag.style.display = "none";
      modalTagText.textContent = "";
    }

    modalBackdrop.classList.add("show");
  }

  function closeModal() {
    modalBackdrop.classList.remove("show");
  }

  modalCloseBtn.addEventListener("click", closeModal);
  modalOkBtn.addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  function normalizeText(raw) {
    if (!raw) return "";
    let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text
      .replace(/[　]/g, " ")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")")
      .replace(/[【]/g, "[")
      .replace(/[】]/g, "]")
      .replace(/[✖×]/g, "x")
      .replace(/[ \t]+/g, " ");
    return text.trim();
  }

  function splitBlocks(text) {
    const norm = normalizeText(text);
    if (!norm) return [];
    const parts = norm.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    return parts;
  }

  function normalizePhone(phone) {
    const match = String(phone || "").match(/1[3-9]\d{9}/);
    return match ? match[0] : "";
  }

  function dateStamp() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `${y}${m}${d}_${hh}${mm}${ss}`;
  }

  function defaultExportFilename() {
    return `购票信息_${dateStamp()}.xlsx`;
  }

  function normalizeFilename(name) {
    const base = String(name || "").trim() || defaultExportFilename();
    const cleaned = base.replace(/[\\/:*?"<>|]/g, "_");
    return /\.xlsx$/i.test(cleaned) ? cleaned : `${cleaned}.xlsx`;
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 250);
  }

  function saveDraft() {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          inputText: inputEl.value || "",
          originalInputText: lastOriginalInputText || "",
          originalInputBatches,
          rows: currentRows || [],
          exportName: exportNameInput ? exportNameInput.value : "",
          savedAt: Date.now(),
        })
      );
    } catch {}
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      inputEl.value = draft.inputText || "";
      originalInputBatches = Array.isArray(draft.originalInputBatches) ? draft.originalInputBatches : [];
      lastOriginalInputText =
        originalInputBatches.map((item) => item.raw_text || "").filter(Boolean).join("\n\n") ||
        draft.originalInputText ||
        draft.inputText ||
        "";
      currentRows = Array.isArray(draft.rows) ? normalizePreviewGroupIds(draft.rows) : [];
      if (exportNameInput) exportNameInput.value = draft.exportName || defaultExportFilename();
      if (currentRows.length) appendLog(`已恢复上次预览草稿：${currentRows.length} 条。`);
      return true;
    } catch {
      return false;
    }
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `API 请求失败：${response.status}`);
    }
    return data;
  }

  function createCellRef(colIndex, rowIndex) {
    return XLSX.utils.encode_cell({ c: colIndex, r: rowIndex });
  }

  function cloneCell(cell) {
    if (!cell) return null;
    return { ...cell };
  }

  function clearCellValue(cell) {
    if (!cell) return null;
    const cloned = { ...cell };
    delete cloned.v;
    delete cloned.w;
    delete cloned.r;
    delete cloned.h;
    delete cloned.f;
    if (!cloned.t) cloned.t = "z";
    return cloned;
  }

  function setSheetCell(sheet, colIndex, rowIndex, value) {
    const ref = createCellRef(colIndex, rowIndex);
    const baseCell = clearCellValue(sheet[ref]) || { t: "z" };
    if (value == null || value === "") {
      sheet[ref] = baseCell;
      return;
    }
    sheet[ref] = {
      ...baseCell,
      t: "s",
      v: String(value),
    };
  }

  function clearSheetRange(sheet, startRow, endRow, startCol, endCol) {
    for (let row = startRow; row <= endRow; row += 1) {
      for (let col = startCol; col <= endCol; col += 1) {
        const ref = createCellRef(col, row);
        if (sheet[ref]) {
          sheet[ref] = clearCellValue(sheet[ref]);
        }
      }
    }
  }

  function copyTemplateRow(sheet, sourceRow, targetRow, startCol, endCol) {
    for (let col = startCol; col <= endCol; col += 1) {
      const sourceRef = createCellRef(col, sourceRow);
      const targetRef = createCellRef(col, targetRow);
      const sourceCell = sheet[sourceRef];
      if (sourceCell) {
        sheet[targetRef] = clearCellValue(cloneCell(sourceCell));
      } else {
        delete sheet[targetRef];
      }
    }

    if (!sheet["!rows"]) sheet["!rows"] = [];
    const sourceMeta = sheet["!rows"][sourceRow];
    sheet["!rows"][targetRow] = sourceMeta ? { ...sourceMeta } : {};
  }

  function buildStructuredTemplateSheet(sheet, rows) {
    const firstOutputRow = 1;
    const lastOutputRow = 1993;
    const firstCol = 0;
    const lastCol = 7;
    const templateRow = {
      data: 1,
      subtotal: 4,
      spacer: 5,
      totalPeople: 13,
      totalAmount: 14,
    };

    clearSheetRange(sheet, firstOutputRow, lastOutputRow, firstCol, lastCol);
    sheet["!merges"] = [];

    let rowIndex = firstOutputRow;
    const groups = getGroupRows(rows);

    groups.forEach((group) => {
      const groupStartRow = rowIndex;

      group.rows.forEach((row, groupRowIndex) => {
        copyTemplateRow(sheet, templateRow.data, rowIndex, firstCol, lastCol);
        setSheetCell(sheet, 0, rowIndex, row.phone);
        setSheetCell(sheet, 1, rowIndex, row.name);
        setSheetCell(sheet, 2, rowIndex, row.documentType);
        setSheetCell(sheet, 3, rowIndex, row.documentNo);
        setSheetCell(sheet, 4, rowIndex, row.country);
        setSheetCell(sheet, 5, rowIndex, row.price);
        setSheetCell(sheet, 6, rowIndex, groupRowIndex === 0 ? row.position : "");
        setSheetCell(sheet, 7, rowIndex, row.size);
        rowIndex += 1;
      });

      if (group.rows.length > 1) {
        sheet["!merges"].push({
          s: { c: 6, r: groupStartRow },
          e: { c: 6, r: rowIndex - 1 },
        });
      }

      copyTemplateRow(sheet, templateRow.subtotal, rowIndex, firstCol, lastCol);
      setSheetCell(sheet, 3, rowIndex, "合计（金额）");
      setSheetCell(sheet, 5, rowIndex, `${groupTotal(group.rows)}元`);
      rowIndex += 1;

      copyTemplateRow(sheet, templateRow.spacer, rowIndex, firstCol, lastCol);
      rowIndex += 1;
    });

    copyTemplateRow(sheet, templateRow.totalPeople, rowIndex, firstCol, lastCol);
    setSheetCell(sheet, 3, rowIndex, "总人数");
    setSheetCell(sheet, 5, rowIndex, `${rows.length}人`);
    rowIndex += 1;

    copyTemplateRow(sheet, templateRow.totalAmount, rowIndex, firstCol, lastCol);
    setSheetCell(sheet, 3, rowIndex, "总合计");
    setSheetCell(sheet, 5, rowIndex, `${rowsTotal(rows)}元`);
    rowIndex += 1;

    sheet["!ref"] = XLSX.utils.encode_range({
      s: { c: 0, r: 0 },
      e: { c: 7, r: Math.max(rowIndex - 1, 14) },
    });
  }

  function clonePlain(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function captureExcelRowTemplate(worksheet, sourceRowNumber) {
    const sourceRow = worksheet.getRow(sourceRowNumber);
    const cells = [];

    for (let col = 1; col <= 8; col += 1) {
      const sourceCell = sourceRow.getCell(col);
      cells.push({
        style: clonePlain(sourceCell.style || {}),
        numFmt: sourceCell.numFmt || null,
        dataValidation: sourceCell.dataValidation ? clonePlain(sourceCell.dataValidation) : null,
        protection: sourceCell.protection ? clonePlain(sourceCell.protection) : null,
      });
    }

    return {
      height: sourceRow.height,
      cells,
    };
  }

  function applyExcelRowTemplate(worksheet, template, targetRowNumber) {
    const targetRow = worksheet.getRow(targetRowNumber);
    targetRow.height = template.height;

    for (let col = 1; col <= 8; col += 1) {
      const targetCell = targetRow.getCell(col);
      const sourceCell = template.cells[col - 1];
      targetCell.style = clonePlain(sourceCell.style || {});
      targetCell.numFmt = sourceCell.numFmt || undefined;
      targetCell.dataValidation = sourceCell.dataValidation ? clonePlain(sourceCell.dataValidation) : undefined;
      targetCell.protection = sourceCell.protection ? clonePlain(sourceCell.protection) : undefined;
      targetCell.value = null;
      targetCell.note = null;
      if (targetCell.model) {
        delete targetCell.model.note;
        delete targetCell.model.comment;
      }
      delete targetCell._comment;
    }
  }

  function clearExcelOutputArea(worksheet, startRow, endRow) {
    const mergeRanges = Object.keys(worksheet._merges || {});
    mergeRanges.forEach((range) => {
      const match = range.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/);
      if (!match) return;
      const from = Number(match[2]);
      const to = Number(match[4]);
      if (to >= startRow && from <= endRow) {
        worksheet.unMergeCells(range);
      }
    });

    for (let row = startRow; row <= endRow; row += 1) {
      const targetRow = worksheet.getRow(row);
      for (let col = 1; col <= 8; col += 1) {
        const cell = targetRow.getCell(col);
        cell.value = null;
        cell.note = null;
        if (cell.model) {
          delete cell.model.note;
          delete cell.model.comment;
        }
        delete cell._comment;
      }
    }
  }

  function buildStructuredExcelTemplateSheet(worksheet, rows) {
    const templateRows = {
      data: captureExcelRowTemplate(worksheet, 2),
      subtotal: captureExcelRowTemplate(worksheet, 10),
      spacer: captureExcelRowTemplate(worksheet, 11),
      totalPeople: captureExcelRowTemplate(worksheet, 14),
      totalAmount: captureExcelRowTemplate(worksheet, 15),
    };

    clearExcelOutputArea(worksheet, 2, 1994);

    let rowIndex = 2;
    const groups = getGroupRows(rows);

    groups.forEach((group) => {
      const groupStartRow = rowIndex;

      group.rows.forEach((row, groupRowIndex) => {
        applyExcelRowTemplate(worksheet, templateRows.data, rowIndex);
        const targetRow = worksheet.getRow(rowIndex);
        targetRow.getCell(1).value = row.phone || "";
        targetRow.getCell(2).value = row.name || "";
        targetRow.getCell(3).value = row.documentType || "";
        targetRow.getCell(4).value = row.documentNo || "";
        targetRow.getCell(5).value = row.country || "";
        targetRow.getCell(6).value = row.price || "";
        targetRow.getCell(7).value = groupRowIndex === 0 ? row.position || "" : "";
        targetRow.getCell(8).value = row.size || "";
        rowIndex += 1;
      });

      if (group.rows.length > 1) {
        worksheet.mergeCells(groupStartRow, 7, rowIndex - 1, 7);
      }

      applyExcelRowTemplate(worksheet, templateRows.subtotal, rowIndex);
      const subtotalRow = worksheet.getRow(rowIndex);
      subtotalRow.getCell(4).value = "合计（金额）";
      subtotalRow.getCell(6).value = `${groupTotal(group.rows)}元`;
      rowIndex += 1;

      applyExcelRowTemplate(worksheet, templateRows.spacer, rowIndex);
      rowIndex += 1;
    });

    applyExcelRowTemplate(worksheet, templateRows.totalPeople, rowIndex);
    const totalPeopleRow = worksheet.getRow(rowIndex);
    totalPeopleRow.getCell(4).value = "总人数";
    totalPeopleRow.getCell(6).value = `${rows.length}人`;
    rowIndex += 1;

    applyExcelRowTemplate(worksheet, templateRows.totalAmount, rowIndex);
    const totalAmountRow = worksheet.getRow(rowIndex);
    totalAmountRow.getCell(4).value = "总合计";
    totalAmountRow.getCell(6).value = `${rowsTotal(rows)}元`;
  }

  function lineStartBefore(text, index) {
    const pos = String(text || "").lastIndexOf("\n", Math.max(index, 0));
    return pos === -1 ? 0 : pos + 1;
  }

  function lineEndAfter(text, index) {
    const pos = String(text || "").indexOf("\n", Math.max(index, 0));
    return pos === -1 ? String(text || "").length : pos;
  }

  function previousLineStart(text, lineStart) {
    if (lineStart <= 0) return 0;
    const before = String(text || "").slice(0, Math.max(0, lineStart - 1));
    const pos = before.lastIndexOf("\n");
    return pos === -1 ? 0 : pos + 1;
  }

  function lineText(text, start, end) {
    return String(text || "").slice(start, end).trim();
  }

  function shouldAbsorbPreviousLine(text, anchorLineStart, previousAnchorEnd) {
    const prevStart = previousLineStart(text, anchorLineStart);
    if (prevStart === anchorLineStart || prevStart < previousAnchorEnd) return false;
    const prev = lineText(text, prevStart, Math.max(prevStart, anchorLineStart - 1));
    if (!prev) return false;
    if (/1[3-9]\d{9}/.test(prev)) return false;
    if (/\d{15,18}[\dXx]?/.test(prev)) return false;
    if (/(票价|元|层|区|区域|看台|主席台|预定|主场|球票|这八个人)/.test(prev)) return false;
    return /^(?:姓名|名字|联系人)?\s*[:：]?\s*(?:[\u4e00-\u9fa5]{2,8}|[A-Za-z][A-Za-z .'-]{1,50})$/i.test(prev);
  }

  function uniqueNonEmpty(values) {
    return Array.from(new Set(values.map((v) => String(v || "").trim()).filter(Boolean)));
  }

  function normalizeCountryName(raw) {
    const text = String(raw || "").trim();
    const mapping = {
      中国: "China",
      中国大陆: "China",
      中国内地: "China",
      中国香港: "Hong Kong",
      香港: "Hong Kong",
      中国澳门: "Macao",
      澳门: "Macao",
      中国台湾: "Taiwan",
      台湾: "Taiwan",
      美国: "United States",
      英国: "United Kingdom",
      日本: "Japan",
      韩国: "South Korea",
      朝鲜: "North Korea",
      加拿大: "Canada",
      澳大利亚: "Australia",
      新西兰: "New Zealand",
      新加坡: "Singapore",
      德国: "Germany",
      法国: "France",
      意大利: "Italy",
      西班牙: "Spain",
      俄罗斯: "Russia",
      泰国: "Thailand",
      马来西亚: "Malaysia",
      印度尼西亚: "Indonesia",
      菲律宾: "Philippines",
      越南: "Vietnam",
    };
    return mapping[text] || text;
  }

  function guessCountry(text, documentType) {
    const raw = String(text || "");
    const countryTokens = [
      "中国大陆",
      "中国内地",
      "中国香港",
      "中国澳门",
      "中国台湾",
      "中国",
      "香港",
      "澳门",
      "台湾",
      "美国",
      "英国",
      "日本",
      "韩国",
      "加拿大",
      "澳大利亚",
      "新西兰",
      "新加坡",
      "德国",
      "法国",
      "意大利",
      "西班牙",
      "俄罗斯",
      "泰国",
      "马来西亚",
      "印度尼西亚",
      "菲律宾",
      "越南",
    ];
    const hit = countryTokens.find((token) => raw.includes(token));
    if (hit) return normalizeCountryName(hit);
    if (documentType === "身份证") return "China";
    return "";
  }

  function guessPosition(text) {
    const raw = String(text || "");
    const directMatch =
      raw.match(/([一二三四五六七八九十]层\s*[A-Z]\d+(?:区|区域)?(?:看台)?)/) ||
      raw.match(/([一二三四五六七八九十]层\s*主席台)/) ||
      raw.match(/([一二三四五六七八九十]层\s*VIP\d*区?)/i);
    if (directMatch && directMatch[1]) {
      return directMatch[1].replace(/\s+/g, "");
    }

    const layerMatch = raw.match(/([一二三四五六七八九十]层)/);
    const zoneMatch =
      raw.match(/([A-Z]\d+(?:区|区域)?(?:看台)?)/) ||
      raw.match(/(主席台)/) ||
      raw.match(/(VIP\d*区?)/i);
    if (layerMatch && zoneMatch) {
      return `${layerMatch[1]}${String(zoneMatch[1]).replace(/\s+/g, "")}`;
    }
    if (zoneMatch && zoneMatch[1]) return String(zoneMatch[1]).replace(/\s+/g, "");
    return "";
  }

  function guessPrice(text) {
    const raw = String(text || "");
    const explicit = raw.match(/(?:票价|单价)?\s*(\d{2,4})\s*元/);
    if (explicit && explicit[1]) return explicit[1];
    const multiplier = raw.match(/(?:票价|单价)?\s*(\d{2,4})\s*[xX]\s*\d{1,2}/);
    if (multiplier && multiplier[1]) return multiplier[1];

    const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (!/(层|区|区域|看台|主席台|票价)/.test(line)) continue;
      const cleaned = line.replace(/\d{1,2}月\d{1,2}[号日]?/g, " ");
      const numbers = cleaned.match(/\b\d{2,4}\b/g) || [];
      const candidate = numbers.find((num) => Number(num) >= 80 && Number(num) <= 3000);
      if (candidate) return candidate;
    }
    return "";
  }

  function guessExpectedCount(text) {
    const raw = String(text || "");
    const match = raw.match(/(?:x|X)\s*(\d{1,2})|(\d{1,2})张/);
    if (!match) return 0;
    return Number(match[1] || match[2] || 0);
  }

  function extractAddress(block) {
    const addrRe = /(地址|住址|家庭住址)[ \t]*[:：][ \t]*([^\n]*)/;
    const m = block.match(addrRe);
    if (m && m[2] && m[2].trim()) return m[2].trim();
    return "";
  }

  function extractPhoneCandidates(block) {
    const phones = [];
    const re = /(^|[^\d])(1[3-9]\d{9})(?!\d)/g;
    let match;
    while ((match = re.exec(String(block || ""))) !== null) {
      phones.push(match[2]);
    }
    return uniqueNonEmpty(phones);
  }

  function isLikelyChineseId(value) {
    return /^(?:\d{15}|\d{17}[\dXx])$/.test(String(value || "").trim());
  }

  function isValidDateParts(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const date = new Date(`${year}-${month}-${day}T00:00:00`);
    return (
      date.getFullYear() === y &&
      date.getMonth() + 1 === m &&
      date.getDate() === d
    );
  }

  function isValidChineseIdCard(idcard) {
    const id = String(idcard || "").toUpperCase();
    if (/^\d{15}$/.test(id)) {
      return isValidDateParts(`19${id.slice(6, 8)}`, id.slice(8, 10), id.slice(10, 12));
    }
    if (/^\d{17}$/.test(id)) {
      return isValidDateParts(id.slice(6, 10), id.slice(10, 12), id.slice(12, 14));
    }
    if (!/^\d{17}[\dX]$/.test(id)) return false;
    if (!isValidDateParts(id.slice(6, 10), id.slice(10, 12), id.slice(12, 14))) return false;

    const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
    const sum = id
      .slice(0, 17)
      .split("")
      .reduce((acc, digit, index) => acc + Number(digit) * factors[index], 0);
    return checks[sum % 11] === id[17];
  }

  function guessDocumentTypeFromValue(value) {
    if (isLikelyChineseId(value)) return "身份证";
    if (/^[A-Z0-9]{5,20}$/i.test(String(value || ""))) return "护照";
    return "";
  }

  function extractPhone(block) {
    const re = /\b1[3-9]\d{9}\b/g;
    const matches = block.match(re);
    return matches && matches.length ? matches[0] : "";
  }

  function extractIdCard(block) {
    const re = /\d{17}[\dXx]|\d{15}/g;
    const matches = block.match(re);
    return matches && matches.length ? matches[0] : "";
  }

  function extractName(block, phone, idcard) {
    const labelRe = /(姓名|名字|联系人)\s*[:：]?\s*([^\s，,。；;]+)/;
    const m = block.match(labelRe);
    if (m && m[2]) return m[2].trim().replace(/[：:]+$/, "");

    const firstKeyIndexCandidates = [];
    if (phone) {
      const idx = block.indexOf(phone);
      if (idx >= 0) firstKeyIndexCandidates.push(idx);
    }
    if (idcard) {
      const idx = block.indexOf(idcard);
      if (idx >= 0) firstKeyIndexCandidates.push(idx);
    }
    if (!firstKeyIndexCandidates.length) return "";
    const firstIdx = Math.min(...firstKeyIndexCandidates);
    const beforeRaw = block.slice(0, firstIdx);

    const blacklist = ["电话", "手机", "联系电话", "住址", "地址"];

    // 优先按“第一行”猜测姓名，适配：
    //  梁艳
    //  电话：...
    const firstLine =
      beforeRaw
        .split(/\n/)
        .map((s) => s.trim())
        .find((s) => s.length) || "";
    if (firstLine) {
      let candidate = firstLine.replace(/(姓名|名字|联系人)\s*[:：]?\s*/g, "").trim();
      // 提取前 2~5 个连续中文作为姓名
      const firstNameMatch = candidate.match(/^[\u4e00-\u9fa5]{1,5}/);
      if (firstNameMatch) candidate = firstNameMatch[0];
      if (candidate && !blacklist.includes(candidate)) {
        return candidate.replace(/[：:]+$/, "");
      }
    }

    // 退回到旧逻辑：取关键字段前最后一段中文
    const before = beforeRaw.replace(/[\n]/g, " ").trim();
    if (!before) return "";
    const chineseNameRe = /([\u4e00-\u9fa5]{2,5})$/;
    const m2 = before.match(chineseNameRe);
    if (m2 && m2[1]) return m2[1].trim().replace(/[：:]+$/, "");
    const tokens = before.split(/[，,。；; ]+/).filter(Boolean);
    const last = tokens.length ? tokens[tokens.length - 1] : "";
    return last.replace(/[：:]+$/, "");
  }

  function removeOnce(str, part) {
    if (!part) return str;
    const idx = str.indexOf(part);
    if (idx === -1) return str;
    return str.slice(0, idx) + str.slice(idx + part.length);
  }

  function extractDocumentAnchors(block) {
    /** @type {{type: string, value: string, index: number, end: number}[]} */
    const anchors = [];
    const raw = String(block || "");

    const passportRe = /(护照(?:号|号码)?|passport(?:\s*no\.?)?)\s*[:：]?\s*([A-Z0-9]{5,20})/gi;
    let match;
    while ((match = passportRe.exec(raw)) !== null) {
      const value = String(match[2] || "").trim();
      const index = match.index + match[0].lastIndexOf(value);
      anchors.push({ type: "护照", value, index, end: index + value.length });
    }

    const idRe = /\b(?:\d{15}|\d{17}[\dXx])\b/g;
    while ((match = idRe.exec(raw)) !== null) {
      const value = String(match[0] || "").trim();
      anchors.push({ type: "身份证", value, index: match.index, end: match.index + value.length });
    }

    return anchors.sort((a, b) => a.index - b.index);
  }

  function extractNameFromSegment(segment, anchorValue) {
    const text = String(segment || "");
    const fullNameMatch = text.match(/名\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{0,30})\s*姓\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{0,30})/i);
    if (fullNameMatch) {
      return `${fullNameMatch[2].trim()} ${fullNameMatch[1].trim()}`.trim();
    }

    const labeledName =
      text.match(/(?:姓名|名字|联系人)\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{1,40}|[\u4e00-\u9fa5]{2,6})/i) ||
      text.match(/名\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{1,40}|[\u4e00-\u9fa5]{1,6})/i);
    if (labeledName && labeledName[1]) return labeledName[1].trim();

    const anchorIndex = anchorValue ? text.indexOf(anchorValue) : -1;
    const before = anchorIndex >= 0 ? text.slice(0, anchorIndex) : text;
    const after = anchorIndex >= 0 ? text.slice(anchorIndex + anchorValue.length) : "";

    const chineseTail = before.match(/([\u4e00-\u9fa5]{2,6})\s*[,，:：]?\s*$/);
    if (chineseTail && chineseTail[1]) return chineseTail[1].trim();

    const latinTail = before.match(/([A-Za-z][A-Za-z .'-]{1,40})\s*[,，:：]?\s*$/);
    if (latinTail && latinTail[1]) return latinTail[1].trim();

    const chineseAfter = after.match(/^\s*([\u4e00-\u9fa5]{2,6})/);
    if (chineseAfter && chineseAfter[1]) return chineseAfter[1].trim();

    const latinAfter = after.match(/^\s*([A-Za-z][A-Za-z .'-]{1,40})/);
    if (latinAfter && latinAfter[1]) return latinAfter[1].trim();

    return "";
  }

  function buildExtraText(segment, row, blockContext) {
    let extra = String(segment || "");
    const removable = [
      row.name,
      row.phone,
      row.idcard,
      row.address,
      row.country,
      row.price,
      row.position,
      blockContext.price,
      blockContext.position,
      blockContext.country,
    ];
    removable.forEach((part) => {
      extra = removeOnce(extra, part);
    });

    extra = extra
      .replace(
        /(联系电话|身份证号|护照号|手机号|家庭住址|姓名|名字|联系人|手机|电话|身份证|护照|passport|地址|住址|票价|位置|国家|国籍|地区|名|姓)\s*[:：]?/gi,
        " "
      )
      .replace(/其他\s*[:：]?/gi, " ")
      .replace(/\d{1,2}月\d{1,2}[号日]?/g, " ")
      .replace(/(^|\s)元(?=\s|$)/g, " ")
      .replace(/[：:]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    return extra;
  }

  function buildRowsFromBlock(block, blockIndex) {
    const rows = [];
    const anchors = extractDocumentAnchors(block);
    const blockContext = {
      country: guessCountry(block, ""),
      price: guessPrice(block),
      position: guessPosition(block),
      expectedCount: guessExpectedCount(block),
    };

    if (!anchors.length) {
      const phone = extractPhone(block);
      const idcard = extractIdCard(block);
      const name = extractName(block, phone, idcard);
      const address = extractAddress(block);
      if (!phone && !idcard && !name && !address) return rows;

      const documentType = guessDocumentTypeFromValue(idcard);
      const row = {
        name: name || "",
        phone: phone || "",
        idcard: idcard || "",
        documentType,
        country: guessCountry(block, documentType),
        price: blockContext.price || "",
        position: blockContext.position || "",
        address: address || "",
        extra: "",
        _blockIndex: blockIndex + 1,
      };
      row.extra = buildExtraText(block, row, blockContext);
      rows.push(row);
      return rows;
    }

    const segmentStarts = anchors.map((anchor, idx) => {
      const anchorLineStart = lineStartBefore(block, anchor.index);
      const previousAnchorEnd = idx === 0 ? 0 : anchors[idx - 1].end;
      return shouldAbsorbPreviousLine(block, anchorLineStart, previousAnchorEnd)
        ? previousLineStart(block, anchorLineStart)
        : anchorLineStart;
    });

    anchors.forEach((anchor, idx) => {
      const start = segmentStarts[idx];
      const end = idx === anchors.length - 1 ? block.length : segmentStarts[idx + 1];
      const segment = block.slice(start, end).trim();
      const phoneCandidates = extractPhoneCandidates(segment);
      const documentType = anchor.type;
      const row = {
        name: extractNameFromSegment(segment, anchor.value),
        phone: phoneCandidates[0] || "",
        idcard: anchor.value,
        documentType,
        country: guessCountry(segment, documentType) || blockContext.country || guessCountry("", documentType),
        price: guessPrice(segment) || blockContext.price || "",
        position: guessPosition(segment) || blockContext.position || "",
        address: extractAddress(segment) || "",
        extra: "",
        _blockIndex: blockIndex + 1,
      };
      row.extra = buildExtraText(segment, row, blockContext);
      rows.push(row);
    });

    return rows;
  }

  function buildRowsFromText(text) {
    const blocks = splitBlocks(text);
    /** @type {{name: string, phone: string, idcard: string, documentType: string, country: string, price: string, position: string, address: string, extra: string}[]} */
    const rows = [];

    blocks.forEach((block, blockIndex) => {
      const r = buildRowsFromBlock(block, blockIndex);
      const groupPhone = r.map((row) => normalizePhone(row.phone)).find(Boolean);
      if (groupPhone) {
        r.forEach((row) => {
          if (!normalizePhone(row.phone)) row.phone = groupPhone;
        });
      }
      rows.push(...r);
    });

    return rows;
  }

  function validateRows(rows) {
    /** @type {string[]} */
    const errors = [];

    rows.forEach((row, idx) => {
      const indexLabel = `第 ${idx + 1} 条用户信息`;

      if (!row.name) {
        errors.push(`${indexLabel}：未识别出姓名。`);
      }

      if (!row.phone) {
        errors.push(`${indexLabel}：未识别出手机号。`);
      } else {
        const phone = normalizePhone(row.phone);
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          errors.push(
            `${indexLabel}：手机号 “${phone}” 格式不正确（应为以 1 开头的 11 位中国大陆手机号）。`
          );
        }
      }

      if (!row.idcard) {
        errors.push(`${indexLabel}：未识别出证件号。`);
      } else {
        const documentType = row.documentType || guessDocumentTypeFromValue(row.idcard);
        const id = row.idcard.toUpperCase();
        if (documentType === "身份证") {
          if (!isLikelyChineseId(id)) {
            errors.push(
              `${indexLabel}：身份证号 “${row.idcard}” 格式不正确（支持 15~18 位，18 位最后一位可为 X）。`
            );
          } else if (!isValidChineseIdCard(id)) {
            errors.push(`${indexLabel}：身份证号 “${row.idcard}” 校验未通过，请人工确认。`);
          }
        } else if (documentType === "护照") {
          if (!/^[A-Z0-9]{5,20}$/i.test(id)) {
            errors.push(`${indexLabel}：护照号 “${row.idcard}” 格式不正确，请人工确认。`);
          }
        } else {
          errors.push(`${indexLabel}：未识别出证件类型，请人工确认该证件号。`);
        }
      }
    });

    return errors;
  }

  function tableInput(scope, index, field, value) {
    return `<input class="table-input" data-scope="${scope}" data-index="${index}" data-field="${field}" value="${escapeHtml(value || "")}" />`;
  }

  function getRowsFromTable() {
    const rows = currentRows.map((row) => ({ ...row }));

    tableContainer.querySelectorAll('input[data-scope="preview"][data-index][data-field]').forEach((input) => {
      const index = Number(input.getAttribute("data-index"));
      const field = input.getAttribute("data-field");
      if (!rows[index] || !field) return;
      rows[index][field] = input.value.trim();
    });

    return rows;
  }

  function syncPreviewRowsFromDom() {
    currentRows = getRowsFromTable();
    currentErrors = validateRows(currentRows);
    setExportEnabled(currentRows.length > 0);
  }

  function getGroupRows(rows) {
    const groups = [];
    const byGroup = new Map();
    rows.forEach((row) => {
      const groupId = row.groupId || 1;
      if (!byGroup.has(groupId)) {
        const group = { groupId, rows: [] };
        byGroup.set(groupId, group);
        groups.push(group);
      }
      byGroup.get(groupId).rows.push(row);
    });
    return groups;
  }

  function groupTotal(rows) {
    return rows.reduce((sum, row) => {
      const value = Number(row.price || 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
  }

  function rowsTotal(rows) {
    return rows.reduce((sum, row) => {
      const value = Number(row.price || 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
  }

  function normalizeParsedRows(rows) {
    const groups = new Map();
    let seed = nextGroupId;

    rows.forEach((row) => {
      const sourceGroup = row.groupId || row._blockIndex || 1;
      if (!groups.has(sourceGroup)) {
        groups.set(sourceGroup, seed++);
      }
    });

    nextGroupId = seed;

    return rows.map((row) => ({
      name: row.name || "",
      phone: normalizePhone(row.phone || "") || row.phone || "",
      documentType: row.documentType || guessDocumentTypeFromValue(row.idcard),
      idcard: String(row.idcard || "").toUpperCase(),
      country: row.country || guessCountry("", row.documentType || guessDocumentTypeFromValue(row.idcard)),
      price: row.price || "",
      position: row.position || "",
      size: row.size || "",
      address: row.address || "",
      extra: row.extra || "",
      groupId: groups.get(row.groupId || row._blockIndex || 1) || 1,
    }));
  }

  function normalizePreviewGroupIds(rows) {
    const orderedGroups = getGroupRows(rows);
    const normalized = new Map();
    let seed = 1;

    orderedGroups.forEach((group) => {
      normalized.set(group.groupId, seed++);
    });

    nextGroupId = Math.max(nextGroupId, seed);

    return rows.map((row) => ({
      ...row,
      groupId: normalized.get(row.groupId || 1) || 1,
    }));
  }

  function getPreviewColumnDefs() {
    return [
      { label: "No", className: "no-col" },
      { label: "持票人手机号/邮箱", className: "phone-col" },
      { label: "观演实名信息姓名", className: "name-col" },
      { label: "观演实名信息证件类型" },
      { label: "观演实名信息证件号" },
      { label: "国家地区" },
      { label: "票价" },
      { label: "位置" },
      { label: "尺码" },
      { label: "操作" },
    ];
  }

  function renderPreviewHeader(column, index) {
    const pinned = previewPinnedColumns.includes(index);
    const className = column.className ? ` class="${column.className}"` : "";
    return `<th${className} data-col-index="${index}">
      <span class="th-with-pin">
        <span>${column.label}</span>
        <button type="button" aria-label="${pinned ? "取消固定此列" : "固定此列"}" class="pin-toggle ${pinned ? "active" : ""}" data-pin-col="${index}" title="${pinned ? "取消固定此列" : "固定此列"}"></button>
      </span>
    </th>`;
  }

  function applyPinnedPreviewColumns() {
    const table = tableContainer.querySelector(".template-table");
    if (!table) return;

    table.querySelectorAll(".is-pinned").forEach((cell) => {
      cell.classList.remove("is-pinned");
      cell.style.left = "";
    });

    const pinned = [...previewPinnedColumns].sort((a, b) => a - b);
    let left = 0;

    pinned.forEach((colIndex) => {
      const header = table.querySelector(`th[data-col-index="${colIndex}"]`);
      if (!header) return;
      const width = header.getBoundingClientRect().width;
      table.querySelectorAll(`th[data-col-index="${colIndex}"], td[data-col-index="${colIndex}"]`).forEach((cell) => {
        cell.classList.add("is-pinned");
        cell.style.left = `${left}px`;
      });
      left += width;
    });
  }

  function renderTable(rows) {
    currentRows = rows.map((row) => ({ ...row, groupId: row.groupId || 1 }));
    if (!currentRows.length) {
      tableContainer.innerHTML =
        '<div class="dim" style="padding: 16px;">暂无正式预览。粘贴原始文本后点击“开始识别拆分”。</div>';
      summaryPill.textContent = "当前无数据";
      currentErrors = [];
      setExportEnabled(false);
      scheduleDraftSave();
      return;
    }

    const groups = getGroupRows(currentRows);
    let rowNo = 0;
    const bodyRows = groups
      .map((group, groupIndex) => {
        const dataRows = group.rows
          .map((row) => {
            const index = rowNo;
            rowNo += 1;
            return `
              <tr>
                <td data-col-index="0">${index + 1}</td>
                <td data-col-index="1">${tableInput("preview", index, "phone", row.phone)}</td>
                <td data-col-index="2">${tableInput("preview", index, "name", row.name)}</td>
                <td data-col-index="3">${tableInput("preview", index, "documentType", row.documentType)}</td>
                <td data-col-index="4">${tableInput("preview", index, "idcard", row.idcard)}</td>
                <td data-col-index="5">${tableInput("preview", index, "country", row.country)}</td>
                <td data-col-index="6">${tableInput("preview", index, "price", row.price)}</td>
                <td data-col-index="7">${tableInput("preview", index, "position", row.position)}</td>
                <td data-col-index="8">${tableInput("preview", index, "size", row.size)}</td>
                <td class="row-actions" data-col-index="9">
                  <button type="button" class="row-button" data-preview-action="prev-group" data-index="${index}">上一组</button>
                  <button type="button" class="row-button" data-preview-action="next-group" data-index="${index}">下一组</button>
                  <button type="button" class="row-button" data-preview-action="delete" data-index="${index}">删</button>
                </td>
              </tr>
            `;
          })
          .join("");

        const total = groupTotal(group.rows);
        return `
          ${dataRows}
          <tr class="group-summary">
            <td colspan="4">第 ${groupIndex + 1} 组小计</td>
            <td>合计（金额）</td>
            <td></td>
            <td>${total || ""}</td>
            <td colspan="3">${group.rows.length} 人</td>
          </tr>
        `;
      })
      .join("");
    const totalAmount = rowsTotal(currentRows);

    const columns = getPreviewColumnDefs();
    const headerHtml = columns.map((column, index) => renderPreviewHeader(column, index)).join("");

    tableContainer.innerHTML = `
      <div class="table-toolbar">
        <div class="table-toolbar-left">
          <button type="button" class="table-mini-btn" id="clearPreviewBtn">清空预览</button>
        </div>
        <div class="table-toolbar-right">
          <span>正式预览 ${currentRows.length} 条 / ${groups.length} 组</span>
        </div>
      </div>
      <table class="template-table">
        <thead>
          <tr>${headerHtml}</tr>
        </thead>
        <tbody>
          ${bodyRows}
          <tr class="group-summary">
            <td colspan="4">总人数</td>
            <td></td>
            <td></td>
            <td>${currentRows.length}人</td>
            <td colspan="3"></td>
          </tr>
          <tr class="group-summary">
            <td colspan="4">总合计</td>
            <td></td>
            <td></td>
            <td>${totalAmount}元</td>
            <td colspan="3"></td>
          </tr>
        </tbody>
      </table>
    `;

    currentErrors = validateRows(currentRows);
    setExportEnabled(currentRows.length > 0);
    summaryPill.textContent = `正式预览 ${currentRows.length} 条 / ${groups.length} 组`;
    attachPreviewHandlers();
    applyPinnedPreviewColumns();
    scheduleDraftSave();
  }

  function attachPreviewHandlers() {
    document.getElementById("clearPreviewBtn")?.addEventListener("click", () => {
      currentRows = [];
      currentErrors = [];
      originalInputBatches = [];
      lastOriginalInputText = "";
      renderTable(currentRows);
      appendLog("已清空购票模板预览和原文批次。");
    });

    tableContainer.querySelectorAll("[data-pin-col]").forEach((button) => {
      button.addEventListener("click", () => {
        const colIndex = Number(button.getAttribute("data-pin-col"));
        if (Number.isNaN(colIndex)) return;
        if (previewPinnedColumns.includes(colIndex)) {
          previewPinnedColumns = previewPinnedColumns.filter((value) => value !== colIndex);
        } else {
          previewPinnedColumns = [...previewPinnedColumns, colIndex].sort((a, b) => a - b);
        }
        renderTable(getRowsFromTable());
      });
    });

    tableContainer.querySelectorAll("[data-preview-action]").forEach((button) => {
      button.addEventListener("click", () => {
        syncPreviewRowsFromDom();
        const index = Number(button.getAttribute("data-index"));
        const action = button.getAttribute("data-preview-action");
        const row = currentRows[index];
        if (!row) return;

        if (action === "delete") {
          currentRows.splice(index, 1);
        } else if (action === "prev-group") {
          const groupIds = getGroupRows(currentRows).map((group) => group.groupId);
          const pos = groupIds.indexOf(row.groupId || 1);
          if (pos > 0) {
            row.groupId = groupIds[pos - 1];
          }
        } else if (action === "next-group") {
          const groupIds = getGroupRows(currentRows).map((group) => group.groupId);
          const pos = groupIds.indexOf(row.groupId || 1);
          row.groupId = pos >= 0 && pos < groupIds.length - 1 ? groupIds[pos + 1] : nextGroupId++;
        }

        currentRows = normalizePreviewGroupIds(currentRows);
        analyzeDuplicates(currentRows);
        renderTable(currentRows);
      });
    });

    tableContainer.querySelectorAll('input[data-scope="preview"]').forEach((input) => {
      input.addEventListener("change", () => {
        syncPreviewRowsFromDom();
        renderTable(currentRows);
      });
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function analyzeDuplicates(rows) {
    rows.forEach((r) => {
      r._dupNameId = false;
      r._warnPhone = false;
      r._warnAddress = false;
      r._warnExtra = false;
    });

    /** @type {string[]} */
    const duplicateMessages = [];
    /** @type {string[]} */
    const warningMessages = [];

    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        const label = `第 ${i + 1} 行 与 第 ${j + 1} 行`;

        if (a.name && b.name && a.idcard && b.idcard && a.name === b.name && a.idcard === b.idcard) {
          a._dupNameId = true;
          b._dupNameId = true;
          duplicateMessages.push(`${label}：姓名 + 身份证号 完全相同。`);
          continue;
        }

        if (
          a.phone &&
          b.phone &&
          a.phone === b.phone &&
          a.name &&
          b.name &&
          a.name !== b.name
        ) {
          a._warnPhone = true;
          b._warnPhone = true;
          warningMessages.push(`${label}：手机号相同，但姓名不同（可能共用一个号码）。`);
        }

        if (
          a.address &&
          b.address &&
          a.address === b.address &&
          a.name &&
          b.name &&
          a.name !== b.name
        ) {
          a._warnAddress = true;
          b._warnAddress = true;
          warningMessages.push(`${label}：地址相同，但姓名不同（可能为同一家庭住址）。`);
        }

        if (
          a.extra &&
          b.extra &&
          a.extra === b.extra &&
          a.name &&
          b.name &&
          a.name !== b.name
        ) {
          a._warnExtra = true;
          b._warnExtra = true;
          warningMessages.push(`${label}：“其他”栏内容相同，但姓名不同（请确认是否同一用户）。`);
        }
      }
    }

    return { duplicateMessages, warningMessages };
  }

  function setMessage(kind, text) {
    messageArea.textContent = "";
    messageArea.classList.remove("success", "error");
    if (!text) return;
    messageArea.textContent = text;
    if (kind === "success") {
      messageArea.classList.add("success");
    } else if (kind === "error") {
      messageArea.classList.add("error");
    }
  }

  function appendParsedTextToPreview(text, sourceLabel) {
    const norm = normalizeText(text);
    if (!norm) {
      setStatus("未检测到文本", "error");
      setMessage("error", "没有检测到文本，请先在左侧粘贴需要拆分的原始文本。");
      return false;
    }

    setStatus("正在识别…", "neutral");
    const newRows = buildRowsFromText(norm);

    if (!newRows.length) {
      setStatus("未识别到用户信息", "error");
      setMessage("error", "未识别出任何用户信息，请确认文本中包含可识别的手机号 / 身份证号等关键信息。");
      currentErrors = ["未识别到用户信息"];
      appendLog("本次解析：未识别出任何用户信息。");
      return false;
    }

    const normalizedNewRows = normalizeParsedRows(newRows);
    currentRows = [...currentRows, ...normalizedNewRows];
    const errors = validateRows(currentRows);
    const { duplicateMessages, warningMessages } = analyzeDuplicates(currentRows);
    renderTable(currentRows);

    if (errors.length) {
      setStatus("解析完成，存在错误", "error");
      setMessage("error", `本次解析发现 ${errors.length} 条格式问题，请在日志中查看具体位置。`);
      appendLog(`本次解析存在 ${errors.length} 条格式问题。`, errors.map((e) => `格式问题：${e}`));
    } else {
      setStatus("解析成功，已进入预览", "success");
      const dupCount = duplicateMessages.length;
      const warnCount = warningMessages.length;
      setMessage(
        "success",
        `本次新增 ${normalizedNewRows.length} 条，已追加到预览表格（重复组 ${dupCount}，警告组 ${warnCount}）。`
      );
      appendLog(
        `${sourceLabel || "识别成功"}：本次新增 ${normalizedNewRows.length} 条，预览共 ${currentRows.length} 条；重复组 ${dupCount}，警告组 ${warnCount}。`,
        [...duplicateMessages.map((m) => `重复：${m}`), ...warningMessages.map((m) => `警告：${m}`)]
      );
    }
    return true;
  }

  async function handleParse() {
    const raw = inputEl.value;
    const norm = normalizeText(raw);
    if (!norm) {
      setStatus("未检测到文本", "error");
      setMessage("error", "没有检测到文本，请先在左侧粘贴需要拆分的原始文本。");
      return;
    }

    const sourceRaw =
      pendingOriginalInputText && normalizeText(raw) === normalizeText(pendingNormalizedText)
        ? pendingOriginalInputText
        : raw;
    parseBtn.disabled = true;
    aiNormalizeBtn.disabled = true;
    setStatus("AI 正在规范化…", "neutral");
    appendLog("开始识别：AI 正在规范化本次输入。");

    try {
      const data = await postJson(ticketApi.normalize, { raw_text: sourceRaw });
      const normalized = String(data.normalized_text || "").trim();
      if (!normalized) throw new Error("AI 未返回规范化文本");

      inputEl.value = normalized;
      const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
      appendLog(
        data.summary || "AI规范化：已完成，交给正则拆分。",
        warnings.slice(0, 12).map((item) => `警告：${item}`)
      );

      const beforeCount = currentRows.length;
      const ok = appendParsedTextToPreview(normalized, "识别成功");
      if (ok) {
        const addedCount = Math.max(0, currentRows.length - beforeCount);
        originalInputBatches.push({
          batch_no: originalInputBatches.length + 1,
          raw_text: sourceRaw,
          normalized_text: normalized,
          added_count: addedCount,
          created_at: new Date().toISOString(),
        });
        lastOriginalInputText = originalInputBatches.map((item) => item.raw_text).filter(Boolean).join("\n\n");
        pendingOriginalInputText = "";
        pendingNormalizedText = "";
        inputEl.value = "";
        appendLog("输入框已清空，可以继续粘贴下一波信息。");
        scheduleDraftSave();
      }
    } catch (error) {
      setStatus("AI 规范化失败", "error");
      setMessage("error", error.message || "AI 规范化失败，原文已保留。");
      appendLog(`开始识别失败：${error.message || "未知错误"}。原文已保留。`);
    } finally {
      parseBtn.disabled = false;
      aiNormalizeBtn.disabled = false;
    }
  }

  async function handleAiNormalize() {
    const raw = inputEl.value;
    const norm = normalizeText(raw);
    if (!norm) {
      setStatus("未检测到文本", "error");
      setMessage("error", "没有检测到文本，无法进行 AI 规范化。");
      return;
    }

    aiNormalizeBtn.disabled = true;
    setStatus("AI 正在规范化…", "neutral");
    appendLog("AI规范化：已提交，等待返回。");

    try {
      const data = await postJson(ticketApi.normalize, { raw_text: raw });
      const normalized = String(data.normalized_text || "").trim();
      if (!normalized) throw new Error("AI 未返回规范化文本");

      inputEl.value = normalized;
      pendingOriginalInputText = raw;
      pendingNormalizedText = normalized;
      const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
      appendLog(
        data.summary || `AI规范化：已完成，未自动加入预览。`,
        warnings.slice(0, 12).map((item) => `警告：${item}`)
      );
      scheduleDraftSave();
    } catch (error) {
      setStatus("AI 规范化失败", "error");
      setMessage("error", error.message || "AI 规范化失败，请检查后端服务。");
      appendLog(`AI规范化失败：${error.message || "未知错误"}`);
    } finally {
      aiNormalizeBtn.disabled = false;
    }
  }

  function buildAiRows(rows) {
    return rows.map((row) => ({
      name: row.name || "",
      phone: row.phone || "",
      documentType: row.documentType || "",
      idcard: row.idcard || "",
      country: row.country || "",
      price: row.price || "",
      position: row.position || "",
      address: row.address || "",
      extra: row.extra || "",
      groupId: row.groupId || 1,
    }));
  }

  async function handleAiReorder() {
    syncPreviewRowsFromDom();
    const instruction = String(aiOrderInput.value || "").trim();
    if (!instruction) {
      appendLog("位置调整：请输入要调整的位置指令。");
      return;
    }
    if (!currentRows.length) {
      appendLog("位置调整：当前没有可调整的预览数据。");
      return;
    }

    aiReorderBtn.disabled = true;
    setStatus("AI 正在调整顺序…", "neutral");

    try {
      const data = await postJson(ticketApi.reorder, {
        instruction,
        rows: buildAiRows(currentRows),
      });
      const ordered = Array.isArray(data.ordered_row_ids) ? data.ordered_row_ids.map(String) : [];
      const expected = currentRows.map((_, index) => `R${index + 1}`);
      const sameSet =
        ordered.length === expected.length &&
        expected.every((id) => ordered.includes(id)) &&
        new Set(ordered).size === expected.length;
      if (!sameSet) throw new Error("AI 返回的行顺序不完整，已拒绝应用。");

      const oldRows = currentRows.map((row) => ({ ...row }));
      currentRows = ordered.map((id) => oldRows[Number(id.slice(1)) - 1]).filter(Boolean);
      renderTable(currentRows);
      appendLog(data.summary || "位置调整：已按指令重排现有预览行。");
      aiOrderInput.value = "";
      setStatus("顺序已调整", "success");
    } catch (error) {
      setStatus("AI 调整失败", "error");
      appendLog(`位置调整失败：${error.message || "未知错误"}`);
    } finally {
      aiReorderBtn.disabled = false;
    }
  }

  function currentTotals(rows) {
    return {
      personCount: rows.length,
      groupCount: getGroupRows(rows).length,
      totalAmount: rowsTotal(rows),
    };
  }

  async function handleAiAudit() {
    syncPreviewRowsFromDom();
    if (!currentRows.length) {
      appendLog("最终检查：当前没有可检查的预览数据。");
      return;
    }

    aiAuditBtn.disabled = true;
    setStatus("AI 正在最终检查…", "neutral");

    try {
      const data = await postJson(ticketApi.audit, {
        raw_text: lastOriginalInputText || inputEl.value || "",
        source_batches: originalInputBatches,
        normalized_text: inputEl.value || "",
        rows: buildAiRows(currentRows),
        totals: currentTotals(currentRows),
      });
      const issues = Array.isArray(data.issues) ? data.issues.filter(Boolean) : [];
      appendLog(
        data.summary || (data.ok ? "最终检查：未发现明显问题。" : "最终检查：发现需要确认的问题。"),
        issues.slice(0, 12).map((item) => `${data.ok ? "提示" : "问题"}：${item}`)
      );
      setStatus(data.ok ? "最终检查通过" : "最终检查有提示", data.ok ? "success" : "error");
    } catch (error) {
      setStatus("AI 最终检查失败", "error");
      appendLog(`最终检查失败：${error.message || "未知错误"}`);
    } finally {
      aiAuditBtn.disabled = false;
    }
  }

  function handleExport() {
    syncPreviewRowsFromDom();
    if (!currentRows.length) {
      return;
    }
    if (currentErrors.length) {
      openModal({
        title: "带提示导出",
        html: `<p>正式预览中还有 ${currentErrors.length} 条格式问题，本次会继续导出，请你在导出的 Excel 中再次核对。</p><ul>${currentErrors
          .slice(0, 8)
          .map((e) => `<li>${escapeHtml(e)}</li>`)
          .join("")}</ul>`,
        kind: "error",
        tag: "仅提醒，不阻止导出",
      });
      appendLog(
        `导出前提示：当前有 ${currentErrors.length} 条格式问题，本次未阻止导出。`,
        currentErrors.map((e) => `格式问题：${e}`)
      );
    }
    if (typeof ExcelJS === "undefined") {
      openModal({
        title: "导出失败",
        html: "<p>未检测到 Excel 导出库（ExcelJS）。请检查网络或稍后重试。</p>",
        kind: "error",
        tag: "前端导出依赖加载失败",
      });
      return;
    }

    const rows = currentRows.map((row) => ({
      phone: String(normalizePhone(row.phone || "") || row.phone || ""),
      name: row.name || "",
      documentType: row.documentType || guessDocumentTypeFromValue(row.idcard),
      documentNo: String(row.idcard || "").toUpperCase(),
      country: row.country || "",
      price: row.price ? String(row.price) : "",
      position: row.position || "",
      size: row.size || "",
      groupId: row.groupId || 1,
    }));

    const filename = normalizeFilename(exportNameInput ? exportNameInput.value : "");
    if (exportNameInput) exportNameInput.value = filename;

    const templateUrl = new URL("../../购票模板.xlsx", window.location.href).href;

    fetch(templateUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`模板文件加载失败：${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then(async (buffer) => {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const worksheet = workbook.getWorksheet("0") || workbook.worksheets[0];
        if (!worksheet) {
          throw new Error("模板工作表不存在。");
        }

        buildStructuredExcelTemplateSheet(worksheet, rows);

        const output = await workbook.xlsx.writeBuffer();
        const blob = new Blob([output], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        appendLog(`已按购票模板结构导出 Excel：${filename}（共 ${rows.length} 条记录，${getGroupRows(rows).length} 组）。`);
        scheduleDraftSave();
      })
      .catch((error) => {
        openModal({
          title: "模板导出失败",
          html: `<p>${escapeHtml(error.message || "无法读取购票模板文件。")}</p><p>请确认当前页面与 <code>购票模板.xlsx</code> 在同一静态站点中发布。</p>`,
          kind: "error",
          tag: "模板文件读取失败",
        });
      });
  }

  parseBtn.addEventListener("click", handleParse);
  exportBtn.addEventListener("click", handleExport);
  aiNormalizeBtn.addEventListener("click", handleAiNormalize);
  aiReorderBtn.addEventListener("click", handleAiReorder);
  aiAuditBtn.addEventListener("click", handleAiAudit);
  inputEl.addEventListener("input", scheduleDraftSave);
  exportNameInput.addEventListener("input", scheduleDraftSave);
  clearInputBtn.addEventListener("click", () => {
    inputEl.value = "";
    pendingOriginalInputText = "";
    pendingNormalizedText = "";
    appendLog("已清空输入文本。");
    scheduleDraftSave();
  });
  clearLogBtn.addEventListener("click", () => {
    logs = [];
    renderLogs();
  });

  if (!loadDraft() && exportNameInput) {
    exportNameInput.value = defaultExportFilename();
  }
  renderLogs();
  renderTable(currentRows);
})();
