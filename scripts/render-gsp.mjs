#!/usr/bin/env node
// Renders the POST <form> of a spatial-service GSP view (views/manageLayers/*.gsp) with a given model,
// so test fixtures are produced from the real ALA templates instead of being written by hand.
// Supports only what those views use: ${expr}, <g:if test="${expr}">, <g:set>, <g:each in="${list}" var="x">,
// with a tiny expression language (identifiers, 'strings', "strings", numbers, null, ! == != && || ?:).
//
//   node scripts/render-gsp.mjs <file.gsp> '<model json>' > out.html
import { readFileSync } from "node:fs";

export function renderGspForm(gsp, model) {
  const start = gsp.indexOf('<form method="POST">');
  const end = gsp.indexOf("</form>", start);
  if (start < 0 || end < 0) throw new Error("no POST form in template");
  let src = gsp.slice(start, end + "</form>".length);

  src = src.replace(/<g:set[^>]*\/>/g, "");
  src = src.replace(/<g:each in="\$\{([^}]*)\}" var="(\w+)">([\s\S]*?)<\/g:each>/g, (_, list, v, body) =>
    (evaluate(list, model) ?? []).map((item) => render(body, { ...model, [v]: item })).join(""),
  );
  return render(src, model);
}

function render(s, vars) {
  const re = /<g:if\s+test="\$\{([^}]*)\}"\s*>((?:(?!<g:if)[\s\S])*?)<\/g:if>/; // innermost first
  for (let m = s.match(re); m; m = s.match(re)) s = s.slice(0, m.index) + (evaluate(m[1], vars) ? m[2] : "") + s.slice(m.index + m[0].length);
  return s.replace(/\$\{([^}]*)\}/g, (_, e) => {
    const v = evaluate(e, vars);
    return v == null ? "" : String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  });
}

export function evaluate(expr, vars) {
  const toks = expr.match(/\s*('[^']*'|"[^"]*"|\d+(?:\.\d+)?|[A-Za-z_]\w*|==|!=|&&|\|\||[!?:()])/g)?.map((t) => t.trim()) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const ternary = () => {
    const c = or();
    if (peek() !== "?") return c;
    next();
    const a = ternary();
    if (next() !== ":") throw new Error(`bad ternary in ${expr}`);
    const b = ternary();
    return c ? a : b;
  };
  const or = () => { let v = and(); while (peek() === "||") { next(); const r = and(); v = v || r; } return v; };
  const and = () => { let v = eq(); while (peek() === "&&") { next(); const r = eq(); v = v && r; } return v; };
  const eq = () => {
    let v = unary();
    while (peek() === "==" || peek() === "!=") {
      const op = next();
      const r = unary();
      // Groovy == compares loosely (1 == "1")
      v = op === "==" ? (v == null || r == null ? v == r : String(v) === String(r)) : (v == null || r == null ? v != r : String(v) !== String(r));
    }
    return v;
  };
  const unary = () => (peek() === "!" ? (next(), !unary()) : atom());
  const atom = () => {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end of ${expr}`);
    if (t === "(") { const v = ternary(); next(); return v; }
    if (/^['"]/.test(t)) return t.slice(1, -1);
    if (/^\d/.test(t)) return Number(t);
    if (t === "null") return null;
    if (t === "true" || t === "false") return t === "true";
    return Object.hasOwn(vars, t) ? vars[t] : null;
  };
  const v = ternary();
  if (i !== toks.length) throw new Error(`unsupported expression: ${expr}`);
  return v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, json] = process.argv.slice(2);
  process.stdout.write(renderGspForm(readFileSync(file, "utf8"), JSON.parse(json ?? "{}")) + "\n");
}
