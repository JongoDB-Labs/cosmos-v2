import { RuntimeBrandMarker } from "@/components/brand/runtime-brand-marker";
import { LoginForm } from "./login-form";

// A server wrapper so the page can carry RuntimeBrandMarker; the form itself
// is a client component. See runtime-brand-marker.tsx for why the marker has
// to live on the page rather than in a layout.
export default function LoginPage() {
  return (
    <>
      <LoginForm />
      <RuntimeBrandMarker />
    </>
  );
}
