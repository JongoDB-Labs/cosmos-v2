import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

/**
 * A `@mention` of an org member. Renders as `@DisplayName` (a styled,
 * non-editable token) but its canonical storage form is the `<@uuid>` token the
 * rest of the app already understands (search `searchVector`, RAG embeddings,
 * notification fan-out via `parseMentions`). The markdown round-trip that
 * preserves that token lives in `./markdown.ts` (`mentionTransformer`).
 *
 * Extends TextNode (not DecoratorNode) so it composes with the markdown
 * text-match transformer pipeline and behaves like an atomic word.
 */
export type SerializedMentionNode = Spread<
  { mentionId: string; mentionName: string },
  SerializedTextNode
>;

export class MentionNode extends TextNode {
  __id: string;
  __name: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__id, node.__name, node.__text, node.__key);
  }

  constructor(id: string, name: string, text?: string, key?: NodeKey) {
    super(text ?? `@${name}`, key);
    this.__id = id;
    this.__name = name;
  }

  getId(): string {
    return this.__id;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className =
      "inline-block rounded bg-accent px-1 text-xs font-medium align-baseline";
    dom.setAttribute("data-mention", this.__id);
    return dom;
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    const node = $createMentionNode(
      serialized.mentionId,
      serialized.mentionName,
    );
    node.setTextContent(serialized.text);
    node.setFormat(serialized.format);
    node.setStyle(serialized.style);
    return node;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: "mention",
      version: 1,
      mentionId: this.__id,
      mentionName: this.__name,
    };
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

export function $createMentionNode(id: string, name: string): MentionNode {
  const node = new MentionNode(id, name);
  // `token` mode: the node is selected/deleted as one atomic unit.
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode;
}
