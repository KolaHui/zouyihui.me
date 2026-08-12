(() => {
  // ---------- 配置与状态 ----------
  const apiBase = String(window.AI_API_BASE_URL || "").replace(/\/$/, "");
  const ticketApi = {
    normalize: `${apiBase}/api/ticket/normalize`,
    audit: `${apiBase}/api/ticket/audit`,
  };

  const DRAFT_KEY = "parser_v2_draft_v1";

  const state = {
    step: 1,
    rawText: "",
    normalizedText: "",
    aiUsed: false,
    /** @type {{name:string, phone:string, documentType:string, idcard:string, country:string, price:string, position:string, size:string, address:string, extra:string, groupId:number}[]} */
    rows: [],
    /** 每一批粘贴的未格式化原文都要留档，AI 最终检查以此为最高优先级依据 */
    /** @type {{batch_no:number, raw_text:string, normalized_text:string, added_count:number, created_at:string}[]} */
    batches: [],
  };

  let nextGroupId = 1;
  let draftTimer = null;
  // 请求版本号：清空/提交/发起新请求都会 +1，旧的流式响应发现版本不对就整体作废，
  // 防止“清空后旧 AI 响应又把个人信息写回来”这类竞态
  let requestSeq = 0;
  let normalizing = false;

  function endNormalizeUi() {
    normalizing = false;
    const toParse = document.getElementById("toParseBtn");
    if (toParse) toParse.disabled = false;
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const stepsBar = $("stepsBar");
  const rawInput = $("rawInput");
  const rawView = $("rawView");
  const normalizedInput = $("normalizedInput");
  const tableMeta = $("tableMeta");
  const editTableWrap = $("editTableWrap");
  const previewTableWrap = $("previewTableWrap");
  const auditBox = $("auditBox");
  const exportNameInput = $("exportNameInput");
  const notices = { 1: $("notice1"), 2: $("notice2"), 3: $("notice3"), 4: $("notice4") };

  // ---------- 工具 ----------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setNotice(step, kind, html) {
    const el = notices[step];
    if (!el) return;
    el.className = "notice" + (kind ? ` ${kind}` : "");
    el.innerHTML = html || "";
  }

  // 带访问密码的 POST；后端 401 时重新弹窗要密码并重试一次
  async function aiFetch(url, payload) {
    const auth = window.AiAuth ? await window.AiAuth.authHeaders() : {};
    let response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(payload),
    });
    if (response.status === 401 && window.AiAuth) {
      const retryAuth = await window.AiAuth.reauth();
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...retryAuth },
        body: JSON.stringify(payload),
      });
    }
    return response;
  }

  async function postJson(url, payload) {
    const response = await aiFetch(url, payload);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `API 请求失败：${response.status}`);
    }
    // 耗时接口走“心跳”响应时状态码恒为 200，错误放在 JSON 体里
    if (data && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  function dateStamp() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `${y}${m}${d}_${hh}${mm}`;
  }

  function defaultExportFilename() {
    return `购票信息_${dateStamp()}.xlsx`;
  }

  function normalizeFilename(name) {
    const base = String(name || "").trim() || defaultExportFilename();
    const cleaned = base.replace(/[\\/:*?"<>|]/g, "_");
    return /\.xlsx$/i.test(cleaned) ? cleaned : `${cleaned}.xlsx`;
  }

  // ---------- 草稿 ----------
  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 300);
  }

  function saveDraft() {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          step: state.step,
          rawText: state.rawText,
          normalizedText: state.normalizedText,
          aiUsed: state.aiUsed,
          rows: state.rows,
          batches: state.batches,
          exportName: exportNameInput.value || "",
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
      if (!draft || (!draft.rawText && !(draft.rows || []).length)) return false;
      state.rawText = draft.rawText || "";
      state.normalizedText = draft.normalizedText || "";
      state.aiUsed = Boolean(draft.aiUsed);
      state.rows = Array.isArray(draft.rows) ? draft.rows : [];
      state.batches = Array.isArray(draft.batches) ? draft.batches : [];
      if (state.rows.length && !state.batches.length && draft.rawText) {
        state.batches = [{
          batch_no: 1,
          raw_text: draft.rawText,
          normalized_text: draft.normalizedText || "",
          added_count: state.rows.length,
          created_at: new Date().toISOString(),
        }];
      }
      state.step = [1, 2, 3, 4].includes(draft.step) ? draft.step : 1;
      rawInput.value = state.rawText;
      normalizedInput.value = state.normalizedText;
      exportNameInput.value = draft.exportName || defaultExportFilename();
      nextGroupId = state.rows.reduce((max, row) => Math.max(max, row.groupId || 1), 0) + 1;
      return true;
    } catch {
      return false;
    }
  }

  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }

  // 把带分隔符的手机号（138-8960-9691 / 138 8960 9691）合并成连续 11 位。
  // 只匹配“1[3-9] + 9 位、每位可带一个分隔符、后面不再接数字”的严格形状，
  // 身份证是连续数字不含分隔符，不会被误合并。
  function healSeparatedPhones(text) {
    return String(text || "").replace(
      /1[3-9](?:[ \-]?\d){9}(?!\d)/g,
      (m) => m.replace(/[ \-]/g, "")
    );
  }

  // ---------- 文本规整与拆分（沿用旧版成熟正则逻辑） ----------
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
    text = healSeparatedPhones(text);
    return text.trim();
  }

  function splitBlocks(text) {
    const norm = normalizeText(text);
    if (!norm) return [];
    return norm.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  }

  function normalizePhone(phone) {
    const match = String(phone || "").match(/1[3-9]\d{9}/);
    return match ? match[0] : "";
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
      "中国大陆", "中国内地", "中国香港", "中国澳门", "中国台湾", "中国",
      "香港", "澳门", "台湾", "美国", "英国", "日本", "韩国", "加拿大",
      "澳大利亚", "新西兰", "新加坡", "德国", "法国", "意大利", "西班牙",
      "俄罗斯", "泰国", "马来西亚", "印度尼西亚", "菲律宾", "越南",
    ];
    const hit = countryTokens.find((token) => raw.includes(token));
    if (hit) return normalizeCountryName(hit);
    if (documentType === "身份证") return "China";
    return "";
  }

  function guessPosition(text) {
    const raw = String(text || "");
    // 顿号连接的多区域（如“二层C3区、C4区”“二层C3、C4区”）必须整体保留，不能截成只剩第一个
    const directMatch =
      raw.match(/([一二三四五六七八九十]层\s*[A-Z]\d+(?:区|区域)?(?:看台)?(?:\s*、\s*[A-Z]?\d+(?:区|区域)?(?:看台)?)*)/) ||
      raw.match(/([一二三四五六七八九十]层\s*主席台)/) ||
      raw.match(/([一二三四五六七八九十]层\s*VIP\d*区?)/i);
    if (directMatch && directMatch[1]) {
      return directMatch[1].replace(/\s+/g, "");
    }

    const layerMatch = raw.match(/([一二三四五六七八九十]层)/);
    // VIP 必须先于 [A-Z]\d 匹配，否则 “VIP7区” 会被截成 “P7区”
    const zoneMatch =
      raw.match(/(VIP\s*\d*\s*区?)/i) ||
      raw.match(/([A-Z]\d{1,3}(?:区|区域)(?:看台)?(?:\s*、\s*[A-Z]?\d{1,3}(?:区|区域)?(?:看台)?)*|[A-Z]\d{1,3}看台)/) ||
      raw.match(/(主席台)/);
    if (layerMatch && zoneMatch) {
      return `${layerMatch[1]}${String(zoneMatch[1]).replace(/\s+/g, "")}`;
    }
    if (zoneMatch && zoneMatch[1]) return String(zoneMatch[1]).replace(/\s+/g, "");
    return "";
  }

  // “2人合计760元”里的 760 是总价不是每人票价，误当单价会把金额翻倍且零告警
  const TOTAL_AMOUNT_CONTEXT_RE = /(?:合计|总计|总共|共计|总额|总价|一共|共)\s*[:：]?\s*$/;

  function guessPrice(text) {
    const raw = String(text || "");
    // \b 防止从证件号内部抠数字：如 “…13002X” 曾被 数字x数字 规则误认成 3002 元
    const explicitRe = /(票价|单价)?\s*\b(\d{2,4})\s*元/g;
    let explicitMatch;
    while ((explicitMatch = explicitRe.exec(raw)) !== null) {
      if (!explicitMatch[1]) {
        const before = raw.slice(Math.max(0, explicitMatch.index - 8), explicitMatch.index);
        if (TOTAL_AMOUNT_CONTEXT_RE.test(before)) continue;
      }
      return explicitMatch[2];
    }
    const multiplier = raw.match(/(?:票价|单价)?\s*\b(\d{2,4})\s*[xX]\s*\d{1,2}(?!\d)/);
    if (multiplier && multiplier[1]) return multiplier[1];

    const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);

    // 竖线表格：|姓名|证件|手机|位置|票价| 里的独立数字单元格
    for (const line of lines) {
      if (!line.includes("|")) continue;
      const cell = line
        .split("|")
        .map((c) => c.trim())
        .find((c) => /^\d{2,4}$/.test(c) && Number(c) >= 80 && Number(c) <= 3000);
      if (cell) return cell;
    }

    for (const line of lines) {
      if (!/(层|区|区域|看台|主席台|票价)/.test(line)) continue;
      const cleaned = line
        .replace(/\d{1,2}月\d{1,2}[号日]?/g, " ")
        // 同样要剔除“2人合计760元”这类总价，否则兜底扫描仍会把总价当单价
        .replace(/(?:\d+\s*人)?\s*(?:合计|总计|总共|共计|总额|总价|一共|共)\s*[:：]?\s*\d{2,5}\s*元?/g, " ");
      const numbers = cleaned.match(/\b\d{2,4}\b/g) || [];
      const candidate = numbers.find((num) => Number(num) >= 80 && Number(num) <= 3000);
      if (candidate) return candidate;
    }
    return "";
  }

  function extractAddress(block) {
    const m = String(block || "").match(/(地址|住址|家庭住址)[ \t]*[:：][ \t]*([^\n]*)/);
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
    return date.getFullYear() === y && date.getMonth() + 1 === m && date.getDate() === d;
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
    const matches = String(block || "").match(/\b1[3-9]\d{9}\b/g);
    return matches && matches.length ? matches[0] : "";
  }

  function extractIdCard(block) {
    const matches = String(block || "").match(/\d{17}[\dXx]|\d{15}/g);
    return matches && matches.length ? matches[0] : "";
  }

  function extractName(block, phone, idcard) {
    // (?!电话|手机|方式)：防止“联系人电话：138…”把“电话”当成姓名；冒号也从取值里排除
    const labelRe = /(姓名|名字|联系人)\s*[:：]?\s*(?!电话|手机|方式|号码)([^\s，,。；;：:]+)/;
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

    const firstLine =
      beforeRaw
        .split(/\n/)
        .map((s) => s.trim())
        .find((s) => s.length) || "";
    if (firstLine) {
      let candidate = firstLine.replace(/(姓名|名字|联系人)\s*[:：]?\s*/g, "").trim();
      const firstNameMatch = candidate.match(/^[一-龥]{1,5}/);
      if (firstNameMatch) candidate = firstNameMatch[0];
      if (candidate && !blacklist.includes(candidate)) {
        return candidate.replace(/[：:]+$/, "");
      }
    }

    const before = beforeRaw.replace(/[\n]/g, " ").trim();
    if (!before) return "";
    const m2 = before.match(/([一-龥]{2,5})$/);
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

  function lineStartBefore(text, index) {
    const pos = String(text || "").lastIndexOf("\n", Math.max(index, 0));
    return pos === -1 ? 0 : pos + 1;
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

  function shouldAbsorbPreviousLine(text, anchorLineStart, previousAnchorEnd, prevSegmentStart, isFirstAnchor) {
    const prevStart = previousLineStart(text, anchorLineStart);
    if (prevStart === anchorLineStart || prevStart < previousAnchorEnd) return false;
    const prev = lineText(text, prevStart, Math.max(prevStart, anchorLineStart - 1));
    if (!prev) return false;
    // “姓名+手机号”同一行（含括号手机），如 “张伟13500757770 / 叶蕾（186…）”，证件号在下一行：
    // 只有当上一个人的段落里已经有手机号时，这一行才归当前这个人；
    // 否则说明是“证件号在前、姓名手机在后”的排版，这一行属于上一个人。
    // 注意排除 “电话/手机号138…” 这类标签行，以及证件号内部恰好长得像手机号的子串。
    const namePhoneMatch = prev.match(/^([一-龥]{2,6}|[A-Za-z][A-Za-z .'-]{1,30})\s*[(（]?1[3-9]\d{9}[)）]?[,，;；]?$/);
    if (namePhoneMatch && !FIELD_LABEL_RE.test(namePhoneMatch[1])) {
      if (isFirstAnchor) return true;
      return /(^|[^\d])1[3-9]\d{9}(?!\d)/.test(String(text).slice(prevSegmentStart, prevStart));
    }
    if (/1[3-9]\d{9}/.test(prev)) return false;
    if (/\d{15,18}[\dXx]?/.test(prev)) return false;
    if (/(票价|元|层|区|区域|看台|主席台|预定|主场|球票|这八个人)/.test(prev)) return false;
    return /^(?:姓名|名字|联系人)?\s*[:：]?\s*(?:[一-龥]{2,8}|[A-Za-z][A-Za-z .'-]{1,50})$/i.test(prev);
  }

  // 订单号/快递单号上下文：这些标签后面的字母数字串不是证件号
  const ORDER_NO_CONTEXT_RE = /(?:订单|单号|流水|运单|快递|编号)\s*(?:号码?|编号)?\s*[:：]?\s*$/;

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

    // 无“护照”标签的裸护照号（如 “ZHOU EFFIE RA2538794”）：1-2 个大写字母 + 7-8 位数字。
    // 漏掉这种格式曾导致整个人被静默并入上一个人的 extra，人数和金额都对不上。
    // 但“订单号 A12345678”这类编号同样满足该形状，带订单类标签时必须排除，
    // 否则会凭空多出一个证件类型为护照的假人员。
    const barePassportRe = /\b[A-Z]{1,2}\d{7,8}\b/g;
    while ((match = barePassportRe.exec(raw)) !== null) {
      const value = String(match[0] || "").trim();
      const index = match.index;
      const end = index + value.length;
      if (ORDER_NO_CONTEXT_RE.test(raw.slice(Math.max(0, index - 12), index))) continue;
      if (anchors.some((anchor) => index < anchor.end && end > anchor.index)) continue;
      anchors.push({ type: "护照", value, index, end });
    }

    return anchors.sort((a, b) => a.index - b.index);
  }

  // 字段标签词和位置词不允许被当成姓名（修复“身份证”“二层”被识别成姓名的问题）
  const FIELD_LABEL_RE = /^(身份证号?码?|护照号?码?|手机号?|电话号?|联系电话|住址|地址|国家地区|国家|国籍|地区|票价|位置|尺码|其他|姓名|名字|联系人|passport|[一二三四五六七八九十]层\S*|\S*看台|主席台|VIP\S*|区域?)$/i;

  function pickNameFromLines(text) {
    const lines = String(text || "").split(/\n/).map((s) => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      // 竖线表格一行拆成多个单元格逐个尝试；普通行整体尝试
      const cells = lines[i].includes("|") ? lines[i].split("|") : [lines[i]];
      for (const rawCell of cells) {
        const cell = rawCell
          .replace(/[(（]\s*1[3-9]\d{9}\s*[)）]/g, " ")
          .replace(/1[3-9]\d{9}/g, " ")
          .replace(/(姓名|名字|联系人)\s*[:：]?\s*/g, "")
          .replace(/[,，。；;：:]+$/g, "")
          .trim();
        if (!cell || FIELD_LABEL_RE.test(cell)) continue;
        const cn = cell.match(/^[一-龥]{2,6}$/);
        if (cn) return cn[0];
        const latin = cell.match(/^[A-Za-z][A-Za-z .'-]{1,40}$/);
        if (latin) return latin[0].trim();
      }
    }
    return "";
  }

  function extractNameFromSegment(segment, anchorValue) {
    const text = String(segment || "");
    const fullNameMatch = text.match(/名\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{0,30})\s*姓\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{0,30})/i);
    if (fullNameMatch) {
      return `${fullNameMatch[2].trim()} ${fullNameMatch[1].trim()}`.trim();
    }

    const labeledName =
      text.match(/(?:姓名|名字|联系人)\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{1,40}|[一-龥]{2,6})/i) ||
      text.match(/名\s*[:：]?\s*([A-Za-z][A-Za-z .'-]{1,40}|[一-龥]{1,6})/i);
    if (labeledName && labeledName[1]) return labeledName[1].trim();

    const anchorIndex = anchorValue ? text.indexOf(anchorValue) : -1;
    const before = anchorIndex >= 0 ? text.slice(0, anchorIndex) : text;
    const after = anchorIndex >= 0 ? text.slice(anchorIndex + anchorValue.length) : "";

    const lineName = pickNameFromLines(before);
    if (lineName) return lineName;

    const chineseTail = before.match(/([一-龥]{2,6})\s*[,，:：]?\s*$/);
    if (chineseTail && chineseTail[1] && !FIELD_LABEL_RE.test(chineseTail[1].trim())) return chineseTail[1].trim();

    const latinTail = before.match(/([A-Za-z][A-Za-z .'-]{1,40})\s*[,，:：]?\s*$/);
    if (latinTail && latinTail[1] && !FIELD_LABEL_RE.test(latinTail[1].trim())) return latinTail[1].trim();

    const chineseAfter = after.match(/^\s*([一-龥]{2,6})/);
    if (chineseAfter && chineseAfter[1] && !FIELD_LABEL_RE.test(chineseAfter[1].trim())) return chineseAfter[1].trim();

    const latinAfter = after.match(/^\s*([A-Za-z][A-Za-z .'-]{1,40})/);
    if (latinAfter && latinAfter[1] && !FIELD_LABEL_RE.test(latinAfter[1].trim())) return latinAfter[1].trim();

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
        size: "",
        address: address || "",
        extra: "",
        _blockIndex: blockIndex + 1,
      };
      row.extra = buildExtraText(block, row, blockContext);
      rows.push(row);
      return rows;
    }

    const segmentStarts = [];
    anchors.forEach((anchor, idx) => {
      const anchorLineStart = lineStartBefore(block, anchor.index);
      const previousAnchorEnd = idx === 0 ? 0 : anchors[idx - 1].end;
      const prevSegmentStart = idx === 0 ? 0 : segmentStarts[idx - 1];
      segmentStarts.push(
        shouldAbsorbPreviousLine(block, anchorLineStart, previousAnchorEnd, prevSegmentStart, idx === 0)
          ? previousLineStart(block, anchorLineStart)
          : anchorLineStart
      );
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
        size: "",
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

  function normalizeParsedRows(rows, groupOffset = 0) {
    const groups = new Map();
    let seed = groupOffset + 1;

    rows.forEach((row) => {
      const sourceGroup = row._blockIndex || 1;
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
      groupId: groups.get(row._blockIndex || 1) || groupOffset + 1,
    }));
  }

  // ---------- 校验 ----------
  // 姓名只接受 2-15 个汉字（可含间隔号）或拉丁字母姓名
  const NAME_SHAPE_RE = /^(?:[一-龥·]{2,15}|[A-Za-z][A-Za-z .'-]{1,40})$/;

  // 手机号必须整体就是干净的 11 位（允许空格/横线分隔），
  // 不能像 “x13800138000y” 这样靠子串匹配蒙混过关再被导出悄悄截断
  function cleanPhoneOrEmpty(value) {
    const compact = String(value || "").trim().replace(/[ \-]/g, "");
    return /^1[3-9]\d{9}$/.test(compact) ? compact : "";
  }

  function rowFieldIssues(row) {
    const issues = { name: "", phone: "", documentType: "", idcard: "", price: "" };

    if (!row.name) {
      issues.name = "未识别出姓名";
    } else if (!NAME_SHAPE_RE.test(String(row.name).trim())) {
      issues.name = "姓名格式异常（夹带了数字、标点或标签文字），请核对";
    }

    if (!row.phone) {
      issues.phone = "未识别出手机号";
    } else if (!cleanPhoneOrEmpty(row.phone)) {
      issues.phone = "手机号应为 1 开头的 11 位数字，且不能夹带其他字符";
    }

    // 证件类型必须明确，且要与号码形状互相印证：
    // 有效身份证号配“护照”类型、或类型留空，都属于会导致导出错误的数据
    const documentType = String(row.documentType || "").trim();
    if (!row.idcard) {
      issues.idcard = "未识别出证件号";
    } else {
      const id = String(row.idcard).toUpperCase();
      if (documentType === "身份证") {
        if (!isLikelyChineseId(id)) {
          issues.idcard = "身份证号格式不正确";
        } else if (!isValidChineseIdCard(id)) {
          issues.idcard = "身份证号校验未通过，请人工确认";
        }
      } else if (documentType === "护照") {
        if (isLikelyChineseId(id)) {
          issues.idcard = "号码是身份证格式，证件类型却是“护照”，请改正证件类型";
        } else if (!/^[A-Z0-9]{5,20}$/i.test(id)) {
          issues.idcard = "护照号格式不正确";
        }
      } else {
        issues.documentType = "证件类型为空或无法识别，请选择“身份证”或“护照”";
      }
    }

    const price = String(row.price || "").trim();
    if (price && !/^\d+$/.test(price)) {
      issues.price = "票价必须是纯数字（不要带“元”或其他文字）";
    }

    return issues;
  }

  function collectErrors(rows) {
    const errors = [];
    rows.forEach((row, idx) => {
      const issues = rowFieldIssues(row);
      Object.values(issues)
        .filter(Boolean)
        .forEach((msg) => errors.push(`第 ${idx + 1} 行：${msg}。`));
    });
    return errors;
  }

  /** 逐格判定：cell-error（红＝明确错误/缺失）、cell-confirm（黄＝需人工确认） */
  function computeCellIssues(rows, batches) {
    const byId = new Map();
    rows.forEach((row, idx) => {
      const id = String(row.idcard || "").toUpperCase().trim();
      if (!id) return;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(idx);
    });

    const phantomSet = new Set(findPhantomRowIndexes(rows, batches));

    return rows.map((row, idx) => {
      const cells = {};
      const mark = (field, cls, msg) => {
        if (cells[field] && cells[field].cls === "cell-error") return; // 红色优先
        cells[field] = { cls, msg };
      };

      // 与 rowFieldIssues 共用同一套字段规则：只有“请人工确认”类降级为黄色，其余都是红色错误
      const fieldIssues = rowFieldIssues(row);
      Object.entries(fieldIssues).forEach(([field, msg]) => {
        if (!msg) return;
        mark(field, msg.includes("请人工确认") ? "cell-confirm" : "cell-error", msg);
      });

      const id = String(row.idcard || "").toUpperCase().trim();
      if (id) {
        const sameIdRows = byId.get(id) || [];
        if (sameIdRows.length > 1) {
          const names = uniqueNonEmpty(sameIdRows.map((i) => rows[i].name));
          if (names.length > 1) {
            mark("idcard", "cell-error", "严重：同一证件号对应不同姓名，必有一处错误");
            mark("name", "cell-error", "严重：同一证件号对应不同姓名，必有一处错误");
          } else {
            // 一场比赛一人一票：同证件号出现两次必然是重复录入，属严重风险
            mark("idcard", "cell-error", "严重：证件号重复出现，重复购票会被实名系统拒绝");
          }
        }
      }

      if ((row.documentType || "") === "护照" && !String(row.country || "").trim()) {
        mark("country", "cell-error", "护照人员国家地区缺失");
      }
      if (!String(row.price || "").trim()) {
        mark("price", "cell-error", "票价缺失");
      }
      const position = String(row.position || "").trim();
      if (!position) {
        mark("position", "cell-error", "位置缺失");
      } else if (!/[一二三四五六七八九十\d]层/.test(position) || !/(区|看台|主席台|VIP)/i.test(position)) {
        mark("position", "cell-confirm", "位置表达不完整，建议“几层+区域”（如二层D5区）");
      }

      if (phantomSet.has(idx)) {
        mark("idcard", "cell-confirm", "此证件号在所有原文里都找不到，可能识别错误或手输有误，请核对");
      }

      return cells;
    });
  }

  // ---------- 本地强校验（确定性检查，不依赖 AI） ----------
  function extractIdentityTokens(text) {
    const raw = normalizeText(text);
    const docs = new Set();
    (raw.match(/\d{17}[\dXx]|\d{15}/g) || []).forEach((token) => docs.add(token.toUpperCase()));
    const labeledPassportRe = /(?:护照(?:号|号码)?|passport(?:\s*no\.?)?)\s*[:：]?\s*([A-Z0-9]{5,20})/gi;
    let match;
    while ((match = labeledPassportRe.exec(raw)) !== null) {
      docs.add(String(match[1]).toUpperCase());
    }
    const bareRe = /\b[A-Z]{1,2}\d{7,8}\b/g;
    while ((match = bareRe.exec(raw)) !== null) {
      if (ORDER_NO_CONTEXT_RE.test(raw.slice(Math.max(0, match.index - 12), match.index))) continue;
      docs.add(match[0].toUpperCase());
    }
    return { docs: Array.from(docs), phones: extractPhoneCandidates(raw) };
  }

  function findDroppedIdentityTokens(sourceText, rows) {
    const tokens = extractIdentityTokens(sourceText);
    const idSet = new Set(rows.map((row) => String(row.idcard || "").toUpperCase().trim()).filter(Boolean));
    const phoneSet = new Set(rows.map((row) => normalizePhone(row.phone)).filter(Boolean));
    const missing = [];
    tokens.docs.forEach((token) => {
      if (!idSet.has(token)) missing.push(`证件号 ${token}`);
    });
    tokens.phones.forEach((token) => {
      if (!phoneSet.has(token)) missing.push(`手机号 ${token}`);
    });
    return missing;
  }

  // 把所有批次原文里的证件号汇成一个集合，用于反向对账
  function collectSourceDocSet(batches) {
    const docs = new Set();
    (batches || []).forEach((batch) => {
      const source = batch.raw_text || batch.normalized_text || "";
      if (!source) return;
      extractIdentityTokens(source).docs.forEach((token) => docs.add(token));
    });
    return docs;
  }

  // 反向对账：表格里的证件号在所有原文里都找不到 = 幻影行（AI 造的 / 手输错的），需人工确认。
  // 无批次原文时无法对账，返回空（不误报）。
  function findPhantomRowIndexes(rows, batches) {
    if (!batches || !batches.length) return [];
    const sourceDocs = collectSourceDocSet(batches);
    if (!sourceDocs.size) return [];
    const phantom = [];
    rows.forEach((row, idx) => {
      const id = String(row.idcard || "").toUpperCase().trim();
      if (id && !sourceDocs.has(id)) phantom.push(idx);
    });
    return phantom;
  }

  function collectStrongIssues(rows, batches) {
    const issues = [];

    // 1) 同证件号重复 / 同证不同名
    const byId = new Map();
    rows.forEach((row, idx) => {
      const id = String(row.idcard || "").toUpperCase().trim();
      if (!id) return;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ no: idx + 1, name: row.name || "(无名)" });
    });
    byId.forEach((list, id) => {
      if (list.length < 2) return;
      const names = uniqueNonEmpty(list.map((p) => p.name));
      const where = list.map((p) => `第${p.no}行${p.name}`).join("、");
      if (names.length > 1) {
        issues.push(`【严重·同证不同名】证件号 ${id} 对应了不同姓名：${where}，必有一处错误，请立即确认。`);
      } else {
        issues.push(`【严重·重复购票】证件号 ${id} 出现 ${list.length} 次：${where}，一人一票，重复录入必须删除一条。`);
      }
    });

    // 2) 护照人员国家地区为空
    rows.forEach((row, idx) => {
      if ((row.documentType || "") === "护照" && !String(row.country || "").trim()) {
        issues.push(`【护照缺国家】第 ${idx + 1} 行 ${row.name || row.idcard} 国家地区为空，购票系统一般必填。`);
      }
    });

    // 3) 票价 / 位置闭口检查
    rows.forEach((row, idx) => {
      if (!String(row.price || "").trim()) {
        issues.push(`【票价为空】第 ${idx + 1} 行 ${row.name || row.idcard || "?"} 没有票价。`);
      }
    });
    // 位置按“组内每个人”检查，而不是只看第一行：
    // 过去只取第一行导致 “A1区/B2区” 里 B2 的位置被静默丢弃且全绿
    getGroupRows(rows).forEach((group, gi) => {
      const positions = uniqueNonEmpty(group.rows.map((row) => row.position));
      const who = group.rows[0].name || group.rows[0].idcard || "?";
      if (!positions.length) {
        issues.push(`【位置为空】第 ${gi + 1} 组（${who} 等 ${group.rows.length} 人）没有位置。`);
        return;
      }
      positions.forEach((position) => {
        if (!/[一二三四五六七八九十\d]层/.test(position) || !/(区|看台|主席台|VIP)/i.test(position)) {
          issues.push(`【位置不完整】第 ${gi + 1} 组位置“${position}”缺少“几层+区域”闭口表达（如“二层D5区”）。`);
        }
      });
      if (positions.length > 1) {
        issues.push(
          `【同组多位置】第 ${gi + 1} 组内有 ${positions.length} 个不同位置（${positions.join("、")}），导出时将按每人各自的位置分别填写、不再合并单元格，请确认这是有意的。`
        );
      }
    });

    // 只有姓名、没有证件/手机的人在拆分时会掉进上一个人的“其他”字段里，
    // 这里把疑似人名扫出来提醒，避免静默漏人
    rows.forEach((row, idx) => {
      String(row.extra || "")
        .split(/\s+/)
        .forEach((token) => {
          if (/^[一-龥·]{2,4}$/.test(token) && !FIELD_LABEL_RE.test(token) && token !== row.name) {
            issues.push(
              `【疑似漏人】第 ${idx + 1} 行的附加信息里出现独立人名「${token}」，但没有对应的证件号/手机号，请确认是否漏拆了一个人。`
            );
          }
        });
    });

    // 4) 漏人对账：每一批原文里的证件号/手机号必须都出现在表格里
    (batches || []).forEach((batch) => {
      const source = batch.raw_text || batch.normalized_text || "";
      if (!source) return;
      findDroppedIdentityTokens(source, rows).forEach((token) => {
        issues.push(`【漏人风险】第 ${batch.batch_no} 批原文中的 ${token} 没有出现在表格里，请核对是否漏拆。`);
      });
    });

    // 5) 幻影行反向对账：表格证件号在所有原文里都找不到
    findPhantomRowIndexes(rows, batches).forEach((idx) => {
      const row = rows[idx];
      issues.push(`【幻影行·需确认】第 ${idx + 1} 行 ${row.name || "(无名)"} 的证件号 ${String(row.idcard).toUpperCase()} 在所有原文里都找不到，可能是识别错误或手输有误，请核对。`);
    });

    return issues;
  }

  // ---------- 分组 ----------
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

  function normalizeGroupIds(rows) {
    const orderedGroups = getGroupRows(rows);
    const normalized = new Map();
    let seed = 1;
    orderedGroups.forEach((group) => normalized.set(group.groupId, seed++));
    nextGroupId = seed;
    return rows.map((row) => ({ ...row, groupId: normalized.get(row.groupId || 1) || 1 }));
  }

  // 把第 index 行移到相邻组：改它的 groupId，再按“移动前的组顺序”（新建组追加到末尾）重排。
  // 关键：不能用 getGroupRows(rows) 按物理顺序重新推断组序——移动某组物理最靠前的那行时，
  // 会把目标组错误地提到最前面（就是“第一组第一行点下一组，第二组跑到第一组位置”的 bug）。
  // 返回重排后的行数组（沿用旧对象，供 FLIP 动画映射）；prev-group 已在第一组则返回 null 表示无变化。
  function reorderForGroupMove(rows, index, action) {
    const row = rows[index];
    if (!row) return null;
    const orderedIds = getGroupRows(rows).map((group) => group.groupId);
    const pos = orderedIds.indexOf(row.groupId || 1);

    if (action === "prev-group") {
      if (pos <= 0) return null;
      row.groupId = orderedIds[pos - 1];
    } else {
      if (pos >= 0 && pos < orderedIds.length - 1) {
        row.groupId = orderedIds[pos + 1];
      } else {
        const newId = nextGroupId++;
        row.groupId = newId;
        orderedIds.push(newId);
      }
    }

    // 被移动的行落到目标组末尾（“加入那一组”的直觉），其余行保持原相对顺序
    return orderedIds.flatMap((gid) => {
      const groupRows = rows.filter((r) => (r.groupId || 1) === gid && r !== row);
      if ((row.groupId || 1) === gid) groupRows.push(row);
      return groupRows;
    });
  }

  function groupTotal(rows) {
    return rows.reduce((sum, row) => {
      const value = Number(row.price || 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
  }

  function rowsTotal(rows) {
    return groupTotal(rows);
  }

  // ---------- 步骤切换 ----------
  function gotoStep(step) {
    state.step = step;
    [1, 2, 3, 4].forEach((n) => {
      $(`panel${n}`).classList.toggle("show", n === step);
    });
    stepsBar.querySelectorAll("li").forEach((li) => {
      const n = Number(li.getAttribute("data-step"));
      li.classList.toggle("active", n === step);
      li.classList.toggle("done", n < step);
    });
    if (step === 1) updateAppendNotice();
    if (step === 3) renderEditTable();
    if (step === 4) renderPreviewTable();
    scheduleDraftSave();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------- 步骤 1/2：AI 整理 ----------
  function updateAppendNotice() {
    if (state.rows.length) {
      const groups = getGroupRows(state.rows);
      setNotice(
        1,
        "info",
        `追加模式：表格已有 ${state.rows.length} 人 / ${groups.length} 组（${state.batches.length} 批），现有数据不会丢失。本次粘贴的内容会作为新的组追加到表格末尾，之后可在第 3 步用「整组上移」挪到任意位置。`
      );
    } else {
      setNotice(1, "", "");
    }
  }

  /** 把一批文本拆分后追加进表格，成功则记录批次档案并清空输入区，返回新增人数 */
  function commitBatch(sourceText) {
    requestSeq += 1; // 提交即作废所有在途 AI 响应，避免旧流稍后回写已清空的输入区
    endNormalizeUi();
    const parsed = buildRowsFromText(sourceText);
    if (!parsed.length) return 0;

    const groupOffset = state.rows.reduce((max, row) => Math.max(max, row.groupId || 1), 0);
    const newRows = normalizeParsedRows(parsed, groupOffset);
    state.rows = normalizeGroupIds(state.rows.concat(newRows));

    state.batches.push({
      batch_no: state.batches.length + 1,
      raw_text: state.rawText,
      normalized_text: state.aiUsed ? state.normalizedText : "",
      added_count: newRows.length,
      created_at: new Date().toISOString(),
    });

    state.rawText = "";
    state.normalizedText = "";
    state.aiUsed = false;
    rawInput.value = "";
    normalizedInput.value = "";
    rawView.textContent = "";

    return newRows.length;
  }

  /** 流式读取整理结果：模型输出逐字写进整理文本框，结束时返回服务端复核后的最终结果；
   *  isStale() 为真表示本次请求已被清空/新请求取代，立即停止写入并返回 null */
  async function readNormalizeStream(response, progress, isStale) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let result = null;
    let started = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        let obj;
        try {
          obj = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (obj.error) throw new Error(obj.error);
        if (obj.ticket_result) {
          result = obj.ticket_result;
          continue;
        }
        const delta = obj?.choices?.[0]?.delta || {};
        if (!started && delta.reasoning_content) {
          progress.setStage("模型思考中…");
        }
        const piece = delta.content || "";
        if (piece) {
          if (isStale && isStale()) {
            try { reader.cancel(); } catch {}
            return null;
          }
          if (!started) {
            started = true;
            progress.setStage("整理结果生成中…");
          }
          text += piece;
          normalizedInput.value = text;
          normalizedInput.scrollTop = normalizedInput.scrollHeight;
        }
      }
    }
    if (isStale && isStale()) return null;
    // 不再把半截流当成成功结果：没收到服务端复核后的 ticket_result 就是失败
    if (!result) throw new Error("AI 输出中断，未收到最终复核结果，请重试");
    return result;
  }

  async function runNormalize(button) {
    if (normalizing) return; // 已有整理请求在跑，避免并发两条流互相覆盖
    const raw = normalizeText(rawInput.value);
    if (!raw) {
      setNotice(1, "error", "请先粘贴需要处理的原始文本。");
      return;
    }

    state.rawText = rawInput.value;
    button.disabled = true;
    const seq = ++requestSeq;
    normalizing = true;
    const toParseButton = $("toParseBtn");
    if (toParseButton) toParseButton.disabled = true; // 整理没结束前禁止拆分，防止只提交半截人员
    setNotice(1, "", "");

    // 像问答一样：立即进入第 2 步，整理结果逐字出现，不再干等
    state.normalizedText = "";
    state.aiUsed = false;
    rawView.textContent = state.rawText;
    normalizedInput.value = "";
    gotoStep(2);
    setNotice(2, "info", "AI 正在整理格式，只调整排版、不改内容；结果会逐字出现在下方。");
    const progress = window.AiProgress
      ? window.AiProgress.start(notices[2], {
          key: "ticket:normalize",
          units: state.rawText.length,
          title: "AI 整理中…",
          fallbackMs: 30000,
        })
      : { setStage() {}, finish() {}, fail() {} };

    try {
      const response = await aiFetch(ticketApi.normalize, { raw_text: state.rawText, stream: true });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `API 请求失败：${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      let data;
      if (contentType.includes("text/event-stream") && response.body) {
        data = await readNormalizeStream(response, progress, () => seq !== requestSeq);
      } else {
        data = await response.json();
        if (data && data.error) throw new Error(data.error);
      }
      if (seq !== requestSeq || data === null) return; // 已被清空/新请求取代，丢弃旧结果

      const normalized = String(data.normalized_text || "").trim();
      if (!normalized) throw new Error("AI 未返回整理结果");

      state.normalizedText = normalized;
      state.aiUsed = true;
      normalizedInput.value = normalized;
      progress.finish();

      const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
      if (warnings.length) {
        setNotice(
          2,
          "info",
          `AI 提示：<ul class="warn-list">${warnings
            .slice(0, 12)
            .map((w) => `<li>${escapeHtml(w)}</li>`)
            .join("")}</ul>`
        );
      } else {
        setNotice(2, "success", data.summary ? escapeHtml(data.summary) : "整理完成，请核对右侧结果。");
      }
      scheduleDraftSave();
    } catch (error) {
      if (seq === requestSeq) {
        progress.fail("AI 整理失败");
        setNotice(
          2,
          "error",
          `AI 整理失败：${escapeHtml(error.message || "未知错误")}。可点「返回重新输入」后选择「跳过 AI，直接拆分」继续。`
        );
      }
    } finally {
      if (seq === requestSeq) endNormalizeUi();
      button.disabled = false;
    }
  }

  // ---------- 步骤 3：拆分 + 可编辑表格 ----------
  // width：每列输入框的最小宽度，保证手机上手机号/证件号完整可见（表格整体横向滚动）
  const EDIT_COLUMNS = [
    { field: "phone", label: "手机号", width: 128 },
    { field: "name", label: "姓名", width: 90 },
    { field: "documentType", label: "证件类型", width: 78 },
    { field: "idcard", label: "证件号", width: 190 },
    { field: "country", label: "国家地区", width: 90 },
    { field: "price", label: "票价", width: 60 },
    { field: "position", label: "位置", width: 108 },
    { field: "size", label: "尺码", width: 56 },
  ];

  // ---- FLIP 动画（整组上移/下移）：First → Last → Invert → Play ----
  // 每行数据用 WeakMap 挂一个稳定 key（不写进 row 对象，避免混进草稿/导出数据），
  // 全量重绘前后靠这个 key 对上"同一行"，才能算出位移差做动画。
  const flipKeys = new WeakMap();
  let flipKeySeq = 0;
  let isAnimating = false;

  function flipKeyFor(row) {
    let key = flipKeys.get(row);
    if (!key) {
      key = ++flipKeySeq;
      flipKeys.set(row, key);
    }
    return key;
  }

  // 记录当前表格里每一行的 Y 坐标，key → top
  function captureRowSnapshot() {
    const snapshot = new Map();
    editTableWrap.querySelectorAll("tr[data-flip-key]").forEach((tr) => {
      snapshot.set(tr.getAttribute("data-flip-key"), tr.getBoundingClientRect().top);
    });
    return snapshot;
  }

  // Invert + Play：把新 DOM 瞬间拉回旧位置，再用 transition 滑到新位置。
  // emphasizedKeys 是被移动的那一组，额外加轻微 scale + opacity 聚焦视觉。
  function animateRowMove(beforeSnapshot, afterSnapshot, emphasizedKeys = new Set()) {
    const easing = "cubic-bezier(0.25, 0.1, 0.25, 1.0)";
    const movingRows = [];
    editTableWrap.querySelectorAll("tr[data-flip-key]").forEach((tr) => {
      const key = tr.getAttribute("data-flip-key");
      const first = beforeSnapshot.get(key);
      const last = afterSnapshot.get(key);
      if (first === undefined || last === undefined) return;
      const delta = first - last;
      const emphasized = emphasizedKeys.has(key);
      if (!delta && !emphasized) return;
      tr.style.transition = "none";
      tr.style.willChange = "transform, opacity";
      tr.style.transform = `translateY(${delta}px)${emphasized ? " scale(0.97)" : ""}`;
      if (emphasized) tr.style.opacity = "0.6";
      movingRows.push(tr);
    });
    if (!movingRows.length) return;

    isAnimating = true;
    editTableWrap.offsetHeight; // 强制 reflow，让 Invert 状态先落地，transition 才有起点
    requestAnimationFrame(() => {
      movingRows.forEach((tr) => {
        tr.style.transition = `transform 350ms ${easing}, opacity 350ms ${easing}`;
        tr.style.transform = "";
        tr.style.opacity = "";
      });
    });
    window.setTimeout(() => {
      movingRows.forEach((tr) => {
        tr.style.transition = "";
        tr.style.willChange = "";
      });
      isAnimating = false;
    }, 400);
  }

  function renderEditTable() {
    if (!state.rows.length) {
      editTableWrap.innerHTML = '<div style="padding:16px; color: var(--muted); font-size: 13px;">暂无数据。</div>';
      tableMeta.textContent = "";
      return new Map();
    }

    const groups = getGroupRows(state.rows);
    const rowIndexOf = new Map(state.rows.map((row, idx) => [row, idx]));
    const cellIssueList = computeCellIssues(state.rows, state.batches);
    let rowNo = 0;

    const bodyRows = groups
      .map((group, groupIndex) => {
        const dataRows = group.rows
          .map((row) => {
            const index = rowIndexOf.get(row);
            rowNo += 1;
            const rowCells = cellIssueList[index] || {};
            const cells = EDIT_COLUMNS.map((col) => {
              const issue = rowCells[col.field];
              const warn = issue ? ` ${issue.cls}` : "";
              // title 给桌面悬停；data-tip 给手机点击弹气泡
              const title = issue ? ` title="${escapeHtml(issue.msg)}" data-tip="${escapeHtml(issue.msg)}" data-tip-level="${issue.cls}"` : "";
              return `<td><input class="table-input${warn}" style="min-width:${col.width}px" data-index="${index}" data-field="${col.field}" value="${escapeHtml(row[col.field] || "")}"${title} /></td>`;
            }).join("");
            return `
              <tr data-flip-key="r${flipKeyFor(row)}">
                <td>${index + 1}</td>
                ${cells}
                <td>
                  <button type="button" class="row-btn" data-action="prev-group" data-index="${index}">上一组</button>
                  <button type="button" class="row-btn" data-action="next-group" data-index="${index}">下一组</button>
                  <button type="button" class="row-btn" data-action="delete" data-index="${index}">删</button>
                </td>
              </tr>`;
          })
          .join("");

        return `
          ${dataRows}
          <tr class="group-summary" data-flip-key="g${flipKeyFor(group.rows[0])}">
            <td colspan="3">第 ${groupIndex + 1} 组 · ${group.rows.length} 人</td>
            <td>
              <button type="button" class="row-btn" data-gaction="up" data-gid="${group.groupId}" ${groupIndex === 0 ? "disabled" : ""}>整组上移</button>
              <button type="button" class="row-btn" data-gaction="down" data-gid="${group.groupId}" ${groupIndex === groups.length - 1 ? "disabled" : ""}>整组下移</button>
            </td>
            <td>合计（金额）</td>
            <td></td>
            <td>${groupTotal(group.rows) || ""}</td>
            <td colspan="3"></td>
          </tr>`;
      })
      .join("");

    editTableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>No</th>
            ${EDIT_COLUMNS.map((col) => `<th>${col.label}</th>`).join("")}
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>`;

    const errors = collectErrors(state.rows);
    const strongIssues = collectStrongIssues(state.rows, state.batches);
    const warnCount = errors.length + strongIssues.length;
    tableMeta.innerHTML = `<span>共 ${state.rows.length} 人 / ${groups.length} 组 / ${state.batches.length} 批</span><span>${
      warnCount ? `⚠️ ${warnCount} 处待确认` : "✓ 校验全部通过"
    }</span>`;

    if (warnCount) {
      const combined = strongIssues.concat(errors);
      setNotice(
        3,
        "info",
        `有 ${warnCount} 处没通过校验，可以直接修改，也可以确认无误后继续：<ul class="warn-list">${combined
          .slice(0, 12)
          .map((e) => `<li>${escapeHtml(e)}</li>`)
          .join("")}${combined.length > 12 ? `<li>……其余 ${combined.length - 12} 条见下方红色格子与第 4 步检查</li>` : ""}</ul>`
      );
    } else {
      setNotice(3, "", "");
    }

    attachEditHandlers();
    scheduleDraftSave();
    return captureRowSnapshot();
  }

  // ---------- 问题格子气泡（点击/聚焦即显示原因，手机桌面通用） ----------
  let cellTipEl = null;

  function hideCellTip() {
    if (cellTipEl) {
      cellTipEl.remove();
      cellTipEl = null;
    }
  }

  function showCellTip(input) {
    hideCellTip();
    const msg = input.getAttribute("data-tip");
    if (!msg) return;
    const level = input.getAttribute("data-tip-level") || "";
    cellTipEl = document.createElement("div");
    cellTipEl.className = `cell-tip${level === "cell-error" ? " cell-tip-error" : ""}`;
    cellTipEl.textContent = msg;
    document.body.appendChild(cellTipEl);
    const rect = input.getBoundingClientRect();
    const tipRect = cellTipEl.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - tipRect.width / 2),
      window.innerWidth - tipRect.width - 8
    );
    const top = rect.top - tipRect.height - 8;
    cellTipEl.style.left = `${left}px`;
    // 顶部放不下就放到格子下方（横向滚动表格贴近屏幕顶时）
    cellTipEl.style.top = `${top > 4 ? top : rect.bottom + 8}px`;
  }

  editTableWrap.addEventListener("focusin", (event) => {
    const input = event.target;
    if (input && input.matches && input.matches("input[data-tip]")) {
      showCellTip(input);
    }
  });
  editTableWrap.addEventListener("focusout", hideCellTip);
  editTableWrap.addEventListener("scroll", hideCellTip, { passive: true });
  window.addEventListener("scroll", hideCellTip, { passive: true });

  function syncRowsFromDom() {
    editTableWrap.querySelectorAll("input[data-index][data-field]").forEach((input) => {
      const index = Number(input.getAttribute("data-index"));
      const field = input.getAttribute("data-field");
      if (!state.rows[index] || !field) return;
      state.rows[index][field] = input.value.trim();
    });
  }

  function attachEditHandlers() {
    editTableWrap.querySelectorAll("input[data-index]").forEach((input) => {
      input.addEventListener("change", () => {
        syncRowsFromDom();
        renderEditTable();
      });
    });

    editTableWrap.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        if (isAnimating) return;
        syncRowsFromDom();
        const index = Number(button.getAttribute("data-index"));
        const action = button.getAttribute("data-action");
        const row = state.rows[index];
        if (!row) return;

        if (action === "delete") {
          state.rows.splice(index, 1);
          state.rows = normalizeGroupIds(state.rows);
          renderEditTable();
          return;
        }

        // prev-group / next-group：单行换组，走 FLIP 动画
        const beforeSnapshot = captureRowSnapshot();
        const emphasizedKeys = new Set([`r${flipKeyFor(row)}`]);

        const flatRows = reorderForGroupMove(state.rows, index, action);
        if (!flatRows) return; // prev-group 已在第一组，无变化

        state.rows = normalizeGroupIds(flatRows);
        state.rows.forEach((r, i) => flipKeys.set(r, flipKeyFor(flatRows[i])));

        const afterSnapshot = renderEditTable();
        animateRowMove(beforeSnapshot, afterSnapshot, emphasizedKeys);
      });
    });

    editTableWrap.querySelectorAll("[data-gaction]").forEach((button) => {
      button.addEventListener("click", () => {
        if (isAnimating) return;
        syncRowsFromDom();
        const gid = Number(button.getAttribute("data-gid"));
        const direction = button.getAttribute("data-gaction");
        const groups = getGroupRows(state.rows);
        const pos = groups.findIndex((group) => group.groupId === gid);
        if (pos === -1) return;
        const target = direction === "up" ? pos - 1 : pos + 1;
        if (target < 0 || target >= groups.length) return;

        // FLIP 第一步（First）：重绘前记录每行旧位置
        const beforeSnapshot = captureRowSnapshot();
        const movedGroup = groups[pos];
        const emphasizedKeys = new Set(movedGroup.rows.map((row) => `r${flipKeyFor(row)}`));
        emphasizedKeys.add(`g${flipKeyFor(movedGroup.rows[0])}`);

        [groups[pos], groups[target]] = [groups[target], groups[pos]];
        const flatRows = groups.flatMap((group) => group.rows);
        state.rows = normalizeGroupIds(flatRows);
        // normalizeGroupIds 会复制行对象，这里按位置把 FLIP key 转移到新对象上，前后快照才能对上
        state.rows.forEach((row, i) => flipKeys.set(row, flipKeyFor(flatRows[i])));

        const afterSnapshot = renderEditTable();
        animateRowMove(beforeSnapshot, afterSnapshot, emphasizedKeys);
      });
    });
  }

  // ---------- 步骤 4：模板预览 + AI 检查 + 导出 ----------
  function renderPreviewTable() {
    if (!state.rows.length) {
      previewTableWrap.innerHTML = '<div style="padding:16px; color: var(--muted); font-size: 13px;">暂无数据。</div>';
      return;
    }

    const groups = getGroupRows(state.rows);
    let rowNo = 0;

    const bodyRows = groups
      .map((group) => {
        // 位置只有在组内完全一致时才按“组”显示在第一行；
        // 出现多个不同位置时逐人显示，保证不会静默丢掉非首人的位置
        const positions = uniqueNonEmpty(group.rows.map((r) => r.position));
        const uniformPosition = positions.length <= 1;
        const dataRows = group.rows
          .map((row, groupRowIndex) => {
            rowNo += 1;
            const positionCell = uniformPosition
              ? (groupRowIndex === 0 ? positions[0] || "" : "")
              : row.position || "";
            return `
              <tr>
                <td>${rowNo}</td>
                <td>${escapeHtml(row.phone || "")}</td>
                <td>${escapeHtml(row.name || "")}</td>
                <td>${escapeHtml(row.documentType || "")}</td>
                <td>${escapeHtml(String(row.idcard || "").toUpperCase())}</td>
                <td>${escapeHtml(row.country || "")}</td>
                <td>${escapeHtml(row.price || "")}</td>
                <td>${escapeHtml(positionCell)}</td>
                <td>${escapeHtml(row.size || "")}</td>
              </tr>`;
          })
          .join("");

        return `
          ${dataRows}
          <tr class="group-summary">
            <td colspan="4"></td>
            <td>合计（金额）</td>
            <td></td>
            <td>${groupTotal(group.rows)}元</td>
            <td colspan="2"></td>
          </tr>`;
      })
      .join("");

    previewTableWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>No</th><th>持票人手机号</th><th>姓名</th><th>证件类型</th><th>证件号</th>
            <th>国家地区</th><th>票价</th><th>位置</th><th>尺码</th>
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
          <tr class="grand-total">
            <td colspan="4"></td>
            <td>总人数</td>
            <td></td>
            <td>${state.rows.length}人</td>
            <td colspan="2"></td>
          </tr>
          <tr class="grand-total">
            <td colspan="4"></td>
            <td>总合计</td>
            <td></td>
            <td>${rowsTotal(state.rows)}元</td>
            <td colspan="2"></td>
          </tr>
        </tbody>
      </table>`;

    if (!exportNameInput.value.trim()) {
      exportNameInput.value = defaultExportFilename();
    }

    // 进入第 4 步就先跑一遍本地校验（字段错误 + 强校验），不等 AI、也不依赖 AI。
    // 红色字段错误（缺姓名/缺证件号等）过去只在第 3 步显示，这里必须一并算进来，
    // 否则会出现“缺证件号却全绿导出”的假通过。
    const localIssues = collectErrors(state.rows).concat(collectStrongIssues(state.rows, state.batches));
    if (localIssues.length) {
      setNotice(
        4,
        "info",
        `本地校验发现 ${localIssues.length} 处风险，建议先返回处理再导出：<ul class="warn-list">${localIssues
          .slice(0, 15)
          .map((i) => `<li>${escapeHtml(i)}</li>`)
          .join("")}${localIssues.length > 15 ? `<li>……其余 ${localIssues.length - 15} 条见导出前确认框</li>` : ""}</ul>`
      );
    } else {
      setNotice(4, "success", "本地校验通过：字段完整性、人数对账、证件唯一性、护照国家、票价位置均无异常。");
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

  /** 流式读取 AI 检查：思考过程实时写进灰色小字区，结论 JSON 不上屏、等 ticket_result */
  async function readAuditStream(response, progress, thinkingEl) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;
    let sawConclusion = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        let obj;
        try {
          obj = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (obj.error) throw new Error(obj.error);
        if (obj.ticket_result) {
          result = obj.ticket_result;
          continue;
        }
        const delta = obj?.choices?.[0]?.delta || {};
        const thought = delta.reasoning_content || "";
        if (thought && thinkingEl.isConnected) {
          thinkingEl.textContent += thought;
          thinkingEl.scrollTop = thinkingEl.scrollHeight;
        }
        if (delta.content && !sawConclusion) {
          sawConclusion = true;
          progress.setStage("生成检查结论中…");
        }
      }
    }
    return result;
  }

  async function runAudit(button) {
    if (!state.rows.length) return;

    const seq = ++requestSeq; // 清空/重新拆分后，旧的检查结果不允许再写回页面
    button.disabled = true;
    auditBox.className = "audit-box show";
    auditBox.innerHTML = "<h3>AI 正在对照原文做最终检查</h3>";
    const progress = window.AiProgress
      ? window.AiProgress.start(auditBox, {
          key: "ticket:audit",
          units: state.rows.length,
          title: "逐人核对原文中…",
          fallbackMs: 90000,
        })
      : { setStage() {}, finish() {}, fail() {} };

    // 模型思考过程：进度条下方灰色小字实时滚动，让人看到它在核对什么
    const thinkingEl = document.createElement("div");
    thinkingEl.className = "audit-thinking";
    auditBox.appendChild(thinkingEl);

    // 字段级红色错误也算本地发现，AI 检查页不能比第 3 步更宽松
    const localFindings = collectErrors(state.rows).concat(collectStrongIssues(state.rows, state.batches));

    try {
      // 最高优先级依据：每一批最初粘贴的未格式化原文，全量送审
      const batches = state.batches.length
        ? state.batches
        : [{ batch_no: 1, raw_text: state.rawText || "", normalized_text: state.normalizedText || "", added_count: state.rows.length }];
      const payload = {
        stream: true,
        raw_text: batches.map((b) => b.raw_text).filter(Boolean).join("\n\n"),
        source_batches: batches,
        normalized_text: batches.map((b) => b.normalized_text).filter(Boolean).join("\n\n"),
        rows: buildAiRows(state.rows),
        local_findings: localFindings,
        totals: {
          personCount: state.rows.length,
          groupCount: getGroupRows(state.rows).length,
          totalAmount: rowsTotal(state.rows),
        },
      };

      const response = await aiFetch(ticketApi.audit, payload);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `API 请求失败：${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      let data = null;
      if (contentType.includes("text/event-stream") && response.body) {
        data = await readAuditStream(response, progress, thinkingEl);
      } else {
        data = await response.json();
        if (data && data.error) throw new Error(data.error);
      }
      if (!data) throw new Error("AI 未返回检查结果");
      if (seq !== requestSeq) return; // 页面已被清空或重新拆分，丢弃旧检查结果

      progress.finish();
      const aiIssues = Array.isArray(data.issues) ? data.issues.filter(Boolean) : [];
      // 本地硬校验结果必须展示，AI 说通过也不能吞掉
      const issues = Array.from(new Set(localFindings.concat(aiIssues)));
      const ok = Boolean(data.ok) && !issues.length;
      auditBox.className = `audit-box show ${ok ? "ok" : "bad"}`;
      auditBox.innerHTML = `
        <h3>${ok ? "✓ 本地强校验 + AI 检查均通过" : "⚠️ 检查发现需要确认的地方"}</h3>
        <div>${escapeHtml(data.summary || (ok ? "未发现明显问题。" : "请逐条核对以下提示。"))}</div>
        ${issues.length ? `<ul>${issues.slice(0, 20).map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : ""}
        ${ok ? "" : '<div style="margin-top:8px;">如需修改，点左下角「返回修改」；检查只提示、不会自动改数据。</div>'}`;
    } catch (error) {
      if (seq !== requestSeq) return;
      progress.fail("AI 检查失败");
      auditBox.className = "audit-box show bad";
      auditBox.innerHTML = `<h3>AI 检查失败</h3><div>${escapeHtml(
        error.message || "未知错误"
      )}。</div>${
        localFindings.length
          ? `<div style="margin-top:8px;">但本地强校验已发现 ${localFindings.length} 处风险，导出前请务必处理：</div><ul>${localFindings
              .slice(0, 20)
              .map((i) => `<li>${escapeHtml(i)}</li>`)
              .join("")}</ul>`
          : "<div style=\"margin-top:8px;\">本地强校验未发现异常，可人工核对后导出。</div>"
      }`;
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Excel 导出（沿用旧版模板结构逻辑，ExcelJS 实现） ----------
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

    return { height: sourceRow.height, cells };
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
      // 与预览一致：组内位置完全一致才合并单元格，否则逐人填写各自位置
      const positions = uniqueNonEmpty(group.rows.map((r) => r.position));
      const uniformPosition = positions.length <= 1;

      group.rows.forEach((row, groupRowIndex) => {
        applyExcelRowTemplate(worksheet, templateRows.data, rowIndex);
        const targetRow = worksheet.getRow(rowIndex);
        targetRow.getCell(1).value = row.phone || "";
        targetRow.getCell(2).value = row.name || "";
        targetRow.getCell(3).value = row.documentType || "";
        targetRow.getCell(4).value = row.documentNo || "";
        targetRow.getCell(5).value = row.country || "";
        targetRow.getCell(6).value = row.price || "";
        targetRow.getCell(7).value = uniformPosition
          ? (groupRowIndex === 0 ? positions[0] || "" : "")
          : row.position || "";
        targetRow.getCell(8).value = row.size || "";
        rowIndex += 1;
      });

      if (group.rows.length > 1 && uniformPosition) {
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

  function handleExport(button) {
    if (!state.rows.length) return;

    if (typeof ExcelJS === "undefined") {
      setNotice(4, "error", "未检测到 Excel 导出库（ExcelJS），请检查网络后刷新页面重试。");
      return;
    }

    // 导出硬门槛：红色字段错误 + 强校验风险都必须逐条确认后才能导出
    const errors = collectErrors(state.rows);
    const strongIssues = collectStrongIssues(state.rows, state.batches);
    const blockers = errors.concat(strongIssues);
    if (blockers.length) {
      const preview = blockers.slice(0, 10).join("\n");
      const confirmed = window.confirm(
        `导出前发现 ${blockers.length} 处问题（字段错误 ${errors.length} 处、强校验风险 ${strongIssues.length} 处）：\n\n${preview}${
          blockers.length > 10 ? "\n……" : ""
        }\n\n这些问题可能导致错人、漏人或金额错误。确定仍要导出吗？（强烈建议先返回修改）`
      );
      if (!confirmed) return;
    }
    const exportRows = state.rows.map((row) => ({
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

    const filename = normalizeFilename(exportNameInput.value);
    exportNameInput.value = filename;

    button.disabled = true;
    setNotice(4, "info", '<span class="loading-dot">正在生成 Excel</span>');

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

        buildStructuredExcelTemplateSheet(worksheet, exportRows);

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

        setNotice(
          4,
          "success",
          `已导出 ${escapeHtml(filename)}（${exportRows.length} 人 / ${getGroupRows(exportRows).length} 组）。${
            errors.length ? `注意：仍有 ${errors.length} 处校验提示，请在 Excel 中再核对一遍。` : ""
          }`
        );
      })
      .catch((error) => {
        setNotice(
          4,
          "error",
          `导出失败：${escapeHtml(error.message || "无法读取购票模板文件")}。请确认页面与 购票模板.xlsx 在同一站点下发布（本地直接双击打开会被浏览器拦截，建议通过本地服务器或线上地址访问）。`
        );
      })
      .finally(() => {
        button.disabled = false;
      });
  }

  // ---------- 事件绑定 ----------
  $("toAiBtn").addEventListener("click", (e) => runNormalize(e.currentTarget));

  $("skipAiBtn").addEventListener("click", () => {
    const raw = normalizeText(rawInput.value);
    if (!raw) {
      setNotice(1, "error", "请先粘贴需要处理的原始文本。");
      return;
    }
    state.rawText = rawInput.value;
    state.normalizedText = "";
    state.aiUsed = false;
    const added = commitBatch(raw);
    if (!added) {
      setNotice(1, "error", "未识别出任何用户信息，请确认文本中包含手机号 / 身份证号等关键信息。");
      return;
    }
    setNotice(1, "", "");
    setNotice(3, "", "");
    gotoStep(3);
  });

  $("backTo1Btn").addEventListener("click", () => gotoStep(1));

  $("redoAiBtn").addEventListener("click", (e) => {
    rawInput.value = state.rawText;
    gotoStep(1);
    runNormalize(e.currentTarget);
  });

  $("toParseBtn").addEventListener("click", () => {
    if (normalizing) {
      setNotice(2, "error", "AI 整理还没结束，现在拆分会只提交半截内容；请等整理完成，或返回第 1 步选「跳过 AI，直接拆分」。");
      return;
    }
    const normalized = normalizedInput.value;
    if (!normalizeText(normalized)) {
      setNotice(2, "error", "整理结果为空，无法拆分。");
      return;
    }
    state.normalizedText = normalized;
    const added = commitBatch(normalized);
    if (!added) {
      setNotice(2, "error", "未识别出任何用户信息，请检查整理结果里是否包含手机号 / 证件号。");
      return;
    }
    setNotice(3, "", "");
    gotoStep(3);
  });

  $("appendBatchBtn").addEventListener("click", () => {
    syncRowsFromDom();
    gotoStep(1);
  });

  $("toPreviewBtn").addEventListener("click", () => {
    syncRowsFromDom();
    if (!state.rows.length) {
      setNotice(3, "error", "当前没有任何数据，请返回上一步重新拆分。");
      return;
    }
    auditBox.className = "audit-box";
    auditBox.innerHTML = "";
    setNotice(4, "", "");
    gotoStep(4);
  });

  $("backTo3Btn").addEventListener("click", () => gotoStep(3));

  $("auditBtn").addEventListener("click", (e) => runAudit(e.currentTarget));

  $("exportBtn").addEventListener("click", (e) => handleExport(e.currentTarget));

  $("resetBtn").addEventListener("click", () => {
    if (!window.confirm("确定清空所有内容重新开始吗？")) return;
    requestSeq += 1; // 作废所有在途 AI 响应，防止清空后旧结果又被写回来
    endNormalizeUi();
    state.rawText = "";
    state.normalizedText = "";
    state.aiUsed = false;
    state.rows = [];
    state.batches = [];
    nextGroupId = 1;
    rawInput.value = "";
    normalizedInput.value = "";
    rawView.textContent = "";
    exportNameInput.value = defaultExportFilename();
    auditBox.className = "audit-box";
    auditBox.innerHTML = "";
    [1, 2, 3, 4].forEach((n) => setNotice(n, "", ""));
    clearDraft();
    gotoStep(1);
  });

  rawInput.addEventListener("input", () => {
    state.rawText = rawInput.value;
    scheduleDraftSave();
  });

  normalizedInput.addEventListener("input", () => {
    state.normalizedText = normalizedInput.value;
    scheduleDraftSave();
  });

  exportNameInput.addEventListener("input", scheduleDraftSave);

  // ---------- 初始化 ----------
  if (loadDraft()) {
    rawView.textContent = state.rawText;
    gotoStep(state.step);
  } else {
    exportNameInput.value = defaultExportFilename();
    gotoStep(1);
  }

  // 仅供本地回归测试脚本使用（浏览器正常使用不会触发）
  if (typeof window !== "undefined" && window.__PARSER_V2_TEST__) {
    window.__parserV2Internals = {
      buildRowsFromText,
      normalizeParsedRows,
      extractDocumentAnchors,
      extractIdentityTokens,
      findDroppedIdentityTokens,
      findPhantomRowIndexes,
      collectStrongIssues,
      computeCellIssues,
      getGroupRows,
      normalizeGroupIds,
      reorderForGroupMove,
    };
  }
})();
