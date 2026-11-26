import { describe, expect, it } from "vitest";
import {
  childElements,
  parseXml,
} from "../../../../src/lib/wizard/android/xml.js";

describe("parseXml", () => {
  it("parses nested elements and their attributes", () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package='com.example'>
  <application android:label="@string/app_name">
    <activity android:name=".MainActivity" android:exported = "true" />
  </application>
</manifest>`,
    );

    expect(root).toEqual({
      name: "manifest",
      attributes: {
        "xmlns:android": "http://schemas.android.com/apk/res/android",
        package: "com.example",
      },
      children: [
        {
          name: "application",
          attributes: { "android:label": "@string/app_name" },
          children: [
            {
              name: "activity",
              attributes: {
                "android:name": ".MainActivity",
                "android:exported": "true",
              },
              children: [],
            },
          ],
        },
      ],
    });
  });

  it("skips comments, CDATA, doctypes, and text, even when they look like tags", () => {
    const root = parseXml(`<!DOCTYPE manifest>
<!-- <activity android:name=".Commented" /> -->
<manifest>
  some text
  <![CDATA[ <activity android:name=".InCdata" /> ]]>
  <application>
    <!-- </application> -->
  </application>
</manifest>`);

    expect(root.name).toBe("manifest");
    expect(root.children.map((child) => child.name)).toEqual(["application"]);
    expect(root.children[0]?.children).toEqual([]);
  });

  it("decodes character references in attribute values", () => {
    const root = parseXml(
      `<a value="x &amp; y &lt;z&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42;" />`,
    );

    expect(root.attributes["value"]).toBe(`x & y <z> "q" 's' AB`);
  });

  it("allows `>` inside attribute values and multi-line tags", () => {
    const root = parseXml(`<a
  first="1 > 0"
  second='2'
/>`);

    expect(root.attributes).toEqual({ first: "1 > 0", second: "2" });
  });

  it.each([
    ["an unclosed element", "<manifest><application></manifest>"],
    ["a closing tag without an opening tag", "<manifest></application>"],
    ["an element that is never closed", "<manifest>"],
    ["two root elements", "<a /><b />"],
    ["no root element", "<!-- empty -->"],
    ["an unterminated comment", "<manifest><!-- </manifest>"],
    ["a broken tag", "<manifest attr=unquoted></manifest>"],
  ])("throws on %s", (_label, xml) => {
    expect(() => parseXml(xml)).toThrow(/Malformed XML/);
  });
});

describe("childElements", () => {
  it("returns only direct children with the given name", () => {
    const root = parseXml(
      `<a><b id="1"><b id="nested" /></b><c /><b id="2" /></a>`,
    );

    expect(childElements(root, "b").map((b) => b.attributes["id"])).toEqual([
      "1",
      "2",
    ]);
  });

  it("returns nothing for a missing element", () => {
    expect(childElements(undefined, "b")).toEqual([]);
  });
});
