import { describe, it, expect } from "vitest";
import { parseTicketQuery } from "./ticket-query";

/**
 * Search matched work items on TITLE only. The ticket number was selected and
 * displayed — results read "TEST-123" — but never searched, so the one
 * identifier people actually quote to each other found nothing.
 */

describe("parseTicketQuery", () => {
  it("reads a bare number as a ticket number", () => {
    expect(parseTicketQuery("123")).toEqual({ ticketNumber: 123 });
  });

  it("reads the KEY-123 form people paste", () => {
    expect(parseTicketQuery("TEST-123")).toEqual({
      projectKey: "TEST",
      ticketNumber: 123,
    });
  });

  it("is case-insensitive about the project key", () => {
    expect(parseTicketQuery("test-123")).toEqual({
      projectKey: "TEST",
      ticketNumber: 123,
    });
  });

  it("accepts a leading # and surrounding whitespace", () => {
    expect(parseTicketQuery("  #123 ")).toEqual({ ticketNumber: 123 });
  });

  it("returns nothing for ordinary words, so title search is unaffected", () => {
    expect(parseTicketQuery("login bug")).toEqual({});
    expect(parseTicketQuery("")).toEqual({});
  });

  it("ignores a number embedded in a word", () => {
    // "v2" and "sprint1" are title text, not ticket references. Treating them as
    // ticket numbers would surface an unrelated item above the real match.
    expect(parseTicketQuery("v2")).toEqual({});
    expect(parseTicketQuery("sprint1")).toEqual({});
  });

  it("ignores a number too large to be a ticket", () => {
    // Postgres INT overflow throws at the query layer rather than returning
    // nothing, so a pasted timestamp must not reach it.
    expect(parseTicketQuery("99999999999")).toEqual({});
  });

  it("ignores zero and negatives", () => {
    expect(parseTicketQuery("0")).toEqual({});
    expect(parseTicketQuery("-5")).toEqual({});
  });
});
