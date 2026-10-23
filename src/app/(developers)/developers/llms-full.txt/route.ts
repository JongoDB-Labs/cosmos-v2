import { llmsText } from "@/lib/developers/llms";

export function GET() {
  return new Response(llmsText(true), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
