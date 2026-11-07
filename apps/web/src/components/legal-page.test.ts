import { describe, expect, it } from "vitest";

import messages from "../../messages/uk.json";

describe("тексти юридичних сторінок", () => {
  it.each(["terms", "privacy", "howItWorks"] as const)("%s: заголовок, вступ і розділи", (page) => {
    const legal = messages.legal[page];
    expect(legal.title).not.toBe("");
    expect(legal.intro).not.toBe("");
    expect(legal.sections.length).toBeGreaterThan(2);
    const headings = legal.sections.map((s) => s.h);
    expect(new Set(headings).size).toBe(headings.length); // h — React key
    for (const section of legal.sections) expect(section.p.length).toBeGreaterThan(0);
  });

  it("у футері є посилання на кожну сторінку", () => {
    expect(Object.keys(messages.footer.links).sort()).toEqual(["howItWorks", "privacy", "terms"]);
  });
});
