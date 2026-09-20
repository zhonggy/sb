/**
 * Cookie 导入解析器：支持三种常见来源，自动识别
 *   1. 浏览器 DevTools 复制的 Cookie 请求头（推荐，含 httpOnly 会话 Cookie）
 *      形如: sb_session=xxxx; other=yyyy; ...
 *   2. Cookie 编辑器扩展导出的 JSON（EditThisCookie / Cookie-Editor）
 *      形如: [{"name":"a","value":"b","domain":".studentbeans.com",...}] 或 {"cookies":[...]}
 *   3. Netscape cookies.txt 文件内容
 *
 * 统一归一化为 Playwright addCookies 需要的结构:
 *   { name, value, domain, path, secure, httpOnly, expires? }
 */

const STUDENTBEANS_DOMAIN = '.studentbeans.com';

function normalizeArray(arr, warnings) {
  const out = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const name = (c.name || '').toString().trim();
    let value = c.value;
    if (value == null) continue;
    value = value.toString();
    if (!name) continue;
    const domain = (c.domain || c.hostKey || c.host || '').toString().trim();
    const item = {
      name,
      value,
      domain: domain || STUDENTBEANS_DOMAIN,
      path: (c.path || '/').toString(),
      secure: c.secure !== undefined ? !!c.secure : true,
      httpOnly: !!(c.httpOnly || c.httpOnly === 'TRUE'),
    };
    // 过期时间：expirationDate(秒, Cookie-Editor) / expires(秒或日期字符串, Playwright 导出)
    const exp = c.expirationDate != null ? c.expirationDate : c.expires;
    if (exp != null) {
      const n = typeof exp === 'number' ? exp : (Number(exp) || Date.parse(exp) / 1000);
      if (Number.isFinite(n) && n > 0) item.expires = n;
    }
    out.push(item);
  }
  return out;
}

/** 解析 "a=b; c=d" 形式的请求头字符串 */
function parseHeaderString(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    for (const part of l.split(';')) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      const name = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();
      if (!name) continue;
      out.push({ name, value, domain: STUDENTBEANS_DOMAIN, path: '/', secure: true, httpOnly: false });
    }
  }
  return out;
}

/** 解析 Netscape cookies.txt */
function parseNetscape(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.replace(/^#HttpOnly_/, '').trim();
    if (!l || l.startsWith('#')) continue;
    const parts = l.split('\t');
    if (parts.length < 7) continue;
    const [domain, , path, secure, , name, value] = parts;
    if (!name) continue;
    out.push({
      name: name.trim(),
      value: (value || '').trim(),
      domain: domain.trim() || STUDENTBEANS_DOMAIN,
      path: (path || '/').trim(),
      secure: /TRUE/i.test(secure || ''),
      httpOnly: /^#HttpOnly_/i.test(line),
    });
  }
  return out;
}

function looksLikeNetscape(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return false;
  return lines.every(l => l.split('\t').length >= 7 && /^(TRUE|FALSE)\t/i.test(l.split('\t')[1] + '\t'));
}

/** 主入口：input 可以是 string / array / {cookies:[...]} */
function parseCookies(input) {
  const warnings = [];
  let cookies = [];
  let format = 'unknown';

  if (input == null || (typeof input === 'string' && !input.trim())) {
    return { cookies: [], format: 'unknown', warnings: ['输入为空'], names: [], count: 0, sessionLikeCount: 0, sessionLikeNames: [] };
  }

  if (typeof input === 'string') {
    const text = input.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cookies) ? parsed.cookies : null);
        if (arr) {
          format = 'json';
          cookies = normalizeArray(arr, warnings);
        } else {
          warnings.push('JSON 中未找到 cookies 数组');
        }
      } catch (e) {
        warnings.push('JSON 解析失败：' + e.message);
      }
    }
    if (!cookies.length && looksLikeNetscape(text)) {
      format = 'netscape';
      cookies = parseNetscape(text);
    }
    if (!cookies.length && /[^=;\s]+=[^;]/.test(text)) {
      format = 'header';
      cookies = parseHeaderString(text);
    }
    if (!cookies.length) {
      warnings.push('无法识别格式。支持：① DevTools 复制的 Cookie 请求头 ② Cookie 编辑器导出的 JSON ③ cookies.txt 内容');
    }
  } else if (Array.isArray(input)) {
    format = 'json';
    cookies = normalizeArray(input, warnings);
  } else if (typeof input === 'object' && Array.isArray(input.cookies)) {
    format = 'json';
    cookies = normalizeArray(input.cookies, warnings);
  } else {
    warnings.push('不支持的输入类型');
  }

  // 过滤无效项 + 补默认值
  cookies = cookies.filter(c => c && c.name && c.value != null && c.value !== '');
  for (const c of cookies) {
    if (!c.domain && !c.url) c.domain = STUDENTBEANS_DOMAIN;
    if (!c.path) c.path = '/';
  }

  // 域名检查
  const foreign = cookies.filter(c => c.domain && !/studentbeans\.com$/.test(c.domain.replace(/^\./, '')));
  if (foreign.length) {
    warnings.push(`有 ${foreign.length} 条 Cookie 不属于 studentbeans.com（已保留，但可能无用）`);
  }

  // 会话特征提示
  const sessionLike = cookies.filter(c => /session|auth|token|jwt|login|sb_|sbsession|remember/i.test(c.name));
  const names = cookies.map(c => c.name);

  return {
    cookies,
    format,
    warnings,
    names,
    count: cookies.length,
    sessionLikeCount: sessionLike.length,
    sessionLikeNames: sessionLike.map(c => c.name).slice(0, 10),
  };
}

module.exports = { parseCookies, STUDENTBEANS_DOMAIN };
