import { describe, expect, it, vi } from "vitest";

import { DisposalBag } from "../../src/engine/DisposalBag";

describe("DisposalBag", () => {
  it("releases every registered resource in reverse registration order", () => {
    const order: string[] = [];
    const bag = new DisposalBag();
    bag.addFn(() => order.push("first"));
    bag.addFn(() => order.push("second"));
    bag.addFn(() => order.push("third"));

    expect(bag.size).toBe(3);
    bag.dispose();

    expect(order).toEqual(["third", "second", "first"]);
    expect(bag.size).toBe(0);
  });

  it("returns the resource it registered so call sites can keep the handle", () => {
    const bag = new DisposalBag();
    const resource = { dispose: vi.fn() };

    expect(bag.add(resource)).toBe(resource);
  });

  it("releases the remaining resources when one throws, then reports the failures", () => {
    const released: string[] = [];
    const bag = new DisposalBag();
    bag.addFn(() => released.push("outer"));
    bag.addFn(() => {
      throw new Error("texture already destroyed");
    });
    bag.addFn(() => {
      throw new Error("buffer already destroyed");
    });
    bag.addFn(() => released.push("inner"));

    let thrown: unknown;
    try {
      bag.dispose();
    } catch (error) {
      thrown = error;
    }

    expect(released).toEqual(["inner", "outer"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    const failures = (thrown as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect((failures[0] as Error).message).toBe("buffer already destroyed");
    expect((failures[1] as Error).message).toBe("texture already destroyed");
  });

  it("refuses a registration once it has been disposed", () => {
    const bag = new DisposalBag();
    bag.dispose();

    expect(() => bag.add({ dispose: vi.fn() })).toThrow(/already disposed/);
  });

  it("ignores a second dispose rather than releasing anything twice", () => {
    const release = vi.fn();
    const bag = new DisposalBag();
    bag.addFn(release);

    bag.dispose();
    bag.dispose();

    expect(release).toHaveBeenCalledTimes(1);
  });
});
