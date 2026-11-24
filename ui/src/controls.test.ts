// A page's controls kept in its file: only the attribute or text that says what a control shows changes.

import { expect, test } from "bun:test";
import { type Control, readMessage, setControls } from "./controls";

test("a box ticked or cleared changes only its own checked attribute", () => {
  const page = `<ul>\n  <li><input type="checkbox" id="a"> one</li>\n  <li><input id=b type=checkbox checked/> two</li>\n</ul>`;
  const done = setControls(page, [
    { id: "a", checked: true },
    { id: "b", checked: false },
  ]);
  expect(done).toBe(`<ul>\n  <li><input type="checkbox" id="a" checked> one</li>\n  <li><input id=b type=checkbox/> two</li>\n</ul>`);
  // Saying again what the file already says changes nothing.
  expect(setControls(done, [{ id: "a", checked: true }])).toBe(done);
});

test("a radio group keeps the one the page picked", () => {
  const page = `<input type=radio name=r id=r1 checked><input type=radio name=r id=r2>`;
  expect(
    setControls(page, [
      { id: "r1", checked: false },
      { id: "r2", checked: true },
    ]),
  ).toBe(`<input type=radio name=r id=r1><input type=radio name=r id=r2 checked>`);
});

test("a section opened or closed changes its open attribute", () => {
  const page = `<details id="s"><summary>More</summary>text</details><details id="t" open></details>`;
  expect(
    setControls(page, [
      { id: "s", open: true },
      { id: "t", open: false },
    ]),
  ).toBe(`<details id="s" open><summary>More</summary>text</details><details id="t"></details>`);
});

test("text typed in a field is kept as its value, escaped", () => {
  expect(setControls(`<input id="n" value="old">`, [{ id: "n", value: 'say "hi" & <go>' }])).toBe(
    `<input id="n" value="say &quot;hi&quot; &amp; <go>">`,
  );
  expect(setControls(`<input id=n type=email>`, [{ id: "n", value: "a@example.com" }])).toBe(`<input id=n type=email value="a@example.com">`);
});

test("a password, a file field or a hidden one is never written", () => {
  for (const type of ["password", "file", "hidden"]) {
    const page = `<input id="p" type="${type}">`;
    expect(setControls(page, [{ id: "p", value: "secret" }])).toBe(page);
  }
});

test("a textarea's text is kept, and cannot close the element it is in", () => {
  const page = `<textarea id="t">\nold</textarea><p>after</p>`;
  const done = setControls(page, [{ id: "t", value: "line one\n</textarea><script>bad()</script>" }]);
  expect(done).toBe(`<textarea id="t">line one\n&lt;/textarea>&lt;script>bad()&lt;/script></textarea><p>after</p>`);
  // Text that starts with a newline keeps it: the parser drops the first one.
  expect(setControls(`<textarea id="t"></textarea>`, [{ id: "t", value: "\nx" }])).toBe(`<textarea id="t">\n\nx</textarea>`);
  // The file's own line endings.
  expect(setControls(`<textarea id="t"></textarea>`, [{ id: "t", value: "a\nb" }], "\r\n")).toBe(`<textarea id="t">a\r\nb</textarea>`);
  // The same text as the file holds, with the dropped newline, changes nothing.
  expect(setControls(page, [{ id: "t", value: "old" }])).toBe(page);
});

test("a select marks the option picked, by its value or its text", () => {
  const page = `<select id="s">\n  <option value="1" selected>One</option>\n  <option value="2">Two</option>\n</select>`;
  expect(setControls(page, [{ id: "s", value: "2" }])).toBe(
    `<select id="s">\n  <option value="1">One</option>\n  <option value="2" selected>Two</option>\n</select>`,
  );
  expect(setControls(`<select id=s><option>A</option><option> B  b </option></select>`, [{ id: "s", value: "B b" }])).toBe(
    `<select id=s><option>A</option><option selected> B  b </option></select>`,
  );
  // A value no option has changes nothing.
  expect(setControls(page, [{ id: "s", value: "9" }])).toBe(page);
});

test("what looks like a control inside a script, a style or a comment is left alone", () => {
  const page = `<!-- <input id="a" type="checkbox"> --><script>const s = '<input id="a" type="checkbox">';</script><input id="a" type="checkbox">`;
  expect(setControls(page, [{ id: "a", checked: true }])).toBe(page.replace(/checkbox">$/, 'checkbox" checked>'));
});

test("an id held by two elements, or by the wrong kind of element, changes nothing", () => {
  const twice = `<input id="a" type="checkbox"><input id="a" type="checkbox">`;
  expect(setControls(twice, [{ id: "a", checked: true }])).toBe(twice);
  const wrong = `<p id="a">text</p><input id="b" type="text">`;
  expect(
    setControls(wrong, [
      { id: "a", checked: true },
      { id: "b", checked: true },
      { id: "missing", open: true },
    ]),
  ).toBe(wrong);
});

test("a control named twice in one message takes the last word", () => {
  expect(
    setControls(`<input id="a" type="checkbox">`, [
      { id: "a", checked: true },
      { id: "a", checked: false },
    ]),
  ).toBe(`<input id="a" type="checkbox">`);
});

test("only a message made right is read", () => {
  const good: Control[] = [
    { id: "a", checked: true },
    { id: "b", value: "x" },
    { id: "c", open: false },
  ];
  expect(readMessage({ type: "okfs:save", controls: good })).toEqual(good);
  expect(readMessage({ type: "okfs:save", v: 1, controls: good })).toEqual(good);
  expect(readMessage({ type: "other", controls: good })).toBeNull();
  expect(readMessage({ type: "okfs:save", controls: [{ id: "a", checked: true, open: true }] })).toBeNull();
  expect(readMessage({ type: "okfs:save", controls: [{ id: "", checked: true }] })).toBeNull();
  expect(readMessage({ type: "okfs:save", controls: [{ id: "a", checked: "yes" }] })).toBeNull();
  expect(readMessage({ type: "okfs:save", controls: [good[0], { id: "b", value: 7 }] })).toBeNull();
  expect(readMessage({ type: "okfs:save", controls: "a" })).toBeNull();
  expect(readMessage("okfs:save")).toBeNull();
  expect(readMessage(null)).toBeNull();
});

test("a message of a later version is not read at all", () => {
  const good: Control[] = [{ id: "a", checked: true }];
  expect(readMessage({ type: "okfs:save", v: 2, controls: good })).toBeNull();
  expect(readMessage({ type: "okfs:save", v: 1.5, controls: good })).toBeNull();
  // Anything that is not a later version reads as this one.
  expect(readMessage({ type: "okfs:save", v: 0, controls: good })).toEqual(good);
  expect(readMessage({ type: "okfs:save", v: "1", controls: good })).toEqual(good);
  expect(readMessage({ type: "okfs:save", v: null, controls: good })).toEqual(good);
});

test("a control of a kind okfs does not know is left out, and the others are kept", () => {
  const good: Control[] = [
    { id: "a", checked: true },
    { id: "b", value: "x" },
  ];
  const unknown = [{ id: "c" }, { id: "d", range: [1, 2] }];
  expect(readMessage({ type: "okfs:save", controls: [good[0], ...unknown, good[1]] })).toEqual(good);
  expect(readMessage({ type: "okfs:save", controls: unknown })).toEqual([]);
});
