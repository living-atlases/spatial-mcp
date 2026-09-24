import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildSubmission, FormContractError, parseForm, signature } from "../src/form-contract.ts";

const ref = (f: string) => readFileSync(new URL(`../reference/3.1.0/${f}`, import.meta.url), "utf8");

test("parses the 3.1.0 layer form rendered from the real GSP", () => {
  const f = parseForm(ref("layer-new.html"));
  const byName = Object.fromEntries(f.map((x) => [x.name, x]));
  assert.equal(byName["name"]!.maxlength, 150);
  assert.equal(byName["requestedId"]!.maxlength, 15);
  assert.equal(byName["scale"]!.maxlength, 20);
  assert.deepEqual(byName["type"]!.options, ["Contextual", "Environmental"]);
  assert.deepEqual(byName["domain"]!.options, ["Terrestrial", "Marine", "Terrestrial,Marine"]);
  assert.deepEqual(byName["licence_level"]!.options, ["1", "2", "3"]);
  assert.equal(byName["enabled"]!.kind, "checkbox");
  assert.equal(byName["enabled"]!.value, "on");
  assert.equal(byName["environmentalvaluemin"]!.readonly, true);
  assert.equal(byName["name"]!.readonly, false);
  assert.ok(!f.some((x) => x.name === "classificationList"), "the helper <select> without a name is not a form field");
});

test("an existing layer has name, type and domain read-only", () => {
  const f = parseForm(ref("layer-existing.html"));
  for (const n of ["name", "type", "domain", "environmentalvalueunits"]) assert.equal(f.find((x) => x.name === n)!.readonly, true, n);
  assert.throws(() => buildSubmission(f, { type: "Environmental" }), /read-only/);
  assert.throws(() => buildSubmission(f, { name: "other" }), /read-only/);
  // sending the same value is fine
  assert.doesNotThrow(() => buildSubmission(f, { name: "mcp_poc_regions", displayname: "New name" }));
});

test("builds exactly what the browser would post, with the form's defaults", () => {
  const f = parseForm(ref("layer-new.html"));
  const s = buildSubmission(f, { displayname: "Regiones", classification1: "Area Management", licence_level: "2" });
  const body = Object.fromEntries(s.body);
  assert.equal(body["displayname"], "Regiones");
  assert.equal(body["licence_level"], "2");
  assert.equal(body["type"], "Contextual");
  assert.equal(body["enabled"], "on");
  assert.equal(body["id"], "1790000000000");
  assert.deepEqual(Object.keys(s.changes).sort(), ["classification1", "displayname", "licence_level"]);
});

test("unchecked checkboxes are omitted, like a browser does", () => {
  const f = parseForm(ref("layer-new.html"));
  const s = buildSubmission(f, { enabled: false });
  assert.ok(!s.body.some(([k]) => k === "enabled"));
});

test("fails closed: unknown fields, too long values, options outside the select", () => {
  const f = parseForm(ref("layer-new.html"));
  const err = (() => {
    try {
      buildSubmission(f, { bogus: "x", displayname: "x".repeat(151), domain: "Space", requestedId: "1234567890123456" });
    } catch (e) {
      return e as FormContractError;
    }
  })();
  assert.ok(err instanceof FormContractError);
  assert.equal(err.problems.length, 4);
  assert.match(err.message, /"bogus" is not a field of the form/);
  assert.match(err.message, /at most 150/);
  assert.match(err.message, /"domain" must be one of/);
  assert.match(err.message, /at most 15/);
});

test("field form: sname must be one of the DBF columns of the upload", () => {
  const f = parseForm(ref("field-new.html"));
  assert.deepEqual(f.find((x) => x.name === "sname")!.options, ["", "NAME", "CODE"]);
  assert.doesNotThrow(() => buildSubmission(f, { sname: "NAME" }));
  assert.throws(() => buildSubmission(f, { sname: "POPULATION" }), /must be one of/);
});

test("signature ignores data-driven options but catches structural drift", () => {
  const a = signature(parseForm(ref("field-new.html")));
  const other = ref("field-new.html").replace(/<option value="CODE"[\s\S]*?<\/option>/, "");
  assert.deepEqual(signature(parseForm(other)), a);
  const renamed = ref("layer-new.html").replace('name="displayname"', 'name="display_name"');
  assert.notDeepEqual(signature(parseForm(renamed)), signature(parseForm(ref("layer-new.html"))));
});

test("a page without a POST form (e.g. the login page) is an error", () => {
  assert.throws(() => parseForm("<html><form method='GET'><input name='q'></form></html>"), /No POST form/);
});
