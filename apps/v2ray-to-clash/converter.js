/* 节点链接解析 + Clash(mihomo) 配置生成，纯浏览器端运行。
   与本地工具 v2ray-to-clash/converter.py、template.py 是同一套逻辑的 JS 版本，
   改协议解析或配置模板时两边都要改。 */
(function (global) {
  "use strict";

  // ── 基础工具 ────────────────────────────────────────────

  function b64Bytes(s) {
    s = String(s || "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    const pad = s.length % 4;
    if (pad) s += "=".repeat(4 - pad);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function b64Text(s) {
    try {
      return new TextDecoder("utf-8").decode(b64Bytes(s));
    } catch (e) {
      return "";
    }
  }

  function unq(s) {
    try {
      return decodeURIComponent(s || "");
    } catch (e) {
      return s || "";
    }
  }

  function parseQs(query) {
    const out = {};
    for (const kv of String(query || "").split("&")) {
      if (!kv) continue;
      const i = kv.indexOf("=");
      const k = unq(i < 0 ? kv : kv.slice(0, i));
      const v = i < 0 ? "" : unq(kv.slice(i + 1));
      if (k && !(k in out)) out[k] = v;
    }
    return out;
  }

  const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v).toLowerCase());

  function splitHostPort(hostport) {
    hostport = String(hostport || "").trim();
    if (hostport.startsWith("[")) {                 // IPv6：[::1]:443
      const end = hostport.indexOf("]");
      const host = hostport.slice(1, end);
      const rest = hostport.slice(end + 1);
      return [host, rest.startsWith(":") ? rest.slice(1) : ""];
    }
    const i = hostport.lastIndexOf(":");
    if (i < 0) return [hostport, ""];
    return [hostport.slice(0, i), hostport.slice(i + 1)];
  }

  function toPort(s, dflt) {
    const n = parseInt(String(s || "").trim(), 10);
    return Number.isFinite(n) ? n : (dflt == null ? 443 : dflt);
  }

  function splitLink(link) {
    const i = link.indexOf("://");
    const scheme = link.slice(0, i).toLowerCase();
    let rest = link.slice(i + 3);
    const h = rest.indexOf("#");
    const frag = h < 0 ? "" : unq(rest.slice(h + 1));
    if (h >= 0) rest = rest.slice(0, h);
    return [scheme, rest, frag];
  }

  /* 把 认证信息@host:port?query 拆开。
     先切掉 query 再从右边找 @：密码里带原始 @ 时从左边找会切错，
     而 host 部分不可能出现 @，所以取最后一个才可靠。 */
  function splitBody(body) {
    const q = body.indexOf("?");
    const hostpart = q < 0 ? body : body.slice(0, q);
    const query = q < 0 ? "" : body.slice(q + 1);
    const at = hostpart.lastIndexOf("@");
    const userinfo = at < 0 ? "" : hostpart.slice(0, at);
    const hostport = at < 0 ? hostpart : hostpart.slice(at + 1);
    const [host, port] = splitHostPort(hostport);
    return { userinfo, host, port, p: parseQs(query) };
  }

  const insecure = (p) =>
    truthy(p.insecure || p.allowInsecure || p.allow_insecure || p["skip-cert-verify"] || "0");

  function applyAlpn(proxy, p) {
    const alpn = p.alpn || "";
    if (alpn) {
      const list = alpn.split(",").map((x) => x.trim()).filter(Boolean);
      if (list.length) proxy.alpn = list;
    }
  }

  // 传输层：ws / grpc / h2 / httpupgrade / xhttp / tcp+http伪装
  function applyTransport(proxy, p) {
    let net = String(p.type || "tcp").toLowerCase();
    if (net === "" || net === "none" || net === "raw") net = "tcp";

    if (net === "ws" || net === "websocket" || net === "httpupgrade") {
      proxy.network = "ws";
      const opts = { path: p.path || "/" };
      if (p.host) opts.headers = { Host: p.host };
      if (net === "httpupgrade") opts["v2ray-http-upgrade"] = true;
      proxy["ws-opts"] = opts;
    } else if (net === "grpc") {
      proxy.network = "grpc";
      proxy["grpc-opts"] = { "grpc-service-name": p.serviceName || p.servicename || p.path || "" };
    } else if (net === "h2" || net === "http") {
      proxy.network = "h2";
      const opts = { path: p.path || "/" };
      if (p.host) opts.host = p.host.split(",").filter(Boolean);
      proxy["h2-opts"] = opts;
    } else if (net === "xhttp" || net === "splithttp") {
      proxy.network = "http";
      const opts = {};
      if (p.path) opts.path = [p.path];
      if (p.host) opts.headers = { Host: p.host };
      if (Object.keys(opts).length) proxy["http-opts"] = opts;
    } else if (net === "tcp") {
      if (String(p.headerType || "").toLowerCase() === "http") {
        proxy.network = "http";
        const opts = {};
        if (p.path) opts.path = [p.path];
        if (p.host) opts.headers = { Host: p.host };
        if (Object.keys(opts).length) proxy["http-opts"] = opts;
      } else {
        proxy.network = "tcp";
      }
    } else {
      proxy.network = net;
    }
  }

  // ── 各协议解析 ──────────────────────────────────────────

  function parseVmess(link) {
    const [, body, frag] = splitLink(link);
    const txt = b64Text(body);
    if (!txt.trim().startsWith("{")) return null;
    let c;
    try {
      c = JSON.parse(txt);
    } catch (e) {
      return null;
    }

    const proxy = {
      name: String(c.ps || c.remarks || frag || "vmess"),
      type: "vmess",
      server: String(c.add || ""),
      port: toPort(c.port),
      uuid: String(c.id || ""),
      alterId: toPort(c.aid, 0),
      cipher: String(c.scy || "auto"),
      udp: true,
    };
    const tls = String(c.tls || "").toLowerCase();
    if (tls === "tls" || tls === "reality") {
      proxy.tls = true;
      const sni = c.sni || c.host || "";
      if (sni) proxy.servername = String(sni);
      if (c.fp) proxy["client-fingerprint"] = String(c.fp);
    }
    if (truthy(c.allowInsecure)) proxy["skip-cert-verify"] = true;

    const p = {
      type: String(c.net || "tcp"),
      path: String(c.path || ""),
      host: String(c.host || ""),
      serviceName: String(c.path || ""),
      headerType: String(c.type || ""),
      alpn: String(c.alpn || ""),
    };
    applyTransport(proxy, p);
    applyAlpn(proxy, p);
    return proxy;
  }

  function parseVless(link) {
    const [, body, frag] = splitLink(link);
    const { userinfo, host, port, p } = splitBody(body);

    const proxy = {
      name: frag || `vless-${host}`,
      type: "vless",
      server: host,
      port: toPort(port),
      uuid: unq(userinfo),
      udp: true,
    };

    const security = String(p.security || "none").toLowerCase();
    if (["tls", "reality", "xtls"].includes(security)) {
      proxy.tls = true;
      const sni = p.sni || p.peer || p.host || "";
      if (sni) proxy.servername = sni;
      if (p.fp) proxy["client-fingerprint"] = p.fp;
    }
    if (security === "reality") {
      const ro = { "public-key": p.pbk || "" };
      if (p.sid) ro["short-id"] = p.sid;
      proxy["reality-opts"] = ro;
      if (!proxy["client-fingerprint"]) proxy["client-fingerprint"] = "chrome";
    }
    if (p.flow) proxy.flow = p.flow;
    if (insecure(p)) proxy["skip-cert-verify"] = true;

    applyTransport(proxy, p);
    applyAlpn(proxy, p);
    return proxy;
  }

  function parseTrojan(link) {
    const [, body, frag] = splitLink(link);
    const { userinfo, host, port, p } = splitBody(body);

    const proxy = {
      name: frag || `trojan-${host}`,
      type: "trojan",
      server: host,
      port: toPort(port),
      password: unq(userinfo),
      udp: true,
    };
    const sni = p.sni || p.peer || "";
    if (sni) proxy.sni = sni;
    if (p.fp) proxy["client-fingerprint"] = p.fp;
    if (insecure(p)) proxy["skip-cert-verify"] = true;

    applyTransport(proxy, p);
    applyAlpn(proxy, p);
    return proxy;
  }

  function parseSs(link) {
    let [, body, frag] = splitLink(link);
    let query = "";
    const q = body.indexOf("?");
    if (q >= 0) {
      query = body.slice(q + 1);
      body = body.slice(0, q);
    }
    const p = parseQs(query);

    let method = "", password = "", hostport = "";
    if (body.includes("@")) {
      // SIP002: ss://base64(method:pass)@host:port
      const at = body.lastIndexOf("@");
      const userinfo = body.slice(0, at);
      hostport = body.slice(at + 1);
      const decoded = b64Text(userinfo);
      const src = decoded.includes(":") ? decoded : unq(userinfo);
      const i = src.indexOf(":");
      method = i < 0 ? src : src.slice(0, i);
      password = i < 0 ? "" : src.slice(i + 1);
    } else {
      // 老格式: ss://base64(method:pass@host:port)
      const decoded = b64Text(body);
      if (!decoded.includes("@")) return null;
      const at = decoded.lastIndexOf("@");
      const creds = decoded.slice(0, at);
      hostport = decoded.slice(at + 1);
      const i = creds.indexOf(":");
      method = i < 0 ? creds : creds.slice(0, i);
      password = i < 0 ? "" : creds.slice(i + 1);
    }

    const [host, port] = splitHostPort(hostport);
    const proxy = {
      name: frag || `ss-${host}`,
      type: "ss",
      server: host,
      port: toPort(port, 8388),
      cipher: method || "aes-128-gcm",
      password: password,
      udp: true,
    };

    const plugin = p.plugin || "";
    if (plugin) {
      const parts = plugin.split(";");
      const pname = parts[0];
      const popts = {};
      for (const kv of parts.slice(1)) {
        const i = kv.indexOf("=");
        if (i < 0) popts[kv] = true;
        else popts[kv.slice(0, i)] = kv.slice(i + 1);
      }
      if (pname === "obfs-local" || pname === "simple-obfs") {
        proxy.plugin = "obfs";
        proxy["plugin-opts"] = { mode: popts.obfs || "http", host: popts["obfs-host"] || "" };
      } else if (pname === "v2ray-plugin") {
        proxy.plugin = "v2ray-plugin";
        proxy["plugin-opts"] = {
          mode: "websocket",
          host: popts.host || "",
          path: popts.path || "/",
          tls: "tls" in popts,
        };
      }
    }
    return proxy;
  }

  function parseHysteria2(link) {
    const [, body, frag] = splitLink(link);
    const sb = splitBody(body);
    const { userinfo, host, p } = sb;
    let port = sb.port;

    // 端口跳跃：443,20000-30000 这种写法
    let ports = null;
    if (port.includes(",") || port.includes("-")) {
      ports = port;
      port = port.split(",")[0].split("-")[0];
    }

    const proxy = {
      name: frag || `hy2-${host}`,
      type: "hysteria2",
      server: host,
      port: toPort(port),
      password: unq(userinfo) || p.auth || "",
    };
    if (ports) proxy.ports = ports;
    if (p.mport) proxy.ports = p.mport;
    const sni = p.sni || p.peer || "";
    if (sni) proxy.sni = sni;
    if (insecure(p)) proxy["skip-cert-verify"] = true;
    if (p.obfs) {
      proxy.obfs = p.obfs;
      const pw = p["obfs-password"] || p.obfs_password || "";
      if (pw) proxy["obfs-password"] = pw;
    }
    if (p.pinSHA256) proxy.fingerprint = p.pinSHA256;
    applyAlpn(proxy, p);
    if (p.up) proxy.up = p.up;
    if (p.down) proxy.down = p.down;
    return proxy;
  }

  function parseHysteria1(link) {
    const [, body, frag] = splitLink(link);
    const { host, port, p } = splitBody(body);

    const proxy = {
      name: frag || `hy-${host}`,
      type: "hysteria",
      server: host,
      port: toPort(port),
      protocol: p.protocol || "udp",
      up: p.upmbps || p.up || "50",
      down: p.downmbps || p.down || "200",
    };
    if (p.auth) proxy["auth-str"] = p.auth;
    if (p.sni || p.peer) proxy.sni = p.sni || p.peer;
    if (p.obfs) proxy.obfs = p.obfs;
    if (insecure(p)) proxy["skip-cert-verify"] = true;
    applyAlpn(proxy, p);
    return proxy;
  }

  function parseTuic(link) {
    const [, body, frag] = splitLink(link);
    const { userinfo, host, port, p } = splitBody(body);
    const cred = unq(userinfo);
    const i = cred.indexOf(":");

    const proxy = {
      name: frag || `tuic-${host}`,
      type: "tuic",
      server: host,
      port: toPort(port),
      uuid: i < 0 ? cred : cred.slice(0, i),
      password: i < 0 ? "" : cred.slice(i + 1),
      "udp-relay-mode": p.udp_relay_mode || p["udp-relay-mode"] || "native",
      "congestion-controller": p.congestion_control || p["congestion-controller"] || "bbr",
    };
    if (p.sni) proxy.sni = p.sni;
    if (insecure(p) || truthy(p.allow_insecure)) proxy["skip-cert-verify"] = true;
    applyAlpn(proxy, p);
    return proxy;
  }

  function parseAnytls(link) {
    const [, body, frag] = splitLink(link);
    const { userinfo, host, port, p } = splitBody(body);

    const proxy = {
      name: frag || `anytls-${host}`,
      type: "anytls",
      server: host,
      port: toPort(port),
      password: unq(userinfo),
      udp: true,
    };
    if (p.sni) proxy.sni = p.sni;
    if (insecure(p)) proxy["skip-cert-verify"] = true;
    if (p.fp) proxy["client-fingerprint"] = p.fp;
    return proxy;
  }

  function parseSocks(link) {
    const [, body, frag] = splitLink(link);
    const { userinfo, host, port } = splitBody(body);
    const proxy = {
      name: frag || `socks-${host}`,
      type: "socks5",
      server: host,
      port: toPort(port, 1080),
      udp: true,
    };
    if (userinfo) {
      let cred = userinfo;
      if (!cred.includes(":")) cred = b64Text(cred);
      const i = cred.indexOf(":");
      if (i > 0) {
        proxy.username = unq(cred.slice(0, i));
        proxy.password = unq(cred.slice(i + 1));
      }
    }
    return proxy;
  }

  const PARSERS = {
    vmess: parseVmess,
    vless: parseVless,
    trojan: parseTrojan,
    ss: parseSs,
    hysteria2: parseHysteria2,
    hy2: parseHysteria2,
    hysteria: parseHysteria1,
    hy: parseHysteria1,
    tuic: parseTuic,
    anytls: parseAnytls,
    socks: parseSocks,
    socks5: parseSocks,
  };

  // ── 输入归一化 ──────────────────────────────────────────

  /* 把用户输入展开成一行一条的分享链接。
     浏览器有跨域限制，拉不了别人家的订阅链接，遇到 http(s) 链接只做标记，
     由调用方决定是否走后端代理。 */
  function expandInput(text) {
    const notes = [];
    const links = [];
    const subUrls = [];

    let lines = String(text || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));

    // 整块看起来像 base64（没有 ://）时先整体解码
    const joined = lines.join("");
    if (lines.length && !joined.includes("://") && /^[A-Za-z0-9+/=\-_\s]+$/.test(joined)) {
      const decoded = b64Text(joined);
      if (decoded.includes("://")) {
        lines = decoded.split("\n").map((l) => l.trim()).filter(Boolean);
        notes.push("检测到 base64 订阅内容，已自动解码");
      }
    }

    for (const line of lines) {
      const scheme = line.split("://")[0].toLowerCase();
      if ((scheme === "http" || scheme === "https") && !(scheme in PARSERS)) {
        subUrls.push(line);
      } else {
        links.push(line);
      }
    }
    return { links, notes, subUrls };
  }

  function parseLinks(links) {
    const proxies = [];
    const errors = [];
    const used = new Map();

    for (const line of links) {
      if (!line.includes("://")) continue;
      const scheme = line.split("://")[0].toLowerCase();
      const fn = PARSERS[scheme];
      if (!fn) {
        errors.push(`不支持的协议 ${scheme}：${line.slice(0, 50)}`);
        continue;
      }
      let proxy;
      try {
        proxy = fn(line);
      } catch (e) {
        errors.push(`解析失败（${scheme}）：${line.slice(0, 50)} —— ${e.message}`);
        continue;
      }
      if (!proxy || !proxy.server) {
        errors.push(`解析结果不完整：${line.slice(0, 50)}`);
        continue;
      }

      // 名字去重：Clash 遇到重名节点会直接丢弃
      let name = String(proxy.name || scheme).trim() || scheme;
      if (used.has(name)) {
        const n = used.get(name) + 1;
        used.set(name, n);
        name = `${name} ${n}`;
      } else {
        used.set(name, 1);
      }
      proxy.name = name;
      proxies.push(proxy);
    }
    return { proxies, errors };
  }

  // ── Clash 配置模板 ──────────────────────────────────────

  const REGIONS = [
    ["🇭🇰 香港节点", /香港|港|HK|Hong ?Kong|HKG/i],
    ["🇹🇼 台湾节点", /台湾|台灣|臺灣|TW|Taiwan|新北|彰化/i],
    ["🇯🇵 日本节点", /日本|川日|东京|東京|大阪|埼玉|JP|Japan/i],
    ["🇸🇬 新加坡节点", /新加坡|狮城|獅城|SG|Singapore/i],
    ["🇺🇸 美国节点", /美国|美國|洛杉矶|圣何塞|硅谷|凤凰城|达拉斯|USA?|United ?States/i],
    ["🇰🇷 韩国节点", /韩国|韓國|首尔|首爾|KR|Korea/i],
    ["🇬🇧 英国节点", /英国|英國|伦敦|倫敦|UK|United ?Kingdom/i],
    ["🇩🇪 德国节点", /德国|德國|法兰克福|DE|Germany/i],
  ];

  const BASE = {
    "mixed-port": 7890,
    "allow-lan": false,
    "bind-address": "*",
    mode: "rule",
    "log-level": "info",
    ipv6: true,
    "unified-delay": true,
    "tcp-concurrent": true,
    "find-process-mode": "strict",
    "global-client-fingerprint": "chrome",
    "keep-alive-interval": 30,
    "external-controller": "127.0.0.1:9090",
  };

  const PROFILE = { "store-selected": true, "store-fake-ip": true };

  const SNIFFER = {
    enable: true,
    sniff: {
      HTTP: { ports: [80, "8080-8880"], "override-destination": true },
      TLS: { ports: [443, 8443] },
      QUIC: { ports: [443, 8443] },
    },
    "skip-domain": ["Mijia Cloud", "+.push.apple.com"],
  };

  const DNS = {
    enable: true,
    listen: "0.0.0.0:1053",
    ipv6: true,
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter": [
      "*.lan", "*.local", "*.localdomain", "*.home.arpa", "localhost",
      "time.*.com", "ntp.*.com", "+.pool.ntp.org",
      "+.msftconnecttest.com", "+.msftncsi.com",
      "*.srv.nintendo.net", "*.stun.playstation.net", "xbox.*.microsoft.com",
      "+.qq.com", "+.wechat.com", "+.music.163.com",
    ],
    "default-nameserver": ["223.5.5.5", "119.29.29.29"],
    nameserver: ["https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"],
    "proxy-server-nameserver": ["https://dns.alidns.com/dns-query"],
    "nameserver-policy": {
      "geosite:cn": ["https://dns.alidns.com/dns-query"],
      "geosite:geolocation-!cn": ["https://dns.cloudflare.com/dns-query", "https://dns.google/dns-query"],
    },
  };

  const RULES_FULL = [
    "GEOSITE,category-ads-all,🛑 广告拦截",
    "GEOSITE,private,🎯 全球直连",
    "GEOSITE,openai,🤖 AI 服务",
    "DOMAIN-SUFFIX,anthropic.com,🤖 AI 服务",
    "DOMAIN-SUFFIX,claude.ai,🤖 AI 服务",
    "DOMAIN-SUFFIX,gemini.google.com,🤖 AI 服务",
    "DOMAIN-KEYWORD,openai,🤖 AI 服务",
    "GEOSITE,telegram,📲 电报消息",
    "GEOIP,telegram,📲 电报消息,no-resolve",
    "GEOSITE,youtube,🎬 国际媒体",
    "GEOSITE,netflix,🎬 国际媒体",
    "GEOIP,netflix,🎬 国际媒体,no-resolve",
    "GEOSITE,disney,🎬 国际媒体",
    "GEOSITE,primevideo,🎬 国际媒体",
    "GEOSITE,hbo,🎬 国际媒体",
    "GEOSITE,bahamut,🎬 国际媒体",
    "GEOSITE,spotify,🎬 国际媒体",
    "GEOSITE,tiktok,🎬 国际媒体",
    "GEOSITE,github,🚀 节点选择",
    "GEOSITE,microsoft@cn,🎯 全球直连",
    "GEOSITE,microsoft,Ⓜ️ 微软服务",
    "GEOSITE,apple@cn,🎯 全球直连",
    "GEOSITE,apple,🍎 苹果服务",
    "GEOSITE,steam@cn,🎯 全球直连",
    "GEOSITE,category-games@cn,🎯 全球直连",
    "GEOSITE,geolocation-!cn,🚀 节点选择",
    "GEOSITE,cn,🎯 全球直连",
    "GEOIP,lan,🎯 全球直连,no-resolve",
    "GEOIP,cn,🎯 全球直连",
    "MATCH,🐟 漏网之鱼",
  ];

  const RULES_MINI = [
    "DOMAIN-SUFFIX,local,DIRECT",
    "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
    "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
    "GEOIP,CN,DIRECT",
    "MATCH,🚀 节点选择",
  ];

  const j = (v) => JSON.stringify(v);   // JSON 是合法 YAML，节点名再怪也不会破坏格式

  function groupByRegion(names) {
    const groups = [];
    let rest = names.slice();
    for (const [label, rx] of REGIONS) {
      const hit = rest.filter((n) => rx.test(n));
      if (hit.length) {
        groups.push([label, hit]);
        rest = rest.filter((n) => !hit.includes(n));
      }
    }
    if (rest.length && groups.length) groups.push(["🌐 其它节点", rest]);
    return groups;
  }

  function buildGroups(names, testUrl, interval, regionGroups) {
    if (!names.length) names = ["DIRECT"];
    const regions = regionGroups && names.length > 1 ? groupByRegion(names) : [];
    const regionNames = regions.map((g) => g[0]);

    const auto = "♻️ 自动选择";
    const fallback = "🔯 故障转移";
    const main = "🚀 节点选择";

    const groups = [];
    groups.push({ name: main, type: "select", proxies: [auto, fallback, ...regionNames, ...names, "DIRECT"] });
    groups.push({ name: auto, type: "url-test", url: testUrl, interval, tolerance: 50, proxies: names });
    groups.push({ name: fallback, type: "fallback", url: testUrl, interval, proxies: names });
    for (const [label, members] of regions)
      groups.push({ name: label, type: "url-test", url: testUrl, interval, tolerance: 50, proxies: members });

    const common = [main, auto, ...regionNames, "DIRECT"];
    for (const label of ["🤖 AI 服务", "📲 电报消息", "🎬 国际媒体", "Ⓜ️ 微软服务", "🍎 苹果服务"]) {
      const head =
        label === "Ⓜ️ 微软服务" || label === "🍎 苹果服务"
          ? [main, "DIRECT", ...regionNames, auto]
          : common;
      groups.push({ name: label, type: "select", proxies: head });
    }

    groups.push({ name: "🎯 全球直连", type: "select", proxies: ["DIRECT", main] });
    groups.push({ name: "🛑 广告拦截", type: "select", proxies: ["REJECT", "DIRECT", main] });
    groups.push({ name: "🐟 漏网之鱼", type: "select", proxies: [main, "DIRECT", auto, ...regionNames] });
    return groups;
  }

  function buildConfig(proxies, opts) {
    opts = opts || {};
    const mode = opts.mode || "full";
    const testUrl = opts.testUrl || "https://www.gstatic.com/generate_204";
    const interval = opts.interval || 300;
    const names = proxies.map((p) => p.name);

    if (mode === "proxies") {
      const out = ["proxies:"];
      for (const p of proxies) out.push("  - " + j(p));
      out.push("");
      out.push("# 下面这段可以直接贴进你自己配置的 proxy-groups 里");
      for (const n of names) out.push("#   - " + n);
      return out.join("\n") + "\n";
    }

    const base = Object.assign({}, BASE, {
      "mixed-port": opts.mixedPort || 7890,
      "allow-lan": !!opts.allowLan,
    });

    const lines = ["# 由 V2Ray → Clash 转换工具生成", `# 共 ${proxies.length} 个节点`, ""];
    for (const k of Object.keys(base)) lines.push(`${k}: ${j(base[k])}`);
    lines.push(`profile: ${j(PROFILE)}`);
    lines.push("");

    if (mode === "full") {
      lines.push(`sniffer: ${j(SNIFFER)}`);
      lines.push("");
      lines.push("dns:");
      for (const k of Object.keys(DNS)) lines.push(`  ${k}: ${j(DNS[k])}`);
      lines.push("");
    }

    lines.push("proxies:");
    if (proxies.length) for (const p of proxies) lines.push("  - " + j(p));
    else lines.push("  []");
    lines.push("");

    lines.push("proxy-groups:");
    for (const g of buildGroups(names, testUrl, interval, opts.regionGroups !== false))
      lines.push("  - " + j(g));
    lines.push("");

    lines.push("rules:");
    for (const r of mode === "full" ? RULES_FULL : RULES_MINI) lines.push("  - " + j(r));
    lines.push("");
    return lines.join("\n");
  }

  global.V2Clash = { expandInput, parseLinks, buildConfig, b64Text };
})(window);
