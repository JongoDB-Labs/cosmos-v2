import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { sumMoney, multiplyMoney, roundMoney, moneyToNumber } from "./index";

describe("money util", () => {
  it("sums exactly with no float drift (0.10 + 0.20 === 0.3, not 0.30000000000000004)", () => {
    expect(sumMoney([new Prisma.Decimal("0.10"), new Prisma.Decimal("0.20")]).toString()).toBe("0.3");
  });
  it("skips null/undefined", () => {
    expect(sumMoney([new Prisma.Decimal("100.00"), null, undefined, new Prisma.Decimal("50.50")]).toString()).toBe("150.5");
  });
  it("multiplies money by a plain quantity exactly (rate × hours)", () => {
    expect(multiplyMoney(new Prisma.Decimal("19.99"), 3).toString()).toBe("59.97");
  });
  it("multiply treats null as zero", () => {
    expect(multiplyMoney(null, 5).toString()).toBe("0");
  });
  it("sums an empty array to 0", () => {
    expect(sumMoney([]).toString()).toBe("0");
  });
  it("multiply treats undefined as zero too", () => {
    expect(multiplyMoney(undefined, 5).toString()).toBe("0");
  });
  it("rounds half-even (banker's) to 2dp", () => {
    expect(roundMoney(new Prisma.Decimal("2.345")).toString()).toBe("2.34"); // 4 is even → stays
    expect(roundMoney(new Prisma.Decimal("2.355")).toString()).toBe("2.36"); // 5 is odd → rounds up
  });
  it("converts to a JS number for display", () => {
    expect(moneyToNumber(new Prisma.Decimal("1234.56"))).toBe(1234.56);
  });
});
