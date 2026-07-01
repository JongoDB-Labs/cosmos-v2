import {
  TRANSFORMERS,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";
import { $createMentionNode, $isMentionNode, MentionNode } from "./mention-node";
import {
  buildToken,
  ENTITY_LABEL,
  isEntityType,
  refKey,
  type EntityType,
} from "@/lib/mentions/refs";

/**
 * Markdown round-trip config for the notes editor.
 *
 * Stored content stays plain markdown (no storage change) so search, RAG
 * embeddings, and the person-mention fan-out keep working. On top of Lexical's
 * default TRANSFORMERS we add one text-match transformer that round-trips the
 * app's entity tokens: `<@uuid>` (person, back-compat) and `<@type:id>` (any
 * entity). `labels` maps `refKey(type,id)` → display label (resolved by the
 * caller); unknown refs fall back to the type name.
 */

const TYPE = "[a-zA-Z][a-zA-Z0-9]*";
const ID = "[a-zA-Z0-9_-]+";

export function mentionTransformer(
  labels: Map<string, string>,
): TextMatchTransformer {
  return {
    dependencies: [MentionNode],
    // Editor state -> markdown: a MentionNode becomes its canonical token.
    export: (node) =>
      $isMentionNode(node)
        ? buildToken(node.getEntityType(), node.getId())
        : null,
    // markdown -> editor state: `<@[type:]id>` becomes a MentionNode, resolving
    // the display label from `labels` (falls back to the type name).
    importRegExp: new RegExp(`<@(?:(${TYPE}):)?(${ID})>`, "i"),
    regExp: new RegExp(`<@(?:(${TYPE}):)?(${ID})>$`, "i"),
    replace: (textNode, match) => {
      const type: EntityType = isEntityType(match[1]) ? match[1] : "user";
      const id = match[2];
      const label =
        labels.get(refKey(type, id)) ??
        (type === "user" ? "user" : ENTITY_LABEL[type]);
      textNode.replace($createMentionNode(type, id, label));
    },
    trigger: ">",
    type: "text-match",
  };
}

/**
 * Build the transformer list for a given label map. Mention transformer goes
 * first so the token is matched before the generic link transformer.
 */
export function notesTransformers(labels: Map<string, string>): Transformer[] {
  return [mentionTransformer(labels), ...TRANSFORMERS];
}
