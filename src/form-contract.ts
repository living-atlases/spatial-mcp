import * as cheerio from "cheerio";

/**
 * The "form contract": what the spatial-service admin UI (views/manageLayers/*.gsp) lets a person send.
 *
 * /manageLayers/* is not part of the documented API (it is the admin UI), and the server does not check
 * the limits the HTML form imposes (maxlength, select options, readonly fields). To avoid creating layers
 * or fields that the UI cannot show or edit afterwards, every write reads the live form first and only
 * sends what the form itself could have sent, with the form's own defaults for everything else.
 */
export type FieldKind = "text" | "textarea" | "select" | "checkbox" | "hidden";

export interface FormField {
  name: string;
  kind: FieldKind;
  /** Prefilled value (for checkboxes: "on" when checked, "" otherwise). */
  value: string;
  maxlength?: number;
  /** Allowed values of a <select>. */
  options?: string[];
  readonly: boolean;
}

export type FormValue = string | number | boolean | null | undefined;

export interface Submission {
  /** Exactly the pairs a browser would post for this form. */
  body: Array<[string, string]>;
  /** Fields whose value differs from the prefilled form. */
  changes: Record<string, { from: string; to: string }>;
}

export class FormContractError extends Error {
  constructor(readonly problems: string[]) {
    super(`Refused by the form contract (the admin UI could not send this):\n- ${problems.join("\n- ")}`);
  }
}

/** Parse the first POST form of an admin page. Throws if the page has no such form (e.g. a login page). */
export function parseForm(html: string): FormField[] {
  const $ = cheerio.load(html);
  const form = $("form")
    .filter((_, f) => ($(f).attr("method") ?? "").toUpperCase() === "POST")
    .first();
  if (form.length === 0) throw new Error("No POST form found in the admin page (not logged in as admin, or the page changed).");
  const fields: FormField[] = [];
  form.find("input[name], select[name], textarea[name]").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name")!;
    const tag = el.tagName.toLowerCase();
    const type = ($el.attr("type") ?? "text").toLowerCase();
    if (tag === "input" && (type === "submit" || type === "button")) return;
    const maxlength = $el.attr("maxlength") ? Number($el.attr("maxlength")) : undefined;
    const readonly = $el.attr("readonly") !== undefined || type === "readonly";
    let f: FormField;
    if (tag === "select") {
      const options = $el.find("option").map((_, o) => $(o).attr("value") ?? $(o).text().trim()).get();
      const selected = $el.find("option[selected]").first();
      const value = selected.length ? (selected.attr("value") ?? selected.text().trim()) : (options[0] ?? "");
      f = { name, kind: "select", value, options, readonly };
    } else if (tag === "textarea") {
      f = { name, kind: "textarea", value: $el.text(), readonly };
    } else if (type === "checkbox") {
      f = { name, kind: "checkbox", value: $el.attr("checked") !== undefined ? "on" : "", readonly };
    } else {
      f = { name, kind: type === "hidden" ? "hidden" : "text", value: $el.attr("value") ?? "", readonly };
    }
    if (maxlength !== undefined && Number.isFinite(maxlength)) f.maxlength = maxlength;
    fields.push(f);
  });
  return fields;
}

/**
 * Validate `input` against the form and build the body a browser would post.
 * Fail closed: any key the form does not have, any readonly change, any value too long or not among the
 * options is an error, and nothing is sent.
 */
export function buildSubmission(fields: FormField[], input: Record<string, FormValue>): Submission {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) continue;
    if (!byName.has(key)) problems.push(`"${key}" is not a field of the form (form fields: ${fields.map((f) => f.name).join(", ")})`);
  }
  const body: Array<[string, string]> = [];
  const changes: Submission["changes"] = {};
  for (const f of fields) {
    const given = input[f.name];
    let value = f.value;
    if (given !== undefined && given !== null) {
      value = f.kind === "checkbox" ? (given === true || given === "on" || given === "true" ? "on" : "") : String(given);
      if (value !== f.value) {
        if (f.readonly) problems.push(`"${f.name}" is read-only in the admin UI (current value "${f.value}") and cannot be changed`);
        if (f.maxlength !== undefined && value.length > f.maxlength) problems.push(`"${f.name}" is ${value.length} characters; the form allows at most ${f.maxlength}`);
        if (f.kind === "select" && !f.options!.includes(value)) problems.push(`"${f.name}" must be one of: ${f.options!.map((o) => JSON.stringify(o)).join(", ")}`);
        changes[f.name] = { from: f.value, to: value };
      }
    }
    // Browsers omit unchecked checkboxes.
    if (f.kind === "checkbox" && value !== "on") continue;
    body.push([f.name, value]);
  }
  if (problems.length) throw new FormContractError(problems);
  return { body, changes };
}

/**
 * Stable description of a form's shape, used to detect drift between the spatial-service version the
 * POC was written against and the one it talks to. Option lists filled from data (DBF columns) are
 * left out on purpose.
 */
export function signature(fields: FormField[], dynamicOptions: string[] = ["sname", "sdesc"]): string[] {
  return fields
    .map((f) => {
      const opts = f.kind === "select" && !dynamicOptions.includes(f.name) ? `[${f.options!.join("|")}]` : "";
      return `${f.name}:${f.kind}${f.maxlength !== undefined ? `:max${f.maxlength}` : ""}${f.readonly ? ":ro" : ""}${opts}`;
    })
    .sort();
}
