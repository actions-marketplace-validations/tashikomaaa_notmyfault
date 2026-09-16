import { describe, expect, it } from "vitest";
import { decodeEntities, findAll, parseXml } from "../src/xml";

describe("decodeEntities", () => {
  it("decodes named, decimal and hexadecimal entities", () => {
    expect(decodeEntities("a &lt; b &amp;&amp; c &gt; d &quot;&apos;")).toBe(`a < b && c > d "'`);
    expect(decodeEntities("line&#10;break&#xA;tab&#x9;")).toBe("line\nbreak\ntab\t");
    expect(decodeEntities("emoji &#x1F600;")).toBe("emoji 😀");
  });

  it("leaves unknown or invalid entities untouched", () => {
    expect(decodeEntities("&nbsp; &#xFFFFFFFF; & alone")).toBe("&nbsp; &#xFFFFFFFF; & alone");
  });
});

describe("parseXml", () => {
  it("builds a tree with attributes, text and self-closing tags", () => {
    const doc = parseXml(`<?xml version="1.0"?><a x="1" y='two'><b/><c>hi &amp; bye</c></a>`);
    const a = doc.children[0]!;
    expect(a.name).toBe("a");
    expect(a.attrs).toEqual({ x: "1", y: "two" });
    expect(a.children.map((c) => c.name)).toEqual(["b", "c"]);
    expect(a.children[1]!.text).toBe("hi & bye");
  });

  it("keeps CDATA verbatim and skips comments, DOCTYPE and a BOM", () => {
    const doc = parseXml(
      `﻿<!DOCTYPE r [<!ENTITY e "x">]><!-- <fake/> --><r><![CDATA[<not a tag> &amp;]]></r>`,
    );
    expect(doc.children).toHaveLength(1);
    expect(doc.children[0]!.text).toBe("<not a tag> &amp;");
  });

  it("handles '>' inside attribute values and whitespace around '='", () => {
    const doc = parseXml(`<t message = "a > b" other='x/>y' />`);
    expect(doc.children[0]!.attrs).toEqual({ message: "a > b", other: "x/>y" });
  });

  it("tolerates unclosed and mismatched tags", () => {
    const doc = parseXml(`<suite><case name="a"><case name="b"></suite></oops><suite name="2"/>`);
    expect(findAll(doc, "case").map((c) => c.attrs.name)).toEqual(["a", "b"]);
    expect(findAll(doc, "suite")).toHaveLength(2);
  });

  it("does not hang on truncated input", () => {
    expect(() => parseXml(`<a b="unterminated`)).not.toThrow();
    expect(() => parseXml(`<a><![CDATA[never closed`)).not.toThrow();
    expect(() => parseXml(`<!-- never closed`)).not.toThrow();
    expect(() => parseXml(`<a / b="1">`)).not.toThrow();
  });
});
