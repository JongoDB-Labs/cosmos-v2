import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ForbiddenError, NotFoundError } from "./rbac/check";
import { serverReportError } from "./telemetry/server";

export function success<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function created<T>(data: T) {
  return NextResponse.json(data, { status: 201 });
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function handleApiError(error: unknown) {
  if (error instanceof ForbiddenError) {
    return NextResponse.json(
      { error: error.message },
      { status: 403 }
    );
  }
  if (error instanceof NotFoundError) {
    return NextResponse.json(
      { error: error.message },
      { status: 404 }
    );
  }
  if (error instanceof ZodError) {
    // Input-validation failures are client errors, not server errors —
    // returning 500 here masked real bugs (and confused clients) for every
    // route that did `schema.parse(body)` inside a try/catch.
    return NextResponse.json(
      { error: "Invalid request", issues: error.issues },
      { status: 400 }
    );
  }
  console.error("[api:500]", error);
  serverReportError(error, { scope: "api" });
  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export function getIpAddress(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    undefined
  );
}
