import { describe, expect, it } from "vitest";

import { AnnotationSet, normalizeAnnotationText } from "../src/annotations.js";

describe("annotations", () => {
  it("places an anchor, waits for text, and stores the note in order", () => {
    const notes = new AnnotationSet();
    expect(notes.state()).toEqual({ kind: "idle" });
    expect(notes.active()).toBe(false);

    notes.arm();
    expect(notes.state()).toEqual({ kind: "armed" });
    expect(notes.place([1, 2, 3])).toEqual({ kind: "pending", position: [1, 2, 3] });
    expect(notes.commit("  Check   this\nbeam ")).toBe(0);
    expect(notes.list()).toEqual([{ position: [1, 2, 3], text: "Check this beam" }]);
    expect(notes.selected()).toBe(0);
    expect(notes.active()).toBe(false);

    notes.arm();
    notes.place([4, 5, 6]);
    expect(notes.commit("Second")).toBe(1);
    expect(notes.list().map((note) => note.text)).toEqual(["Check this beam", "Second"]);
  });

  it("discards a blank note and a cancelled anchor without touching stored notes", () => {
    const notes = new AnnotationSet();
    notes.arm();
    notes.place([0, 0, 0]);
    expect(notes.commit("Kept")).toBe(0);

    notes.arm();
    notes.place([1, 1, 1]);
    expect(notes.commit("   ")).toBeUndefined();
    expect(notes.state()).toEqual({ kind: "idle" });

    notes.toggle();
    notes.place([2, 2, 2]);
    notes.toggle();
    expect(notes.state()).toEqual({ kind: "idle" });
    expect(notes.commit("late")).toBeUndefined();
    expect(notes.list()).toHaveLength(1);
  });

  it("selects by index and removes only the selected note", () => {
    const notes = new AnnotationSet();
    notes.restore([
      { position: [0, 0, 0], text: "a" },
      { position: [1, 0, 0], text: "b" },
      { position: [2, 0, 0], text: "c" },
    ]);
    expect(notes.selected()).toBeUndefined();
    expect(notes.removeSelected()).toBe(false);

    notes.select(1);
    expect(notes.removeSelected()).toBe(true);
    expect(notes.list().map((note) => note.text)).toEqual(["a", "c"]);
    expect(notes.selected()).toBeUndefined();

    notes.select(7);
    expect(notes.selected()).toBeUndefined();
    notes.select(-1);
    expect(notes.selected()).toBeUndefined();
  });

  it("refuses a non-finite anchor on place and on restore", () => {
    const notes = new AnnotationSet();
    notes.arm();
    expect(() => notes.place([1, Number.NaN, 3])).toThrow(RangeError);
    expect(() =>
      notes.restore([{ position: [Number.POSITIVE_INFINITY, 0, 0], text: "x" }]),
    ).toThrow(RangeError);
  });

  it("normalizes note text to single spaces", () => {
    expect(normalizeAnnotationText("\t a \r\n b  ")).toBe("a b");
    expect(normalizeAnnotationText("   ")).toBe("");
  });
});
