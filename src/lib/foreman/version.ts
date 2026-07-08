/** SemVer bump for a triaged ticket: features add capability (minor), bugs fix
 *  behavior (patch). `major` is never chosen autonomously. */
export function bumpForClassification(classification: "BUG" | "FEATURE"): "patch" | "minor" {
  return classification === "FEATURE" ? "minor" : "patch";
}
