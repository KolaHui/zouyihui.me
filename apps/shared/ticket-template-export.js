(() => {
  "use strict";

  function clonePlain(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function captureRowTemplate(worksheet, sourceRowNumber) {
    const sourceRow = worksheet.getRow(sourceRowNumber);
    const cells = [];
    for (let column = 1; column <= 8; column += 1) {
      const cell = sourceRow.getCell(column);
      cells.push({
        style: clonePlain(cell.style || {}),
        numFmt: cell.numFmt || null,
        dataValidation: cell.dataValidation ? clonePlain(cell.dataValidation) : null,
        protection: cell.protection ? clonePlain(cell.protection) : null,
      });
    }
    return { height: sourceRow.height, cells };
  }

  function applyRowTemplate(worksheet, template, targetRowNumber) {
    const row = worksheet.getRow(targetRowNumber);
    row.height = template.height;
    for (let column = 1; column <= 8; column += 1) {
      const cell = row.getCell(column);
      const source = template.cells[column - 1];
      cell.style = clonePlain(source.style || {});
      cell.numFmt = source.numFmt || undefined;
      cell.dataValidation = source.dataValidation ? clonePlain(source.dataValidation) : undefined;
      cell.protection = source.protection ? clonePlain(source.protection) : undefined;
      cell.value = null;
      cell.note = null;
      if (cell.model) {
        delete cell.model.note;
        delete cell.model.comment;
      }
      delete cell._comment;
    }
  }

  function clearOutputArea(worksheet, startRow, endRow) {
    Object.keys(worksheet._merges || {}).forEach((range) => {
      const match = range.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/);
      if (!match) return;
      if (Number(match[4]) >= startRow && Number(match[2]) <= endRow) worksheet.unMergeCells(range);
    });
    for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      for (let column = 1; column <= 8; column += 1) {
        const cell = row.getCell(column);
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

  function groupRows(rows) {
    const groups = [];
    const byId = new Map();
    rows.forEach((row) => {
      const groupId = Number(row.groupId || row.group_id || 1) || 1;
      if (!byId.has(groupId)) {
        const group = { groupId, rows: [] };
        byId.set(groupId, group);
        groups.push(group);
      }
      byId.get(groupId).rows.push(row);
    });
    return groups;
  }

  function total(rows) {
    return rows.reduce((sum, row) => {
      const amount = Number(row.price || 0);
      return Number.isFinite(amount) ? sum + amount : sum;
    }, 0);
  }

  function uniqueNonEmpty(values) {
    return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  }

  function buildSheet(worksheet, rows) {
    const templates = {
      data: captureRowTemplate(worksheet, 2),
      subtotal: captureRowTemplate(worksheet, 10),
      spacer: captureRowTemplate(worksheet, 11),
      totalPeople: captureRowTemplate(worksheet, 14),
      totalAmount: captureRowTemplate(worksheet, 15),
    };
    clearOutputArea(worksheet, 2, 1994);

    let rowNumber = 2;
    groupRows(rows).forEach((group) => {
      const groupStart = rowNumber;
      const positions = uniqueNonEmpty(group.rows.map((row) => row.position));
      const uniformPosition = positions.length <= 1;
      group.rows.forEach((row, index) => {
        applyRowTemplate(worksheet, templates.data, rowNumber);
        const target = worksheet.getRow(rowNumber);
        target.getCell(1).value = String(row.phone || "");
        target.getCell(2).value = row.name || "";
        target.getCell(3).value = row.documentType || row.document_type || "身份证";
        target.getCell(4).value = String(row.documentNo || row.idcard || "").toUpperCase();
        target.getCell(5).value = row.country || ((row.documentType || row.document_type) === "护照" ? "" : "China");
        target.getCell(6).value = row.price ? String(row.price) : "";
        target.getCell(7).value = uniformPosition ? (index === 0 ? positions[0] || "" : "") : row.position || "";
        target.getCell(8).value = row.size || "";
        if (row.extra) target.getCell(4).note = `备注：${String(row.extra)}`;
        rowNumber += 1;
      });
      if (group.rows.length > 1 && uniformPosition) worksheet.mergeCells(groupStart, 7, rowNumber - 1, 7);

      applyRowTemplate(worksheet, templates.subtotal, rowNumber);
      worksheet.getRow(rowNumber).getCell(4).value = "合计（金额）";
      worksheet.getRow(rowNumber).getCell(6).value = `${total(group.rows)}元`;
      rowNumber += 1;
      applyRowTemplate(worksheet, templates.spacer, rowNumber);
      rowNumber += 1;
    });

    applyRowTemplate(worksheet, templates.totalPeople, rowNumber);
    worksheet.getRow(rowNumber).getCell(4).value = "总人数";
    worksheet.getRow(rowNumber).getCell(6).value = `${rows.length}人`;
    rowNumber += 1;
    applyRowTemplate(worksheet, templates.totalAmount, rowNumber);
    worksheet.getRow(rowNumber).getCell(4).value = "总合计";
    worksheet.getRow(rowNumber).getCell(6).value = `${total(rows)}元`;
  }

  async function download({ rows, filename, templateUrl }) {
    if (typeof window.ExcelJS === "undefined") throw new Error("Excel 导出组件未加载，请刷新页面重试。");
    const response = await fetch(templateUrl, { cache: "no-cache" });
    if (!response.ok) throw new Error(`购票模板加载失败：${response.status}`);
    const workbook = new window.ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    const worksheet = workbook.getWorksheet("0") || workbook.worksheets[0];
    if (!worksheet) throw new Error("购票模板中没有可用工作表。");
    buildSheet(worksheet, rows);
    const output = await workbook.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([output], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { people: rows.length, groups: groupRows(rows).length, amount: total(rows) };
  }

  window.TicketTemplateExport = { buildSheet, download };
})();
