import {
  TRANSFORMERS,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";
import { $createMentionNode, $isMentionNode, MentionNode } from "./mention-node";

/**
 * Markdown round-trip config for the notes editor.
 *
 * The stored content format stays plain markdown (no storage change), so search
 * tokenization, RAG embeddings, and the `<@uuid>` mention fan-out keep working.
 * On top of Lexical's default TRANSFORMERS (headings, **bold**, *italic*,
 * ~~strike~~, `code`, ```fences```, lists, > quotes, [links](url)) we add one
 * text-match transformer that round-trips the app's `<@uuid>` mention token.
 */

const MENTION_UUID = "[0-9a-f-]{36}";

export function mentionTransformer(
  mentionMap: Map<string, string>,
): TextMatchTransformer {
  return {
    dependencies: [MentionNode],
    // Editor state -> markdown: a MentionNode becomes `<@uuid>`.
    export: (node) => ($isMentionNode(node) ? `<@${node.getId()}>` : null),
    // markdown -> editor state: `<@uuid>` becomes a MentionNode, resolving the
    // display name from the org-member map (falls back to "user" if unknown).
    importRegExp: new RegExp(`<@(${MENTION_UUID})>`, "i"),
    regExp: new RegExp(`<@(${MENTION_UUID})>$`, "i"),
    replace: (textNode, match) => {
      const id = match[1];
      const name = mentionMap.get(id.toLowerCase()) ?? "user";
      textNode.replace($createMentionNode(id, name));
    },
    trigger: ">",
    type: "text-match",
  };
}

/**
 * Build the transformer list for a given member map. Mention transformer goes
 * first so `<@uuid>` is matched before the generic link transformer.
 */
export function notesTransformers(
  mentionMap: Map<string, string>,
): Transformer[] {
  return [mentionTransformer(mentionMap), ...TRANSFORMERS];
}
