import { describe, expect, it } from "vitest";
import {
  getAttributeValues,
  getElementContent,
  getElementTexts,
} from "../../../../../src/lib/wizard/apple/snapshots/xml-scan.js";

const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction>
      <BuildActionEntries>
         <BuildActionEntry>
            <BuildableReference BlueprintName = "App" />
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug">
      <!-- <BuildableReference BlueprintName = "Commented" /> -->
      <Testables>
         <TestableReference skipped = "NO">
            <BuildableReference BlueprintName = "AppTests" />
         </TestableReference>
         <TestableReference skipped = "NO">
            <BuildableReference BlueprintName = 'App &amp; UITests' />
         </TestableReference>
      </Testables>
   </TestAction>
</Scheme>
`;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>SchemeUserState</key>
	<dict>
		<key>App.xcscheme_^#shared#^_</key>
		<dict>
			<key>orderHint</key>
			<integer>0</integer>
		</dict>
		<key>Snap &lt;Shots&gt;.xcscheme</key>
	</dict>
</dict>
</plist>
`;

describe("xml-scan", () => {
  describe("getElementContent", () => {
    it("returns the markup inside the first matching element", () => {
      const testAction = getElementContent(scheme, "TestAction");
      expect(testAction).toContain('BlueprintName = "AppTests"');
      expect(testAction).not.toContain('BlueprintName = "App" ');
    });

    it("returns an empty string for a self-closing element", () => {
      expect(
        getElementContent("<Scheme><TestAction /></Scheme>", "TestAction"),
      ).toBe("");
    });

    it("returns undefined when the element is missing", () => {
      expect(
        getElementContent("<Scheme></Scheme>", "TestAction"),
      ).toBeUndefined();
    });

    it("does not match an element whose name only starts with the name", () => {
      expect(
        getElementContent("<TestActionX>a</TestActionX>", "TestAction"),
      ).toBeUndefined();
    });
  });

  describe("getAttributeValues", () => {
    it("reads quoted values, skipping comments", () => {
      const testAction = getElementContent(scheme, "TestAction") ?? "";
      expect(getAttributeValues(testAction, "BlueprintName")).toEqual([
        "AppTests",
        "App & UITests",
      ]);
    });

    it("skips a comment that only forms once an inner comment is removed", () => {
      const xml =
        '<<!-- x -->!-- <Ref BlueprintName="Hidden"/> --><Ref BlueprintName="Shown"/>';
      expect(getAttributeValues(xml, "BlueprintName")).toEqual(["Shown"]);
    });
  });

  describe("getElementTexts", () => {
    it("returns the text of every matching element, decoded", () => {
      expect(getElementTexts(plist, "key")).toEqual([
        "SchemeUserState",
        "App.xcscheme_^#shared#^_",
        "orderHint",
        "Snap <Shots>.xcscheme",
      ]);
    });
  });
});
