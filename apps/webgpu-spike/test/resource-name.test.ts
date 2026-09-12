import { describe, expect, it } from "vitest";

import { resourceFileName } from "../src/resource-name.js";

describe("resourceFileName", () => {
  it("resolves resource file names from relative package URIs", () => {
    expect(resourceFileName("properties.json")).toBe("properties.json");
    expect(resourceFileName("data/properties.bin")).toBe("properties.bin");
    expect(resourceFileName("value%20columns.bin")).toBe("value columns.bin");
  });
});
